// background service worker：调度、采集状态机、diff、badge/通知。

import * as store from "./lib/store.js";
import * as xhsSsr from "./lib/xhsSsr.js";
import * as ytSsr from "./lib/ytSsr.js";
import { t, UI_LANG } from "./lib/i18n.js";

const ALARM_NAME = "shouchang-check";
const NET_RETRY_ALARM = "shouchang-netretry"; // 网络没就绪时的重试闹钟

// 首跑每个源最多放进清单的条数——**兵底值**。
// 实际阈值来自 settings.firstRunLimits[平台]（新手引导里可调，上限 100），
// 这里只在设置缺失时兜底。
//
// 为什么要限制：「存量」是旧账，不是「新来的」。全量灌进去的后果：角标变成几千、
// 通知弹「有 3847 条新收藏」、清单长到没法看——这个工具的卖点是
// 「从安装起不再让新收藏吃灰」，第一次就把历史摊开等于没有重点。
const FIRST_RUN_KEEP = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = false;

// ---------- tab 与消息工具 ----------

function waitTabLoaded(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(t("errTabTimeout")));
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendWithTimeout(tabId, msg, timeoutMs = 90000) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, msg),
    sleep(timeoutMs).then(() => {
      throw new Error(t("errContentTimeout"));
    }),
  ]);
}

// content script 在 document_idle 注入，等它就绪
async function waitContentReady(tabId, retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      if (resp?.ok) return;
    } catch (_) {
      /* 未注入完成，继续等 */
    }
    await sleep(500);
  }
  throw new Error(t("errContentTimeout"));
}

// 渲染抓取必须用真实的后台标签页：页面不可见时（最小化窗口）
// IntersectionObserver 懒加载不触发，无限滚动会失效。后台 tab 不抢焦点。
async function openBackgroundTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  await waitTabLoaded(tab.id);
  await waitContentReady(tab.id);
  return tab.id;
}

async function navigateTab(tabId, url) {
  const loaded = waitTabLoaded(tabId);
  await chrome.tabs.update(tabId, { url });
  await loaded;
  await waitContentReady(tabId);
}

async function closeTabQuietly(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (_) {
    /* tab 可能已被用户关闭 */
  }
}

// 最小化的后台窗口：比后台标签页更无感——不占用当前窗口的标签栏，直接最小化，
// 用户几乎察觉不到。只抓首屏（页面初始化即自动请求，不依赖滚动/可见性），
// 所以不受"最小化时懒加载不触发"的影响。
async function openBackgroundWindow(url) {
  const win = await chrome.windows.create({ url, focused: false, state: "minimized" });
  const tab = win.tabs && win.tabs[0];
  if (!tab) throw new Error(t("errWindowFailed"));
  await waitTabLoaded(tab.id);
  await waitContentReady(tab.id);
  return { windowId: win.id, tabId: tab.id };
}

async function closeWindowQuietly(windowId) {
  try {
    await chrome.windows.remove(windowId);
  } catch (_) {
    /* 窗口可能已被用户关闭 */
  }
}

// ---------- 平台采集 ----------

const XHS_LIST_URL = (uid, tab) =>
  `https://www.xiaohongshu.com/user/profile/${uid}?tab=${tab}&subTab=note`;
const DY_LIST_URL = (showTab) => `https://www.douyin.com/user/self?showTab=${showTab}`;

// 小红书 SSR 直取（无窗口）：返回 {source: items[]}
async function collectXhsSsr(sources) {
  const uid = await xhsSsr.resolveUid();
  const out = {};
  for (const source of sources) {
    out[source] = await xhsSsr.fetchList(uid, source === "xhs_like" ? "liked" : "fav");
  }
  return out;
}

// 渲染全量抓取（后台 tab，首跑导入存量与 SSR 异常时回退用）；返回 {source: items[]}
async function collectXhsRender(sources) {
  const out = {};
  const tabId = await openBackgroundTab("https://www.xiaohongshu.com/");
  try {
    const uidResp = await sendWithTimeout(tabId, { type: "XHS_RESOLVE_UID" }, 10000);
    if (!uidResp?.ok) throw new Error(uidResp?.error || t("errNotLoggedInPlatform", store.platformLabel("xhs")));
    for (const source of sources) {
      const tab = source === "xhs_like" ? "liked" : "fav";
      await navigateTab(tabId, XHS_LIST_URL(uidResp.uid, tab));
      const resp = await sendWithTimeout(tabId, { type: "XHS_COLLECT_LIST" }, 120000);
      if (!resp?.ok) throw new Error(t("statusFail", store.sourceLabel(source), resp?.error || "?"));
      out[source] = resp.items;
    }
  } finally {
    closeTabQuietly(tabId);
  }
  return out;
}

