// popup：MarkSync 清单展示与操作。

import * as store from "../lib/store.js";
import { t, applyI18n, fmtSmart, fmtDate, fmtTime, fmtDateTime } from "../lib/i18n.js";
import { checkUpdate, dismissUpdate, updateUrl } from "../lib/update.js";

applyI18n(); // 先把 HTML 上 data-i18n 的静态文案翻掉

const $ = (id) => document.getElementById(id);

const WEEK_MS = 7 * 24 * 3600 * 1000;
// 只存 key，文案渲染时现取。TABS 先前的 {key,label} 结构把中文写死在模块顶层，
// 换语言时拿到的还是旧值。
const TAB_KEYS = [
  "recent",
  "x_bookmark", "x_like",
  "tt_like", "tt_fav",
  "ig_fav", "ig_like",
  "yt_like", "yt_watch",
  "dy_like", "dy_fav",
  "xhs_like", "xhs_fav",
];
let activeTab = "recent";
let settings = null;   // 在 init 里加载，标签栏和平台菜单都要按它过滤

// 只展示用户真正启用的数据源。
// 设置里关掉的平台，在弹窗里留个标签页只会挤占横向空间，点进去还是空的。
function visibleTabs() {
  return TAB_KEYS.filter((k) => k === "recent" || settings?.sources?.[k]);
}

function filterByTab(arr) {
  if (activeTab === "recent") {
    const cutoff = Date.now() - WEEK_MS;
    return arr.filter((it) => it.firstSeenAt >= cutoff);
  }
  return arr.filter((it) => it.source === activeTab);
}

function renderTabs(items) {
  // 数字 = 未读数；无未读不显示
  const counts = { recent: 0 };
  const cutoff = Date.now() - WEEK_MS;
  for (const it of Object.values(items)) {
    if (it.status !== "new") continue;
    if (it.firstSeenAt >= cutoff) counts.recent++;
    counts[it.source] = (counts[it.source] || 0) + 1;
  }
  $("tabs").innerHTML = visibleTabs().map((key) => {
    const n = counts[key] || 0;
    const label = key === "recent" ? t("tabRecent") : store.sourceLabel(key);
    return (
      `<button class="tab ${key === activeTab ? "active" : ""}" data-tab="${key}">` +
      `${escapeHtml(label)}${n > 0 ? `<span class="cnt">${n}</span>` : ""}</button>`
    );
  }).join("");
  if (!visibleTabs().includes(activeTab)) activeTab = "recent";
  $("tabs").querySelectorAll(".tab").forEach((el) => {
    el.addEventListener("click", () => {
      activeTab = el.dataset.tab;
      refresh();
    });
  });
}

// 时间要塞进文案中间且带样式，整体转义会连标签一起转掉。
// 用控制字符做哨兵：先按普通文案转义，再把哨兵换成 HTML 片段。
const MARK = "\u0001";
function tTime(key, ts) {
  return escapeHtml(t(key, MARK)).replace(MARK, fmtTimeHtml(ts));
}

function renderStatus(status) {
  const el = $("status");
  if (status.netPending) {
    el.innerHTML = `<span class="err">${escapeHtml(t("statusNoNetwork"))}</span>${escapeHtml(t("statusNoNetworkHint"))}`;
    return;
  }
  if (!status.lastRun) {
    el.textContent = t("statusNeverRun");
    return;
  }
  const r = status.lastRun;
  const errs = [];
  for (const [source, res] of Object.entries(r.results || {})) {
    if (res.ok) continue;
    const label = store.sourceLabel(source);
    const loginUrl = LOGIN_URLS[source];
    const btn = loginUrl
      ? ` <button class="login-inline" data-url="${loginUrl}">${escapeHtml(t("btnGoLogin"))}</button>`
      : "";
    errs.push(`<span class="err">${escapeHtml(t("statusFail", label, res.error))}</span>${btn}`);
  }
  const nextStr = status.nextRun ? escapeHtml(t("statusNextRun", fmtSmart(status.nextRun))) : "";
  const errStr = errs.length ? ` · ${errs.join(" · ")}` : "";
  const okStr = errs.length ? "" : escapeHtml(t("statusAllOk"));
  el.innerHTML = escapeHtml(t("statusLastCheck", fmtSmart(r.at))) + nextStr + (errStr || okStr);

  el.querySelectorAll(".login-inline").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: btn.dataset.url });
    });
  });
}

