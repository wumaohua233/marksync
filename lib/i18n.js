// Chrome i18n 薄封装：统一取词、DOM 自动本地化、按语言格式化日期。
// popup / options / service worker / content script 都能直接用 chrome.i18n。
// _locales 缺 key 时 getMessage 返回空串，这里回退成 key 本身，方便一眼看出漏翻。

export const UI_LANG = chrome.i18n.getUILanguage() || "en";

// t("key") 或 t("key", a, b) —— 对应 messages.json 里的 $1 $2
export function t(key, ...subs) {
  const args = subs.filter((s) => s != null && s !== "").map(String);
  return chrome.i18n.getMessage(key, args.length ? args : undefined) || key;
}

// 把 HTML 里 data-i18n* 标记的节点就地翻译。
// service worker 里没有 document，直接返回。
export function applyI18n(root) {
  const scope = root || (typeof document !== "undefined" ? document : null);
  if (!scope) return;
  if (scope.querySelectorAll) {
    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
    });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = UI_LANG;
  }
}

// 日期时间一律走 Intl，让中/日/英各自拿到自然写法：
//   zh-CN / ja → "7月12日"   en → "Jul 12"
// 时间为 24 小时制，列表里更省空间，也和三种语言一致。
const OPTS = { hour12: false };
const DATE_FMT = new Intl.DateTimeFormat(UI_LANG, { month: "short", day: "numeric" });
const TIME_FMT = new Intl.DateTimeFormat(UI_LANG, { hour: "2-digit", minute: "2-digit", ...OPTS });
const DATETIME_FMT = new Intl.DateTimeFormat(UI_LANG, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", ...OPTS,
});

export const fmtDate = (ts) => DATE_FMT.format(new Date(ts));
export const fmtTime = (ts) => TIME_FMT.format(new Date(ts));
export const fmtDateTime = (ts) => DATETIME_FMT.format(new Date(ts));

// 同一天只显示时间，跨天显示「日期 时间」——列表里最省地方
export function fmtSmart(ts) {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? fmtTime(ts) : fmtDateTime(ts);
}