// 无感采集：最小化后台窗口打开对应列表页，页面自己带签名请求首屏，
// content script 从拦截到的接口响应里取结构化数据（约 2~3 秒），随即关窗。
async function collectDouyin(sources) {
  const out = {};
  for (const source of sources) {
    const showTab = source === "dy_like" ? "like" : "favorite_collection";
    const { windowId, tabId } = await openBackgroundWindow(DY_LIST_URL(showTab));
    try {
      const resp = await sendWithTimeout(tabId, { type: "DY_COLLECT_FIRST", source }, 30000);
      if (!resp?.ok) throw new Error(resp?.error || t("errCaptureFailed"));
      if (resp.items.length === 0) throw new Error(t("errNoContent"));
      console.log(
        `[shouchang] ${source} 采集 ${resp.items.length} 条（${resp.via === "api" ? "接口拦截·无感" : "DOM回退"}）`
      );
      out[source] = resp.items;
    } finally {
      closeWindowQuietly(windowId);
    }
  }
  return out;
}

// 注入页面(MAIN world)读取 window.ytInitialData 并提取视频列表。
// 必须自包含：executeScript 会序列化注入此函数，不能引用外部变量。
function ytHarvestInPage() {
  const data = window.ytInitialData;
  if (!data) return [];
  const items = [], seen = new Set();
  const runsText = (o) => o?.runs?.[0]?.text || o?.simpleText || o?.content || "";
  const push = (id, t, a) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    items.push({
      id,
      title: (t || "").trim(),
      cover: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      author: (a || "").trim(),
      url: `https://www.youtube.com/watch?v=${id}`,
    });
  };
  (function walk(o, d) {
    if (d > 45 || !o || typeof o !== "object") return;
    const lv = o.lockupViewModel;
    if (lv && lv.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" && lv.contentId) {
      const m = lv.metadata?.lockupMetadataViewModel;
      const rows = m?.metadata?.contentMetadataViewModel?.metadataRows || [];
      push(lv.contentId, m?.title?.content, rows?.[0]?.metadataParts?.[0]?.text?.content);
      return;
    }
    const pv = o.playlistVideoRenderer || o.gridVideoRenderer || o.videoRenderer;
    if (pv && pv.videoId) {
      push(pv.videoId, runsText(pv.title), runsText(pv.shortBylineText) || runsText(pv.ownerText));
      return;
    }
    for (const k in o) { const v = o[k]; if (v && typeof v === "object") walk(v, d + 1); }
  })(data, 0);
  return items;
}

// 稍后观看这类"更私密"的列表：后台跨域 fetch 带不全 SameSite cookie（登录态不完整→抓空）。
// 解法：开最小化后台窗口，用第一方上下文加载页面（带全 cookie，用户不可见），再注入读取
// window.ytInitialData。首屏 SSR 即含数据、不依赖滚动，所以最小化不影响。
async function collectYtViaWindow(playlistId) {
  const win = await chrome.windows.create({
    url: `https://www.youtube.com/playlist?list=${playlistId}`,
    focused: false,
    state: "minimized",
  });
  const tabId = win.tabs?.[0]?.id;
  if (!tabId) throw new Error(t("errWindowFailed"));
  try {
    await waitTabLoaded(tabId);
    for (let i = 0; i < 20; i++) {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: ytHarvestInPage,
      });
      const items = res?.[0]?.result;
      if (Array.isArray(items) && items.length) return items;
      await sleep(500);
    }
    return [];
  } finally {
    try { await chrome.windows.remove(win.id); } catch (_) {}
  }
}

// YouTube 采集：喜欢的视频(LL)后台 fetch 直取（无窗口）；稍后观看(WL)登录态需第一方，
// 用最小化窗口读取。逐源容错，一个失败不拖累另一个。
async function collectYouTube(sources, results) {
  const out = {};
  for (const source of sources) {
    try {
      if (source === "yt_watch") {
        const items = await collectYtViaWindow("WL");
        if (!items.length) throw new Error(t("errNoContent"));
        out[source] = items;
      } else {
        out[source] = await ytSsr.fetchList("LL");
      }
    } catch (e) {
      results[source] = { ok: false, error: e.message };
    }
  }
  return out;
}

