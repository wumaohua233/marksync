// 版本检查：读自己站点上的 /version.json，和本机 manifest.version 比。
//
// 为什么读自己的站点而不是 GitHub API：
//   1. 发版时 GitHub Action 已经把 version.json 发到站点了，端点天然存在
//   2. 用户的浏览器不需要连 GitHub —— 直连不通的网络下也能收到更新提示
//   3. manifest 里少一条第三方 host 权限，只剩 6 个平台 + 本项目自己的域名
//
// 为什么放在根目录而不是 /dl/ 下：Cloudflare Pages 的 _headers 对重叠规则是
// 拼接而非覆盖，/dl/* 的 long-cache 会把 version.json 一起带上，导致永远读到旧版本。
// 详见 docs/_headers 里的注释。
//
// 为什么只做「提示」不做「自动更新」：开发者模式加载的扩展没有 update_url 机制，
// Chrome 也不允许非商店扩展自更新（Windows/macOS 从 Chrome 33/44 起直接封掉了）。
// 所以这里只负责告诉用户「有新版本」。好在 Chrome 会监视已解压目录的文件变化并自动重载，
// 用户把新 zip 覆盖进原文件夹后就生效，不用回 chrome://extensions。

const SITE = "https://getmarksync.pages.dev";
const VERSION_URL = `${SITE}/version.json`;

const CACHE_KEY = "updateCheck";
const DISMISS_KEY = "dismissedVersion";
const CHECK_INTERVAL_MS = 6 * 3600 * 1000; // 6 小时内不重复请求

// 语义化版本比较：x.y.z 拆成数字逐位比。-1 / 0 / 1
function cmpVersion(a, b) {
  const parse = (v) => String(v || "").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

async function readCache() {
  const o = await chrome.storage.local.get([CACHE_KEY, DISMISS_KEY]);
  return {
    cache: o[CACHE_KEY] || { at: 0, latest: null, url: null },
    dismissed: o[DISMISS_KEY] || null,
  };
}

function summarize(local, cache, dismissed) {
  const hasUpdate =
    !!cache.latest &&
    cmpVersion(cache.latest, local) > 0 &&
    cmpVersion(cache.latest, dismissed || "0") > 0; // 用户忽略过的版本不再提醒
  return {
    current: local,
    latest: cache.latest,
    url: cache.url,
    hasUpdate,
    checkedAt: cache.at,
  };
}

// force=true 时无视本地缓存。
// 站点挂了 / 离线 / payload 格式不对 → 静默降级到上次缓存，不抛错、不打扰用户。
export async function checkUpdate(force = false) {
  const local = chrome.runtime.getManifest().version;
  const { cache, dismissed } = await readCache();

  if (!force && Date.now() - cache.at < CHECK_INTERVAL_MS) {
    return summarize(local, cache, dismissed);
  }

  try {
    const r = await fetch(VERSION_URL, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const latest = String(j.version || "").replace(/^v/i, "");
    if (!latest) throw new Error("malformed version.json");
    const next = {
      at: Date.now(),
      latest,
      // 指到网站首页而不是 zip 直链：首页有下载按钮，也有「装了旧版怎么更新」的说明
      url: `${SITE}/`,
    };
    await chrome.storage.local.set({ [CACHE_KEY]: next });
    return summarize(local, next, dismissed);
  } catch (_) {
    return summarize(local, cache, dismissed);
  }
}

// 用户点「忽略此版本」：记下来，之后同一版本不再弹
export async function dismissUpdate(version) {
  await chrome.storage.local.set({ [DISMISS_KEY]: version || "0" });
}

export const updateUrl = (info) => info?.url || `${SITE}/`;
