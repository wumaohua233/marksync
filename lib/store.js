// chrome.storage.local 封装：设置、已见 id、条目、运行记录。
// 供 background / popup / options 以 ES module 方式共用。

import { t } from "./i18n.js";

// labelKey / shortKey 都指向 _locales/*/messages.json。
// shortKey 是设置页复选框那种短标签（平台名由分组标题给出），
// 不靠字符串裁剪从 labelKey 推，否则每种语言的裁剪规则都不一样。
export const SOURCES = {
  xhs_fav: { platform: "xhs", labelKey: "src_xhs_fav", shortKey: "srcs_xhs_fav" },
  xhs_like: { platform: "xhs", labelKey: "src_xhs_like", shortKey: "srcs_xhs_like" },
  dy_fav: { platform: "douyin", labelKey: "src_dy_fav", shortKey: "srcs_dy_fav" },
  dy_like: { platform: "douyin", labelKey: "src_dy_like", shortKey: "srcs_dy_like" },
  yt_like: { platform: "youtube", labelKey: "src_yt_like", shortKey: "srcs_yt_like" },
  yt_watch: { platform: "youtube", labelKey: "src_yt_watch", shortKey: "srcs_yt_watch" },
  x_bookmark: { platform: "x", labelKey: "src_x_bookmark", shortKey: "srcs_x_bookmark" },
  x_like: { platform: "x", labelKey: "src_x_like", shortKey: "srcs_x_like" },
  tt_fav: { platform: "tiktok", labelKey: "src_tt_fav", shortKey: "srcs_tt_fav" },
  tt_like: { platform: "tiktok", labelKey: "src_tt_like", shortKey: "srcs_tt_like" },
  ig_fav: { platform: "instagram", labelKey: "src_ig_fav", shortKey: "srcs_ig_fav" },
  ig_like: { platform: "instagram", labelKey: "src_ig_like", shortKey: "srcs_ig_like" },
};

// 列表分组标题 / CSV「来源」列用的完整名，如「小红书收藏」
export function sourceLabel(key) {
  const s = SOURCES[key];
  return s ? t(s.labelKey) : key;
}

// 设置页复选框那种短标签，如「收藏」
export function sourceShortLabel(key) {
  const s = SOURCES[key];
  return s ? t(s.shortKey) : key;
}

// 平台名，如「小红书」。三处（popup / options / 后台）共用，避免各写一份表。
export function platformLabel(platform) {
  return t("plat_" + platform);
}

// 某个平台下的所有数据源，如 "xhs" → ["xhs_fav", "xhs_like"]。
// 设置页和新手引导都是按「平台」开关的，底层按 source 存，靠这个转换。
export function sourcesOf(platform) {
  return Object.entries(SOURCES)
    .filter(([, m]) => m.platform === platform)
    .map(([k]) => k);
}

// 去重后的平台列表，保持 SOURCES 的声明顺序
export function platforms() {
  const seen = new Set();
  const out = [];
  for (const meta of Object.values(SOURCES)) {
    if (!seen.has(meta.platform)) {
      seen.add(meta.platform);
      out.push(meta.platform);
    }
  }
  return out;
}

export const DEFAULT_SETTINGS = {
  sources: { xhs_fav: true, xhs_like: true, dy_fav: true, dy_like: true, yt_like: true, yt_watch: true, x_bookmark: true, x_like: true, tt_fav: true, tt_like: true, ig_fav: true, ig_like: true },
  // 首次同步每个平台最多拉多少条作起点。0 = 不拉历史。
  firstRunLimits: { xhs: 100, douyin: 100, youtube: 100, x: 100, tiktok: 100, instagram: 100 },
  intervalMinutes: 180,
  firstRunDone: false,
  // true = 不弹新手引导。默认 true（升级上来的老用户不该被重复引导），
  // 全新安装时由 background 的 onInstalled 显式置为 false。
  onboarded: true,
};

async function getRaw(key, fallback) {
  const obj = await chrome.storage.local.get(key);
  return obj[key] === undefined ? fallback : obj[key];
}

async function setRaw(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function getSettings() {
  const s = await getRaw("settings", {});
  const merged = {
    ...DEFAULT_SETTINGS,
    ...s,
    sources: { ...DEFAULT_SETTINGS.sources, ...(s.sources || {}) },
    firstRunLimits: { ...DEFAULT_SETTINGS.firstRunLimits, ...(s.firstRunLimits || {}) },
  };
  // 旧版 intervalHours（小时）迁移为 intervalMinutes（分钟）
  if (s.intervalMinutes == null && s.intervalHours != null) {
    merged.intervalMinutes = Math.max(1, s.intervalHours * 60);
  }
  return merged;
}

export async function saveSettings(settings) {
  await setRaw("settings", settings);
}

export async function getSeen(source) {
  const seen = await getRaw("seen", {});
  return seen[source] || {};
}

export async function addSeen(source, ids) {
  const seen = await getRaw("seen", {});
  const bucket = seen[source] || {};
  for (const id of ids) bucket[id] = true;
  seen[source] = bucket;
  await setRaw("seen", seen);
}

export async function getItems() {
  return await getRaw("items", {});
}

export async function upsertItems(newItems) {
  const items = await getRaw("items", {});
  for (const it of newItems) items[it.key] = it;
  await setRaw("items", items);
}

export async function updateItem(key, patch) {
  const items = await getRaw("items", {});
  if (items[key]) {
    Object.assign(items[key], patch);
    await setRaw("items", items);
  }
}

export async function markAllRead() {
  const items = await getRaw("items", {});
  for (const k of Object.keys(items)) items[k].status = "read";
  await setRaw("items", items);
}

export async function unreadCount() {
  const items = await getRaw("items", {});
  return Object.values(items).filter((it) => it.status === "new").length;
}

export async function getLastRun() {
  return await getRaw("lastRun", null);
}

export async function setLastRun(record) {
  await setRaw("lastRun", record);
}

// 每个平台各自的最近同步时间戳：{ xhs: ts, douyin: ts, ... }
export async function getPlatformSync() {
  return await getRaw("platformSync", {});
}

export async function setPlatformSync(obj) {
  await setRaw("platformSync", obj);
}

// 网络未就绪、正在等待重试的起始时间戳（0 = 没在等）
export async function getNetPending() {
  return await getRaw("netPending", 0);
}

export async function setNetPending(ts) {
  await setRaw("netPending", ts);
}