// X(Twitter) 采集：书签走带复杂签名的 GraphQL，不易后台构造；改用最小化后台窗口
// （第一方、带登录 cookie、用户不可见），注入读取书签页 DOM（data-testid 稳定）。
function xHarvestInPage() {
  const map = {};
  for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
    const link = art.querySelector('a[href*="/status/"]');
    const m = ((link && link.getAttribute("href")) || "").match(/\/status\/(\d+)/);
    if (!m) continue;
    const id = m[1];
    if (map[id]) continue;
    const text = ((art.querySelector('div[data-testid="tweetText"]') || {}).textContent || "").trim();
    const userName = ((art.querySelector('div[data-testid="User-Name"]') || {}).textContent || "").trim();
    const author = userName.split("@")[0].trim();
    map[id] = {
      id,
      title: text.slice(0, 40) || (author ? t("titleXUserTweet", author) : t("titleXTweet")),
      desc: text.slice(0, 300),
      cover: "",
      url: "https://x.com/i/web/status/" + id,
      author: author.slice(0, 40),
    };
  }
  return Object.values(map);
}

async function collectXViaWindow(url) {
  const win = await chrome.windows.create({ url, focused: false, state: "minimized" });
  const tabId = win.tabs?.[0]?.id;
  if (!tabId) throw new Error(t("errWindowFailed"));
  try {
    await waitTabLoaded(tabId);
    for (let i = 0; i < 24; i++) {
      const res = await chrome.scripting.executeScript({ target: { tabId }, func: xHarvestInPage });
      const items = res?.[0]?.result;
      if (Array.isArray(items) && items.length) return items;
      await sleep(500);
    }
    return [];
  } finally {
    try { await chrome.windows.remove(win.id); } catch (_) {}
  }
}