const LOGIN_TARGETS = {
  xhs: { url: "https://www.xiaohongshu.com" },
  douyin: { url: "https://www.douyin.com" },
  youtube: { url: "https://www.youtube.com" },
  x: { url: "https://x.com" },
  tiktok: { url: "https://www.tiktok.com" },
  instagram: { url: "https://www.instagram.com" },
};

// 检测失败且错误指向登录/未抓取时，状态栏里直接给出「去登录」按钮。
const LOGIN_URLS = {
  xhs_like: "https://www.xiaohongshu.com",
  xhs_fav: "https://www.xiaohongshu.com",
  dy_like: "https://www.douyin.com",
  dy_fav: "https://www.douyin.com",
  tt_like: "https://www.tiktok.com/login",
  tt_fav: "https://www.tiktok.com/login",
  yt_like: "https://accounts.google.com/ServiceLogin?service=youtube",
  yt_watch: "https://accounts.google.com/ServiceLogin?service=youtube",
  x_like: "https://x.com/i/flow/login",
  x_bookmark: "https://x.com/i/flow/login",
  ig_like: "https://www.instagram.com/accounts/login/",
  ig_fav: "https://www.instagram.com/accounts/login/",
};

async function refreshStatus(status) {
  renderStatus(status);
  renderLoginBar(status.loginStatus);
  updateSyncTimes(status.platformSync);
  $("running-tip").style.display = status.running ? "block" : "none";
  $("btn-run").disabled = status.running;
}

// loginStatus: { xhs?: boolean, douyin?: boolean }，某平台为 false 时提示登录。
// 缺省（未启用该平台）或 true（已登录）都不提示。
function renderLoginBar(loginStatus) {
  const bar = $("login-bar");
  const need = Object.keys(LOGIN_TARGETS).filter((k) => loginStatus && loginStatus[k] === false);
  if (!need.length) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }
  bar.style.display = "flex";
  bar.innerHTML =
    `<span class="tip">${escapeHtml(t("loginBarTip"))}</span>` +
    need
      .map(
        (k) =>
          `<button class="login-btn" data-platform="${k}" data-url="${LOGIN_TARGETS[k].url}">${escapeHtml(
            t("btnLoginWith", store.platformLabel(k))
          )}</button>`
      )
      .join("");
  bar.querySelectorAll(".login-btn").forEach((btn) => {
    btn.addEventListener("click", () => chrome.tabs.create({ url: btn.dataset.url }));
  });
}

