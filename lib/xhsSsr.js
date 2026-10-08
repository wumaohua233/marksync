// 小红书 SSR 数据提取：后台直接 fetch，无需渲染页面。

import { t } from "./i18n.js";
import { platformLabel } from "./store.js";
// 小红书网页版是 Next.js SSR，首屏数据嵌在 __INITIAL_STATE__ 里；
// 收藏/点赞列表按时间倒序，检测新增只需首屏 10 条。

async function fetchHtml(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// __INITIAL_STATE__ 是 JS 字面量而非纯 JSON（含 undefined、new Set/Map），
// 统一替换为合法 JSON 后 JSON.parse（MV3 CSP 禁止 eval，不能用 new Function）。
// 处理 new Set([...]) / new Map(...)：按括号配对找到对应右括号，
// Set 取其数组实参，Map 一律视为 {}（扩展只读列表字段，不需要 Map 内容）。
function sanitizeJsLiteral(raw) {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const isSet = raw.startsWith("new Set(", i);
    const isMap = !isSet && raw.startsWith("new Map(", i);
    if (!isSet && !isMap) {
      out += raw[i++];
      continue;
    }
    let j = i + 8; // "new Set(" / "new Map(" 均为 8 字符
    const start = j;
    let depth = 1;
    while (j < raw.length && depth > 0) {
      const c = raw[j];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === '"' || c === "'") {
        const q = c;
        j++;
        while (j < raw.length && raw[j] !== q) {
          if (raw[j] === "\\") j++;
          j++;
        }
      }
      j++;
    }
    const inner = raw.slice(start, j - 1).trim();
    // Set 实参里可能还嵌套 new Set/Map，递归清理
    out += isSet ? sanitizeJsLiteral(inner) || "[]" : "{}";
    i = j;
  }
  return out;
}

function extractInitialState(html) {
  const marker = "__INITIAL_STATE__=";
  const i = html.indexOf(marker);
  if (i < 0) throw new Error(t("errXhsSsrNoData"));
  const j = html.indexOf("</script>", i);
  if (j < 0) throw new Error(t("errSsrBroken"));
  const raw = sanitizeJsLiteral(
    html
      .slice(i + marker.length, j)
      .trim()
      .replace(/([:\[,])undefined(?=[,}\]])/g, "$1null")
  );
  return JSON.parse(raw);
}

// 从首页 SSR/链接中解析当前登录用户 uid
export async function resolveUid() {
  const html = await fetchHtml("https://www.xiaohongshu.com/");
  const m = html.match(/\/user\/profile\/([a-z0-9]{24})/);
  if (m) return m[1];
  const state = extractInitialState(html);
  const uid = state?.user?.userInfo?.user_id;
  if (uid) return uid;
  throw new Error(t("errNotLoggedInPlatform", platformLabel("xhs")));
}

// 列表首屏（约 10 条，时间倒序）。tab: "fav" | "liked"
export async function fetchList(uid, tab) {
  const url = `https://www.xiaohongshu.com/user/profile/${uid}?tab=${tab}&subTab=note`;
  const state = extractInitialState(await fetchHtml(url));
  const u = state.user || {};
  // activeTab.index 指向当前 tab 在 notes 数组里的位置
  const idx = u.activeTab?.index ?? (tab === "liked" ? 2 : 1);
  const arr = u.notes?.[idx];
  if (!Array.isArray(arr)) throw new Error(t("errSsrBroken"));
  return arr
    .filter((it) => it && it.id)
    .map((it) => ({
      id: it.id,
      title: it.noteCard?.displayTitle || "",
      cover: it.noteCard?.cover?.urlDefault || it.noteCard?.cover?.url || "",
      author: it.noteCard?.user?.nickname || "",
      url: `https://www.xiaohongshu.com/explore/${it.id}?xsec_token=${it.xsecToken || ""}&xsec_source=pc_collect`,
    }));
}