// 从 X 页面读当前登录用户名（点赞页 URL 是 /用户名/likes；书签页则固定）。
function xGetUsernameInPage() {
  const sels = ['a[data-testid="AppTabBar_Profile_Link"]', 'a[aria-label="Profile"]'];
  for (const s of sels) {
    const h = document.querySelector(s)?.getAttribute("href");
    if (h) {
      const u = h.replace(/^\//, "").split("/")[0];
      if (/^[A-Za-z0-9_]{1,15}$/.test(u)) return u;
    }
  }
  return null;
}

// 点赞需先拿用户名：同一最小化窗口先开 home 解析用户名，再导航到 /用户名/likes 读 DOM。
async function collectXLikes() {
  const win = await chrome.windows.create({ url: "https://x.com/home", focused: false, state: "minimized" });
  const tabId = win.tabs?.[0]?.id;
  if (!tabId) throw new Error(t("errWindowFailed"));
  try {
    await waitTabLoaded(tabId);
    let username = null;
    for (let i = 0; i < 16; i++) {
      const res = await chrome.scripting.executeScript({ target: { tabId }, func: xGetUsernameInPage });
      username = res?.[0]?.result;
      if (username) break;
      await sleep(500);
    }
    if (!username) throw new Error(t("errMissingUsername"));
    const loaded = waitTabLoaded(tabId);
    await chrome.tabs.update(tabId, { url: `https://x.com/${username}/likes` });
    await loaded;
    for (let i = 0; i < 24; i++) {
      const res = await chrome.scripting.executeScript({ target: { tabId }, func: xHarvestInPage });
      const items = res?.[0]?.result;
      if (Array.isArray(items) && items.length) return items;
      await sleep(500);
    }
    return [];
  } finally {
    try { await chrome.windows.remove(win.id); } catch (_) {}
  }
}

// X 采集：书签(x_bookmark)开固定书签页；点赞(x_like)先解析用户名再开点赞页。逐源容错。
async function collectX(sources, results) {
  const out = {};
  for (const source of sources) {
    try {
      const items =
        source === "x_like"
          ? await collectXLikes()
          : await collectXViaWindow("https://x.com/i/bookmarks");
      if (!items.length) throw new Error(t("errNoContent"));
      out[source] = items;
    } catch (e) {
      results[source] = { ok: false, error: e.message };
    }
  }
  return out;
}

// ---------- TikTok 采集 ----------
// 和抖音同源(字节)，列表接口带签名；用最小化窗口 + 读 DOM。个人页 tab 是点击切换的
// (无独立 URL)：开个人页 → 点击目标 tab(liked/favorites) → 读视频卡片。

function ttGetUsernameInPage() {
  const h = document.querySelector('[data-e2e="nav-profile"]')?.getAttribute("href") || "";
  const m = h.match(/@([^/?#]+)/);
  return m ? m[1] : null;
}

function ttReadVideos() {
  const seen = new Set();
  const items = [];
  for (const a of document.querySelectorAll('a[href*="/video/"]')) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/\/video\/(\d+)/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const img = a.querySelector("img");
    const alt = ((img && img.getAttribute("alt")) || "").trim();
    const desc = alt.replace(/\s*created by .*/i, "").trim();
    const am = href.match(/@([^/]+)/);
    items.push({
      id: m[1],
      title: desc.slice(0, 40) || t("titleTikTokVideo"),
      desc: desc.slice(0, 300),
      cover: (img && img.getAttribute("src")) || "",
      url: href.startsWith("http") ? href : "https://www.tiktok.com" + href,
      author: (am ? am[1] : "").slice(0, 40),
    });
  }
  return items;
}

// 一个最小化窗口：foryou 解析用户名 → 导航个人页 → 点击 tab → 轮询读视频。
async function collectTikTokTab(target) {
  const win = await chrome.windows.create({ url: "https://www.tiktok.com/foryou", focused: false, state: "minimized" });
  const tabId = win.tabs?.[0]?.id;
  if (!tabId) throw new Error(t("errWindowFailed"));
  try {
    await waitTabLoaded(tabId);
    let username = null;
    for (let i = 0; i < 16; i++) {
      const res = await chrome.scripting.executeScript({ target: { tabId }, func: ttGetUsernameInPage });
      username = res?.[0]?.result;
      if (username) break;
      await sleep(500);
    }
    if (!username) throw new Error(t("errMissingUsername"));
    const loaded = waitTabLoaded(tabId);
    await chrome.tabs.update(tabId, { url: `https://www.tiktok.com/@${username}` });
    await loaded;
    // 轮询等 tab 栏渲染出来再点击：最小化窗口/慢网络下 tab 可能晚出现，
    // 死等固定时间会"点空"报错，改成一出现就点、最多等 ~10 秒。
    let clicked = false;
    for (let i = 0; i < 20; i++) {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: (t) => {
          // 点赞 tab 有 data-e2e；收藏(Favorites) tab 没有 data-e2e，只能按文字匹配
          let el = null;
          if (t.e2e) el = document.querySelector('[data-e2e="' + t.e2e + '"]');
          if (!el && t.text) {
            const re = new RegExp("^(" + t.text + ")$", "i");
            el = [...document.querySelectorAll("p,span,button,a,div")].find(
              (e) => e.children.length === 0 && re.test((e.textContent || "").trim())
            );
          }
          if (!el) return false;
          (el.closest('[role="tab"], button, a, [class*="Tab"]') || el).click();
          return true;
        },
        args: [target],
      });
      if (res?.[0]?.result) {
        clicked = true;
        break;
      }
      await sleep(500);
    }
    if (!clicked) throw new Error(t("errXhsTabMissing"));
    for (let i = 0; i < 24; i++) {
      const res = await chrome.scripting.executeScript({ target: { tabId }, func: ttReadVideos });
      const items = res?.[0]?.result;
      if (Array.isArray(items) && items.length) return items;
      await sleep(500);
    }
    return [];
  } finally {
    try { await chrome.windows.remove(win.id); } catch (_) {}
  }
}

// tt_like→点赞(liked-tab)，tt_fav→收藏(favorites-tab)。逐源容错。
async function collectTikTok(sources, results) {
  const out = {};
  for (const source of sources) {
    try {
      const target = source === "tt_fav" ? { text: "Favorites|收藏" } : { e2e: "liked-tab" };
      const items = await collectTikTokTab(target);
      if (!items.length) throw new Error(t("errNoContent"));
      out[source] = items;
    } catch (e) {
      results[source] = { ok: false, error: e.message };
    }
  }
  return out;
}

// ---------- Instagram 采集 ----------
// 收藏(Saved)：进 /用户名/saved/all-posts/ 读 post 网格(a[href*=/p/])。风控最凶，只抓首屏。
// 点赞(Liked)在「你的活动」管理页、post 是无链接的缩略图，DOM 拿不到 id，暂不做。

function igGetUsernameInPage() {
  try {
    const html = document.documentElement.outerHTML;
    const m =
      html.match(/"viewer(?:_id)?"[\s\S]{0,300}?"username":"([^"]+)"/) ||
      html.match(/"username":"([^"]{2,30})"/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

function igReadPosts() {
  const seen = new Set();
  const items = [];
  for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/\/(p|reel)\/([^/]+)/);
    if (!m || seen.has(m[2])) continue;
    seen.add(m[2]);
    const img = a.querySelector("img");
    const alt = ((img && img.getAttribute("alt")) || "").trim();
    const am = alt.match(/Photo by ([^.]+?) on /i);
    const author = am ? am[1].trim() : "";
    const desc = alt.replace(/^Photo by .+? on [^.]+\.\s*/i, "").trim();
    items.push({
      id: m[2],
      title: (desc || alt).slice(0, 40) || t("titleIgPost"),
      desc: alt.slice(0, 300),
      cover: (img && img.getAttribute("src")) || "",
      url: `https://www.instagram.com/${m[1]}/${m[2]}/`,
      author: author.slice(0, 40),
    });
  }
  return items;
}

