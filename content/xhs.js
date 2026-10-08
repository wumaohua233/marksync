// 小红书 content script：解析 uid、收藏/点赞列表滚动抓取、详情正文提取。
// 与 background 的消息协议见 background.js（XHS_* 消息）。

const msg = (k, ...a) =>
  chrome.i18n.getMessage(k, a.length ? a.map(String) : undefined) || k;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

// 从当前页面提取列表条目并 merge 进 map（按 noteId 去重）。
// 小红书瀑布流可能是虚拟列表，旧 DOM 会被回收，必须边滚边收。
function harvest(map) {
  for (const sec of document.querySelectorAll("section.note-item[data-note-id]")) {
    const id = sec.getAttribute("data-note-id");
    if (!id || map.has(id)) continue;
    const titleEl = sec.querySelector(".title span") || sec.querySelector("a.title");
    const coverImg = sec.querySelector("a.cover img") || sec.querySelector("img");
    const linkEl = sec.querySelector("a.cover[href]") || sec.querySelector("a[href]");
    const authorEl = sec.querySelector("[class*=author] a") || sec.querySelector("[class*=author]");
    map.set(id, {
      id,
      title: (titleEl?.textContent || "").trim(),
      cover: coverImg?.src || "",
      url: linkEl ? new URL(linkEl.getAttribute("href"), location.origin).href : "",
      author: (authorEl?.textContent || "").trim().slice(0, 40),
    });
  }
}

// 若目标面板未激活（无条目），点击对应 tab 激活。
async function ensurePanelActivated() {
  await sleep(2500);
  if (document.querySelectorAll("section.note-item").length > 0) return;
  const want = location.search.includes("tab=liked") ? "点赞" : "收藏";
  const tab = Array.from(document.querySelectorAll(".reds-tab-item")).find(
    (t) => t.textContent.trim() === want
  );
  if (tab) {
    tab.click();
    await sleep(3000);
  }
}

async function collectList() {
  await ensurePanelActivated();
  const map = new Map();
  let staleRounds = 0;
  for (let round = 0; round < 60 && map.size < 500; round++) {
    const before = map.size;
    harvest(map);
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(rand(900, 1500));
    harvest(map);
    if (map.size === before) {
      staleRounds++;
      if (staleRounds >= 3) break;
    } else {
      staleRounds = 0;
    }
  }
  window.scrollTo(0, 0);
  return { ok: true, items: Array.from(map.values()) };
}

function resolveUid() {
  const a = document.querySelector('a[href*="/user/profile/"]');
  if (!a) return { ok: false, error: msg("errXhsNoUid") };
  const m = (a.getAttribute("href") || "").match(/\/user\/profile\/([a-z0-9]+)/);
  return m ? { ok: true, uid: m[1] } : { ok: false, error: msg("errXhsUidFail") };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ ok: true });
  } else if (msg.type === "XHS_RESOLVE_UID") {
    sendResponse(resolveUid());
  } else if (msg.type === "XHS_COLLECT_LIST") {
    collectList().then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true; // 异步
  }
});