function render(items, unread, nextRun) {
  const list = $("list");
  const badge = $("unread");
  badge.style.display = unread > 0 ? "" : "none";
  badge.textContent = unread;
  renderTabs(items);

  const arr = filterByTab(Object.values(items)).sort((a, b) => {
    // 严格收藏顺序：检测批次倒序；同批内按抓取位次升序（0 = 最新收藏）。
    // 已读条目置灰但位置不动，最新的永远在最前。
    return b.firstSeenAt - a.firstSeenAt || (a.seq ?? 0) - (b.seq ?? 0);
  });
  if (!arr.length) {
    list.innerHTML = `<div class="empty">${escapeHtml(t("emptyList"))}</div>`;
    return;
  }

  const nextSuffix = nextRun
    ? ` <span class="gl-time">· ${tTime("nextSyncAt", nextRun)}</span>`
    : "";
  let html = "";
  // 单独平台 tab：顶部显示该平台各自的上次同步时间
  if (activeTab !== "recent" && nextRun) {
    html += `<div class="group-label"><span class="gl-time">${tTime("nextSyncAt", nextRun)}</span></div>`;
  }
  let lastSource = null;
  for (const it of arr.slice(0, 100)) {
    if (activeTab === "recent" && it.source !== lastSource) {
      html += `<div class="group-label">${escapeHtml(store.sourceLabel(it.source))}${nextSuffix}</div>`;
      lastSource = it.source;
    }
    const metaHtml = it.author ? `<div class="meta">${escapeHtml(it.author)}</div>` : "";
    html += `
      <div class="item ${it.status === "new" ? "" : "read"}" data-key="${it.key}" data-url="${escapeHtml(it.url)}">
        ${it.cover ? `<img src="${escapeHtml(it.cover)}">` : ""}
        <div class="body">
          <div class="t">${it.status === "new" ? '<span class="dot"></span>' : ""}${escapeHtml(it.title || t("itemUntitled"))}</div>
          ${metaHtml}
        </div>
        ${it.status === "new" ? `<button class="mark-read" data-key="${it.key}">${escapeHtml(t("btnMarkRead"))}</button>` : ""}
      </div>`;
  }
  list.innerHTML = html;

  // MV3 CSP 禁止内联事件，封面加载成功再显式淡入，失败则彻底隐藏，避免灰色占位闪烁
  // 缓存图片 complete 时 load 事件已错过，直接按 naturalWidth 判断是否有效
  list.querySelectorAll("img").forEach((img) => {
    if (img.complete) {
      if (img.naturalWidth > 0) img.classList.add("loaded");
      else img.style.display = "none";
    } else {
      img.addEventListener("load", () => { img.classList.add("loaded"); });
      img.addEventListener("error", () => { img.style.display = "none"; });
    }
  });

  // 单条已读：不打开原文
  list.querySelectorAll(".mark-read").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await chrome.runtime.sendMessage({ type: "MARK_READ", key: btn.dataset.key });
      refresh();
    });
  });

  list.querySelectorAll(".item").forEach((el) => {
    el.addEventListener("click", async () => {
      const url = el.dataset.url;
      const key = el.dataset.key;
      if (url) chrome.tabs.create({ url });
      await chrome.runtime.sendMessage({ type: "MARK_READ", key });
      refresh();
    });
  });
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  const items = await store.getItems();
  renderStatus(status);
  renderLoginBar(status.loginStatus);
  updateSyncTimes(status.platformSync);
  render(items, status.unread, status.nextRun);
  $("running-tip").style.display = status.running ? "block" : "none";
  $("btn-run").disabled = status.running;
  return status.running;
}

// platform 为空 = 全量同步；传平台名 = 只同步该平台
async function startSync(platform) {
  $("sync-menu").hidden = true;
  $("btn-run").disabled = true;
  $("running-tip").style.display = "block";
  await chrome.runtime.sendMessage({ type: "RUN_CHECK_NOW", platform });
  refresh();
}

// 主按钮：全量同步
$("btn-run").addEventListener("click", () => startSync());

// 下拉箭头里按平台去重生成「同步 X」选项，点了只同步那个平台
function renderSyncMenu() {
  const menu = $("sync-menu");
  // 没启用的平台点了也同步不出东西，别列出来让人白点
  const on = store.platforms().filter((p) => store.sourcesOf(p).some((x) => settings?.sources?.[x]));
  menu.innerHTML = on
    .map(
      (p) =>
        `<button data-platform="${p}"><span class="p-name">${escapeHtml(
          t("syncPlatform", store.platformLabel(p))
        )}</span><span class="p-time" data-time-for="${p}"></span></button>`
    )
    .join("");
  menu.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      startSync(b.dataset.platform);
    });
  });
}
// 菜单里每个平台的“上次同步”小时间。日期和时间分色，Intl 已按语言给出正确写法，
// 这里只负责上色（中/日 → 7月12日，英 → Jul 12）。
function fmtTimeHtml(ts) {
  return `<span class="t-date">${escapeHtml(fmtDate(ts))}</span> <span class="t-time">${escapeHtml(fmtTime(ts))}</span>`;
}