// 收藏(Saved)：最小化窗口 → 解析用户名 → 导航 saved/all-posts → 读 post 网格。
async function collectIgSaved() {
  let win = null;
  try {
    win = await chrome.windows.create({ url: "https://www.instagram.com/", focused: false, state: "minimized" });
    const tabId = win.tabs?.[0]?.id;
    if (!tabId) throw new Error(t("errWindowFailed"));
    await waitTabLoaded(tabId);
    let username = null;
    for (let i = 0; i < 16; i++) {
      const res = await chrome.scripting.executeScript({ target: { tabId }, func: igGetUsernameInPage });
      username = res?.[0]?.result;
      if (username) break;
      await sleep(500);
    }
    if (!username) throw new Error(t("errMissingUsername"));
    const loaded = waitTabLoaded(tabId);
    await chrome.tabs.update(tabId, { url: `https://www.instagram.com/${username}/saved/all-posts/` });
    await loaded;
    let items = [];
    for (let i = 0; i < 24; i++) {
      const res = await chrome.scripting.executeScript({ target: { tabId }, func: igReadPosts });
      items = res?.[0]?.result || [];
      if (items.length) break;
      await sleep(500);
    }
    return items;
  } finally {
    if (win) try { await chrome.windows.remove(win.id); } catch (_) {}
  }
}

// 点赞(Liked)：网页直接 fetch /api/v1/feed/liked/ 会被 IG 以 "useragent mismatch" 拒
// （该接口只认手机端 UA，浏览器改不了 UA）。用 declarativeNetRequest 临时把这个请求的
// User-Agent 改成 IG 安卓端，再在最小化窗口的页面里同源调用（避开跨域），配合登录 cookie。
// 接口 = 开源库 instagrapi/instagram-private-api 里 liked_medias/feed_liked 的同一个。
async function collectIgLikes() {
  const RULE_ID = 8931;
  const MOBILE_UA =
    "Instagram 309.1.0.41.113 Android (30/11; 420dpi; 1080x2340; samsung; SM-G991B; o1s; exynos2100; en_US; 541416183)";
  const APP_ID = "567067343352427"; // IG 安卓 app id，与移动 UA 匹配
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "user-agent", operation: "set", value: MOBILE_UA }],
        },
        condition: { urlFilter: "instagram.com/api/v1/feed/liked", resourceTypes: ["xmlhttprequest"] },
      },
    ],
  });
  let win = null;
  try {
    win = await chrome.windows.create({ url: "https://www.instagram.com/", focused: false, state: "minimized" });
    const tabId = win.tabs?.[0]?.id;
    if (!tabId) throw new Error(t("errWindowFailed"));
    await waitTabLoaded(tabId);
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (appId) => {
        const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
        try {
          const r = await fetch("https://www.instagram.com/api/v1/feed/liked/?count=30", {
            headers: { "x-ig-app-id": appId, "x-csrftoken": csrf, "x-requested-with": "XMLHttpRequest" },
            credentials: "include",
          });
          return { status: r.status, body: (await r.text()).slice(0, 400000) };
        } catch (e) {
          return { status: 0, body: String(e) };
        }
      },
      args: [APP_ID],
    });
    const out = res?.[0]?.result;
    if (!out || out.status !== 200) {
      throw new Error(
        t("errIgBlocked", String(out?.status || "?")) +
          " " + (out?.body || "").replace(/\s+/g, " ").slice(0, 70)
      );
    }
    const data = JSON.parse(out.body);
    const list = Array.isArray(data.items) ? data.items : [];
    return list
      .map((it) => {
        const m = it.media || it;
        const cap = (m.caption && m.caption.text) || "";
        const cand = m.image_versions2 && m.image_versions2.candidates;
        return {
          id: String(m.pk || m.id || m.code || ""),
          title: cap.slice(0, 40) || t("titleIgPost"),
          desc: cap.slice(0, 300),
          cover: (cand && cand[0] && cand[0].url) || "",
          url: m.code ? `https://www.instagram.com/p/${m.code}/` : "https://www.instagram.com/",
          author: (m.user && m.user.username) || "",
        };
      })
      .filter((x) => x.id);
  } finally {
    if (win) try { await chrome.windows.remove(win.id); } catch (_) {}
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] });
  }
}

