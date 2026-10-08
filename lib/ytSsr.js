// YouTube 无感抓取：后台 fetch 播放列表页，解析内嵌的 ytInitialData。

import { t } from "./i18n.js";
// 和小红书 SSR 同套路——数据就在 HTML 里，带 cookie fetch 即可，无需开窗口。
// 「喜欢的视频」= list=LL，「稍后观看」= list=WL（都是登录用户的私密列表）。
// 列表条目现为 lockupViewModel（YouTube 2024+ 的新视图模型），按时间倒序。

async function fetchHtml(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// ytInitialData 是 JS 对象字面量，从赋值处第一个 { 起做花括号配对截取，再 JSON.parse。
// （MV3 CSP 禁 eval，不能直接执行；字符串内的括号用状态机跳过。）
function extractInitialData(html) {
  const m = html.match(/ytInitialData"?\]?\s*=\s*/);
  if (!m) throw new Error(t("errYtNoData"));
  const s = html.indexOf("{", m.index + m[0].length);
  if (s < 0) throw new Error(t("errSsrBroken"));
  let depth = 0, inStr = false, esc = false;
  for (let p = s; p < html.length; p++) {
    const c = html[p];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return JSON.parse(html.slice(s, p + 1));
      }
    }
  }
  throw new Error(t("errSsrBroken"));
}

// 递归提取视频条目。兼容多种容器：
//  - lockupViewModel（2024+ 新视图模型，公开列表用）
//  - playlistVideoRenderer / gridVideoRenderer / videoRenderer（旧渲染器，
//    「喜欢的视频」「稍后观看」等个人系统列表常见）
// 不写死路径，抗 YouTube 结构调整。
function harvestVideos(data) {
  const items = [];
  const seen = new Set();
  const runsText = (o) => o?.runs?.[0]?.text || o?.simpleText || o?.content || "";
  const push = (id, title, author) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    items.push({
      id,
      title: (title || "").trim(),
      cover: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      author: (author || "").trim(),
      url: `https://www.youtube.com/watch?v=${id}`,
    });
  };
  (function walk(o, d) {
    if (d > 45 || !o || typeof o !== "object") return;
    // 新版视图模型
    const lv = o.lockupViewModel;
    if (lv && lv.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" && lv.contentId) {
      const m = lv.metadata?.lockupMetadataViewModel;
      const rows = m?.metadata?.contentMetadataViewModel?.metadataRows || [];
      push(lv.contentId, m?.title?.content, rows?.[0]?.metadataParts?.[0]?.text?.content);
      return;
    }
    // 旧版渲染器
    const pv = o.playlistVideoRenderer || o.gridVideoRenderer || o.videoRenderer;
    if (pv && pv.videoId) {
      push(
        pv.videoId,
        runsText(pv.title),
        runsText(pv.shortBylineText) || runsText(pv.ownerText) || runsText(pv.longBylineText)
      );
      return;
    }
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === "object") walk(v, d + 1);
    }
  })(data, 0);
  return items;
}

// playlistId: "LL"(喜欢的视频) | "WL"(稍后观看)。返回时间倒序的视频列表。
export async function fetchList(playlistId) {
  const html = await fetchHtml(`https://www.youtube.com/playlist?list=${playlistId}`);
  const data = extractInitialData(html);
  const items = harvestVideos(data);
  if (items.length === 0) throw new Error(t("errNoContent"));
  return items;
}