function updateSyncTimes(platformSync) {
  document.querySelectorAll("[data-time-for]").forEach((el) => {
    const ts = platformSync && platformSync[el.dataset.timeFor];
    if (!ts) {
      el.textContent = t("neverSynced");
      return;
    }
    el.innerHTML = escapeHtml(t("lastSyncAt", MARK)).replace(MARK, fmtTimeHtml(ts));
  });
}

$("btn-run-more").addEventListener("click", (e) => {
  e.stopPropagation();
  const m = $("sync-menu");
  m.hidden = !m.hidden;
});
document.addEventListener("click", () => {
  $("sync-menu").hidden = true;
});

$("btn-read-all").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "MARK_ALL_READ" });
  refresh();
});

$("btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 导出全部清单为 CSV（带 BOM，Excel 能正确显示中文）
async function exportCsv() {
  const items = await store.getItems();
  const arr = Object.values(items).sort(
    (a, b) => b.firstSeenAt - a.firstSeenAt || (a.seq ?? 0) - (b.seq ?? 0)
  );
  if (!arr.length) {
    alert(t("alertEmptyExport"));
    return;
  }
  const rows = [[
    t("csvColSource"), t("csvColTitle"), t("csvColAuthor"), t("csvColLink"),
    t("csvColStatus"), t("csvColDiscovered"), t("csvColDesc"),
  ]];
  for (const it of arr) {
    rows.push([
      store.sourceLabel(it.source),
      it.title || "",
      it.author || "",
      it.url || "",
      it.status === "new" ? t("csvStatusNew") : t("csvStatusRead"),
      fmtSmart(it.firstSeenAt),
      it.desc || "",
    ]);
  }
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([String.fromCharCode(0xfeff) + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = t("csvFilename", stamp);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

$("btn-export").addEventListener("click", exportCsv);

// 新版本提示。拉不到（离线 / GitHub 限流）就静静地不显示，不打扰用户。
async function renderUpdateBar() {
  let info;
  try {
    info = await checkUpdate(true); // 每次开弹窗都回源，别拿缓存糊弄用户
  } catch (_) {
    return;
  }
  const bar = $("update-bar");
  if (!info?.hasUpdate) {
    bar.hidden = true;
    return;
  }
  $("update-text").textContent = t("updateAvailable", "v" + info.latest, "v" + info.current);
  $("update-go").textContent = t("updateNow");
  $("update-dismiss").title = t("updateDismiss");
  bar.hidden = false;
  $("update-go").onclick = () => chrome.tabs.create({ url: updateUrl(info) });
  $("update-dismiss").onclick = async () => {
    await dismissUpdate(info.latest);
    bar.hidden = true;
  };
}

let wasRunning = false;

// 还没走过新手引导 → 直接开引导页，弹窗自己关掉。
// 引导必须在新标签页里跑（用户要去别的标签页登录平台，弹窗会被点关），
// 所以这里只负责跳转。
(async () => {
  settings = await store.getSettings();
  if (!settings.onboarded) {
    await chrome.runtime.sendMessage({ type: "OPEN_ONBOARDING" });
    window.close();
    return;
  }
  renderSyncMenu();   // 依赖 settings，所以放在这里而不是模块顶层
  renderUpdateBar();
  refresh().then((running) => { wasRunning = running; });
})();

// 轮询：同步中刷新列表显示进度；同步完成后只刷状态栏，避免反复重绘列表导致图片闪烁
const poll = setInterval(async () => {
  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (status.running || (wasRunning && !status.running)) {
    // 同步中或刚结束：刷新完整列表
    await refresh();
  } else {
    // 空闲时：只更新状态栏，不动列表（不重新加载图片）
    refreshStatus(status);
  }
  wasRunning = status.running;
  if (!status.running && document.hidden) clearInterval(poll);
}, 3000);