// 逐源容错：收藏走窗口读 DOM，点赞走改 UA 调接口。
async function collectInstagram(sources, results) {
  const out = {};
  for (const source of sources) {
    try {
      const items = source === "ig_like" ? await collectIgLikes() : await collectIgSaved();
      if (!items.length) throw new Error(t("errNoContent"));
      out[source] = items;
    } catch (e) {
      results[source] = { ok: false, error: e.message };
    }
  }
  return out;
}

// ---------- 登录态检测 ----------

// 用平台的会话 cookie 判断登录态。这些是 httpOnly cookie，只有 background 的
// chrome.cookies 能读（popup 里 document.cookie 读不到）；cookie 名长期稳定：
// 小红书 web_session、抖音 sessionid / sessionid_ss。
async function getCookieValue(url, name) {
  try {
    const c = await chrome.cookies.get({ url, name });
    return c?.value || "";
  } catch (_) {
    return "";
  }
}

// 仅检测「已启用」的平台。返回 { xhs?: boolean, douyin?: boolean }，
// 缺省某平台表示它未启用、无需提示登录。
async function checkLogins(all = false) {
  const settings = await store.getSettings();
  const on = Object.keys(settings.sources).filter((s) => settings.sources[s]);
  // all=true 时无视启用状态全查——新手引导要让用户看到全部 6 个平台的登录状态，
  // 而弹窗只关心「已启用但没登录」的，多查反而会弹没必要的登录提示。
  const want = (prefix) => all || on.some((s) => s.startsWith(prefix));
  const out = {};
  if (want("xhs")) {
    out.xhs = !!(await getCookieValue("https://www.xiaohongshu.com", "web_session"));
  }
  if (want("dy")) {
    const [a, b] = await Promise.all([
      getCookieValue("https://www.douyin.com", "sessionid_ss"),
      getCookieValue("https://www.douyin.com", "sessionid"),
    ]);
    out.douyin = !!(a || b);
  }
  if (want("yt")) {
    out.youtube = !!(await getCookieValue("https://www.youtube.com", "LOGIN_INFO"));
  }
  if (want("x_")) {
    out.x = !!(await getCookieValue("https://x.com", "auth_token"));
  }
  if (want("tt_")) {
    out.tiktok = !!(await getCookieValue("https://www.tiktok.com", "sessionid"));
  }
  if (want("ig_")) {
    out.instagram = !!(await getCookieValue("https://www.instagram.com", "sessionid"));
  }
  return out;
}

// ---------- badge 与通知 ----------

async function refreshBadge() {
  const n = await store.unreadCount();
  await chrome.action.setBadgeBackgroundColor({ color: "#FF2442" });
  await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
  await chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" });
}

function notifyNew(count, firstTitles) {
  const SEP = /^(zh|ja)/i.test(UI_LANG) ? "、" : ", ";
  const preview = firstTitles.slice(0, 2).join(SEP);
  // 「等」在 JS 里拼好，再整体作为单个 $1 传入——两个 $n 相邻（$1$2）会被 Chrome
  // 当成名为 "1" 的具名占位符，导致整个扩展加载失败。详见 scripts/check_i18n.py。
  const summary = preview + (count > 2 ? t("notifMore") : "");
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/128.png",
    title: t("notifTitle", String(count)),
    message: summary ? t("notifBody", summary) : t("notifFallback"),
    priority: 1,
  });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  chrome.notifications.clear(notificationId);
  try {
    await chrome.action.openPopup();
  } catch (_) {
    // openPopup 不可用时用户可自行点击图标
  }
});

// ---------- 主流程 ----------

