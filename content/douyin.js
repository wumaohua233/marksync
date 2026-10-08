// 抖音 content script（隔离世界，document_idle）。
// 首选：接收 content/dyHook.js（MAIN world）拦截到的收藏/喜欢接口数据，直接拿到
// 结构化列表（含 aweme_id、desc、封面、收藏时间），无需滚动、无需解析 DOM。
// 回退：接口没截到时（未登录/接口改名等），退回 DOM 首屏抓取，保证不比旧版差。

const msg = (k, ...a) =>
  chrome.i18n.getMessage(k, a.length ? a.map(String) : undefined) || k;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 接口拦截缓存：由 dyHook.js 经 postMessage 送来（仅存内存、不外发）——
const captured = { dy_fav: null, dy_like: null };

window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.__shoucang !== true || !Array.isArray(d.items)) return;
  const slot = d.kind === "dy_like" ? "dy_like" : "dy_fav";
  captured[slot] = d.items.map((it) => ({
    id: it.id,
    title: (it.desc || "").slice(0, 30) || msg("titleDouyinVideo"),
    desc: (it.desc || "").slice(0, 300),
    cover: it.cover || "",
    url: "https://www.douyin.com/video/" + it.id,
    author: it.author || "",
    createTime: it.createTime || 0,
  }));
});

// —— DOM 回退抓取：只取首屏，不滚动 ——
function harvestDom() {
  const map = new Map();
  for (const a of document.querySelectorAll('li a[href*="/video/"]')) {
    const m = (a.getAttribute("href") || "").match(/\/video\/(\d+)/);
    if (!m) continue;
    if (!a.querySelector("p")) continue;
    const id = m[1];
    if (map.has(id)) continue;
    let desc = "";
    for (const p of a.querySelectorAll("p")) {
      const t = (p.textContent || "").trim();
      if (t.length > desc.length) desc = t;
    }
    const img = a.querySelector("img");
    map.set(id, {
      id,
      title: desc.slice(0, 30) || msg("titleDouyinVideo"),
      desc: desc.slice(0, 300),
      cover: img?.src || "",
      url: "https://www.douyin.com/video/" + id,
      author: "",
      createTime: 0,
    });
  }
  return Array.from(map.values());
}

// 首屏采集：先等接口拦截（页面初始化即请求，通常几秒到），拿不到再回退 DOM。
async function collectFirst(source) {
  const slot = source === "dy_like" ? "dy_like" : "dy_fav";
  for (let i = 0; i < 24; i++) {
    if (captured[slot]?.length) return { ok: true, items: captured[slot], via: "api" };
    await sleep(500); // 最多约 12s
  }
  for (let i = 0; i < 8; i++) {
    const items = harvestDom();
    if (items.length) return { ok: true, items, via: "dom" };
    await sleep(500);
  }
  if (captured[slot]?.length) return { ok: true, items: captured[slot], via: "api" };
  return { ok: false, error: msg("errNoContentOrLogin") };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ ok: true });
  } else if (msg.type === "DY_COLLECT_FIRST" || msg.type === "DY_COLLECT_LIST") {
    collectFirst(msg.source || "dy_fav").then(sendResponse, (e) =>
      sendResponse({ ok: false, error: e.message })
    );
    return true; // 异步
  }
});
