// 版本检查：拉 GitHub Releases 的 latest，和本机 manifest.version 比。
//
// 为什么只做「提示」不做「自动更新」：开发者模式加载的扩展没有 update_url 机制，
// Chrome 也不允许非商店扩展自更新（Windows/macOS 从 Chrome 33/44 起直接封掉了）。
// 所以这里只负责告诉用户「有新版本」，下载和覆盖由用户手动完成。
// 好在 Chrome 会监视已解压目录的文件变化并自动重载，用户覆盖完即生效。

import { t } from "./i18n.js";

const REPO = "wumaohua233/marksync";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = "updateCheck";
const DISMISS_KEY = "dismissedVersion";
const CHECK_INTERVAL_MS = 12 * 3600 * 1000; // 12 小时内不重复请求，避免触发 GitHub 未认证限流

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

// force=true 时无视缓存（popup 里手动点「检查更新」用）
// 网络失败或 GitHub 限流时静默降级到旧缓存，不抛错打扰用户
export async function checkUpdate(force = false) {
  const local = chrome.runtime.getManifest().version;
  const { cache, dismissed } = await readCache();

  if (!force && Date.now() - cache.at < CHECK_INTERVAL_MS) {
    return summarize(local, cache, dismissed);
  }

  try {
    const r = await fetch(API, { headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const next = {
      at: Date.now(),
      latest: String(j.tag_name || "").replace(/^v/i, ""),
      // 给 release 页而不是 zip 直链：用户可以先看 changelog 再决定
      url: j.html_url || `https://github.com/${REPO}/releases`,
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

export const updateUrl = (info) => info?.url || `https://github.com/${REPO}/releases`;