// 网络预检：HEAD 一个国内稳定端点，带 5 秒超时；不通返回 false。
async function isNetworkReady() {
  if (navigator.onLine === false) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    await fetch("https://www.baidu.com/favicon.ico", {
      method: "HEAD",
      mode: "no-cors",
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return true;
  } catch (_) {
    return false;
  }
}

async function runCheck(trigger, onlyPlatform) {
  if (running) return { skipped: true };
  // 同步前先探网络：没就绪就不硬跑，安排 3 分钟后自动重试（治电脑刚唤醒 / 网络刚恢复）
  if (!(await isNetworkReady())) {
    await chrome.alarms.create(NET_RETRY_ALARM, { delayInMinutes: 3 });
    const prev = await store.getNetPending();
    await store.setNetPending(prev || Date.now()); // 保留首次开始等待的时间
    return { networkPending: true };
  }
  await chrome.alarms.clear(NET_RETRY_ALARM);
  await store.setNetPending(0);
  running = true;
  const startedAt = Date.now();
  const results = {};
  const allNew = [];
  try {
    const settings = await store.getSettings();
    let enabled = Object.keys(settings.sources).filter((s) => settings.sources[s]);
    // 单平台同步：只保留该平台的源（下拉箭头里选某个平台时用）
    if (onlyPlatform) enabled = enabled.filter((s) => store.SOURCES[s]?.platform === onlyPlatform);

    // 1. 按平台采集
    const collected = {};
    const xhsSources = enabled.filter((s) => s.startsWith("xhs"));
    const dySources = enabled.filter((s) => s.startsWith("dy"));
    if (xhsSources.length) {
      try {
        if (settings.firstRunDone) {
          // 日常增量：SSR 直取首屏（无窗口）
          const ssr = await collectXhsSsr(xhsSources);
          // 首屏全是新 id 且满一屏：新增可能超过首屏导致中间漏条，回退渲染全量
          const needRender = [];
          for (const s of xhsSources) {
            const items = ssr[s] || [];
            const seen = await store.getSeen(s);
            const allFresh = items.length > 0 && items.every((it) => !seen[it.id]);
            if (allFresh && items.length >= 10) needRender.push(s);
            else collected[s] = items;
          }
          if (needRender.length) {
            console.warn("[shouchang] 新增超过首屏，回退渲染抓取:", needRender.join(","));
            Object.assign(collected, await collectXhsRender(needRender));
          }
        } else {
          // 首跑：渲染全量导入存量
          Object.assign(collected, await collectXhsRender(xhsSources));
        }
      } catch (e) {
        for (const s of xhsSources) results[s] = { ok: false, error: e.message };
      }
    }
    if (dySources.length) {
      try {
        Object.assign(collected, await collectDouyin(dySources));
      } catch (e) {
        for (const s of dySources) {
          if (!collected[s]) results[s] = { ok: false, error: e.message };
        }
      }
    }
    const ytSources = enabled.filter((s) => s.startsWith("yt"));
    if (ytSources.length) {
      // SSR 直取，无窗口；collectYouTube 内部已逐源容错
      Object.assign(collected, await collectYouTube(ytSources, results));
    }
    const xSources = enabled.filter((s) => s.startsWith("x_"));
    if (xSources.length) {
      // 最小化窗口读 DOM；collectX 内部已逐源容错
      Object.assign(collected, await collectX(xSources, results));
    }
    const ttSources = enabled.filter((s) => s.startsWith("tt_"));
    if (ttSources.length) {
      // 最小化窗口点 tab 读 DOM；collectTikTok 内部已逐源容错
      Object.assign(collected, await collectTikTok(ttSources, results));
    }
    const igSources = enabled.filter((s) => s.startsWith("ig_"));
    if (igSources.length) {
      // 最小化窗口读 Saved 网格；collectInstagram 内部已逐源容错
      Object.assign(collected, await collectInstagram(igSources, results));
    }

    // 2. diff 与入库
    const isFirstRun = !settings.firstRunDone;
    for (const [source, items] of Object.entries(collected)) {
      const seen = await store.getSeen(source);
      const fresh = items.filter((it) => !seen[it.id]);
      // 采集到的 id 全部记入 seen（含首跑没入库的那部分），
      // 否则旧条目会在后续某次同步里冒出来当「新增」。
      await store.addSeen(
        source,
        items.map((it) => it.id)
      );
      // 首跑：只入最近 N 条（N = 该平台的 firstRunLimits，引导里可调，0 = 不拉历史），
      // 且标成**已读** —— 角标从 0 开始，不弹通知。
      // 之后：只入真正新增的，标 new，参与角标与通知。
      const platform = store.SOURCES[source].platform;
      const keep = settings.firstRunLimits?.[platform] ?? FIRST_RUN_KEEP;
      const toStore = isFirstRun ? items.slice(0, keep) : fresh;
      const now = Date.now();
      const entries = toStore.map((it, idx) => ({
        ...it,
        key: `${source}:${it.id}`,
        source,
        platform,
        status: isFirstRun ? "read" : "new",
        firstSeenAt: now,
        seq: idx, // 抓取列表中的位次（0 = 最新收藏），保留平台的倒序
      }));
      if (entries.length) await store.upsertItems(entries);
      if (!isFirstRun) allNew.push(...entries); // 首跑不进 allNew ⇒ 不弹通知、不进角标
      results[source] = { ok: true, total: items.length, new: fresh.length };
    }

    // 3. 收尾
    await refreshBadge();
    if (allNew.length > 0) {
      notifyNew(
        allNew.length,
        allNew.map((it) => it.title).filter(Boolean)
      );
    }
    settings.firstRunDone = true;
    await store.saveSettings(settings);
    // 单平台同步：合并上次记录，保留其他平台的旧结果（状态栏不至于只剩一个平台）
    const finalResults = onlyPlatform
      ? { ...((await store.getLastRun())?.results || {}), ...results }
      : results;
    await store.setLastRun({
      at: startedAt,
      trigger,
      durationMs: Date.now() - startedAt,
      results: finalResults,
      newCount: allNew.length,
      // 让弹窗能说一句「首次同步发生了什么」——不然用户看到一批灰色条目会困惑
      firstRun: isFirstRun,
    });
    // 记录本次涉及平台的同步时间（下拉菜单"上次同步"显示用）
    const syncedPlatforms = new Set(enabled.map((s) => store.SOURCES[s]?.platform).filter(Boolean));
    if (syncedPlatforms.size) {
      const ps = await store.getPlatformSync();
      for (const p of syncedPlatforms) ps[p] = startedAt;
      await store.setPlatformSync(ps);
    }
    return { ok: true, newCount: allNew.length };
  } finally {
    running = false;
  }
}

// ---------- 触发器 ----------

async function resetAlarm() {
  const settings = await store.getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: Math.max(0.5, settings.intervalMinutes || 180),
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await resetAlarm();
  await refreshBadge();
  // 全新安装：标记「还没看过引导」并直接开一个标签页。
  // 升级不触发——老用户不该被重复引导。
  if (details.reason === "install") {
    const s = await store.getSettings();
    s.onboarded = false;
    await store.saveSettings(s);
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
  }
});

chrome.runtime.onStartup.addListener(() => {
  // 浏览器启动后稍等，让网络与登录态就绪
  setTimeout(() => runCheck("startup"), 10000);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runCheck("alarm");
  else if (alarm.name === NET_RETRY_ALARM) runCheck("netretry"); // 3 分钟到，再探一次网络
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "RUN_CHECK_NOW") {
    runCheck("manual", msg.platform).then(sendResponse);
    return true;
  }
  if (msg.type === "CHECK_ALL_LOGINS") {
    checkLogins(true).then(sendResponse);
    return true;
  }
  if (msg.type === "OPEN_ONBOARDING") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "GET_STATUS") {
    Promise.all([
      store.getLastRun(),
      store.unreadCount(),
      checkLogins(),
      store.getPlatformSync(),
      store.getNetPending(),
      chrome.alarms.get(ALARM_NAME),
    ]).then(([lastRun, unread, loginStatus, platformSync, netPending, alarm]) =>
      sendResponse({
        running,
        lastRun,
        unread,
        loginStatus,
        platformSync,
        netPending,
        nextRun: alarm?.scheduledTime || null,
      })
    );
    return true;
  }
  if (msg.type === "RESET_ALARM") {
    resetAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "CLEAR_ALL") {
    (async () => {
      const settings = await store.getSettings();
      await chrome.storage.local.clear();
      settings.firstRunDone = false; // 重置为首跑，下次检测重新全量导入
      await store.saveSettings(settings);
      await refreshBadge();
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === "MARK_ALL_READ") {
    store.markAllRead().then(refreshBadge).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "MARK_READ") {
    store.updateItem(msg.key, { status: "read" }).then(refreshBadge).then(() => sendResponse({ ok: true }));
    return true;
  }
});
