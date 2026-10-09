// MarkSync 新手引导
//
// 为什么是独立页面而不是弹窗：第 2 步要让用户去别的标签页登录平台，
// 弹窗一点到外面就关了，回来进度全丢。独立页还能让液玻效果有足够空间。

import * as store from "../lib/store.js";
import { t, applyI18n } from "../lib/i18n.js";

applyI18n();

const $ = (id) => document.getElementById(id);
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 100;
const STEPS = 4;

// 登录入口（按平台）。这些只是"打开对应网站的登录页"，
// 扩展本身不接触账号密码，用户登完之后我们只是读浏览器的登录状态。
const LOGIN_URL = {
  xhs: "https://www.xiaohongshu.com",
  douyin: "https://www.douyin.com",
  youtube: "https://www.youtube.com",
  x: "https://x.com",
  tiktok: "https://www.tiktok.com",
  instagram: "https://www.instagram.com",
};

let settings;
let loginStatus = null;   // null = 还没查过；{xhs:true,...}
let cur = 0;
let syncing = false;

const plats = () => store.platforms();
const enabledOf = (p) => store.sourcesOf(p).some((s) => settings.sources[s]);
const platformLabel = store.platformLabel;

// ── 进度点 ──────────────────────────────────────────────
function renderDots() {
  $("dots").innerHTML = Array.from({ length: STEPS }, (_, i) =>
    `<span class="dot ${i === cur ? "on" : i < cur ? "done" : ""}"></span>`).join("");
}

// ── 步骤切换 ────────────────────────────────────────────
function show(n) {
  const prev = cur;
  cur = n;
  document.querySelectorAll(".step").forEach((el) => {
    const i = Number(el.dataset.step);
    el.classList.toggle("active", i === n);
    el.classList.toggle("left", i < n);          // 已划过的往左退，形成方向感
    if (i === n) el.scrollTop = 0;
  });
  renderDots();

  $("back").hidden = n === 0;
  const next = $("next");
  next.textContent = n === 0 ? t("obStart") : n === STEPS - 1 ? t("obBtnStartSync") : t("obNext");
  next.disabled = n === 1 && !plats().some(enabledOf);
  $("skip").hidden = n === STEPS - 1;

  if (n === 1) refreshLogins();
  if (n === 2) renderLimits();
  if (n === 3) renderFinish(prev < 3);
}

// ── 第 2 步：平台 ───────────────────────────────────────
function renderPlats() {
  $("plats").innerHTML = plats().map((p) => {
    const on = enabledOf(p);
    const st = loginStatus === null ? "unknown" : loginStatus[p] ? "ok" : "no";
    const label = st === "ok" ? t("obStatusLoggedIn") : st === "no" ? t("obStatusNotLoggedIn") : "…";
    return `
      <div class="plat ${on ? "" : "off"}" data-p="${p}">
        <div class="p-top">
          <span class="p-name">${esc(platformLabel(p))}</span>
          <label class="sw">
            <input type="checkbox" data-toggle="${p}" ${on ? "checked" : ""}>
            <span class="track"></span>
          </label>
        </div>
        <div class="p-bot">
          <span class="p-status ${st === "ok" ? "ok" : st === "unknown" ? "unknown" : ""}">${esc(label)}</span>
          <button class="p-login" data-login="${p}" ${st === "ok" ? "hidden" : ""}>${esc(t("obBtnGoLogin"))}</button>
        </div>
      </div>`;
  }).join("");

  $("plats").querySelectorAll("input[data-toggle]").forEach((cb) => {
    cb.addEventListener("change", () => {
      store.sourcesOf(cb.dataset.toggle).forEach((s) => { settings.sources[s] = cb.checked; });
      save();
      renderPlats();
      $("next").disabled = !plats().some(enabledOf);
    });
  });
  $("plats").querySelectorAll("button[data-login]").forEach((b) => {
    b.addEventListener("click", () => {
      chrome.tabs.create({ url: LOGIN_URL[b.dataset.login] });
    });
  });
  updateCount();
}

function updateCount() {
  const n = plats().filter(enabledOf).length;
  // 一个都没选时说清楚为什么不能继续，光靠按钮禁用和抖动用户不知道发生了什么
  $("count").textContent = n ? t("obSelectedCount", String(n)) : t("obNoPlatforms");
  $("count").classList.toggle("warn", n === 0);
}

async function refreshLogins() {
  const btn = $("refresh");
  btn.classList.add("spin");
  try {
    loginStatus = await chrome.runtime.sendMessage({ type: "CHECK_ALL_LOGINS" });
  } catch (_) {
    loginStatus = loginStatus || null;
  }
  btn.classList.remove("spin");
  renderPlats();
}

// ── 第 3 步：每平台条数 ─────────────────────────────────
function renderLimits() {
  // 只列已启用的平台——给禁用的平台调条数本来就没意义，
  // 而且 6 行会把卡片撑出滚动条。
  const on = plats().filter(enabledOf);
  $("lims").innerHTML = on.map((p) => {
    const v = settings.firstRunLimits[p];
    return `
      <div class="lim" data-p="${p}">
        <div class="l-top">
          <span class="l-name">${esc(platformLabel(p))}</span>
          <span class="l-val ${v === 0 ? "zero" : ""}" data-val="${p}">${esc(limitText(v))}</span>
        </div>
        <input type="range" min="0" max="${MAX_LIMIT}" step="5" value="${v}" data-range="${p}">
      </div>`;
  }).join("");

  $("lims").querySelectorAll("input[data-range]").forEach((r) => {
    paintRange(r);
    r.addEventListener("input", () => {
      const p = r.dataset.range;
      const v = Number(r.value);
      settings.firstRunLimits[p] = v;
      paintRange(r);
      const label = document.querySelector(`[data-val="${p}"]`);
      label.textContent = limitText(v);
      label.classList.toggle("zero", v === 0);
      save();
    });
  });
}

function limitText(v) {
  return v === 0 ? t("obLimitZero") : t("obLimitValue", String(v));
}

// 滑块已填充比例（CSS 用 background-size 画进度）
function paintRange(el) {
  el.style.setProperty("--fill", (el.value / MAX_LIMIT * 100) + "%");
}

// ── 第 4 步：完成 / 同步 ────────────────────────────────
function renderFinish(reset) {
  if (reset) {
    syncing = false;
    $("ring").classList.remove("ok", "busy");
    $("ring").querySelector(".bar").style.strokeDashoffset = 283;
    $("finTitle").textContent = t("obDoneTitle");
    $("finDesc").textContent = t("obDoneDesc", String(plats().filter(enabledOf).length));
    $("next").hidden = false;
    $("back").hidden = false;
  }
}

async function startSync() {
  if (syncing) return;
  syncing = true;

  $("next").hidden = true;
  $("back").hidden = true;
  $("skip").hidden = true;
  const ring = $("ring");
  ring.classList.add("busy");
  $("finTitle").textContent = t("obSyncingTitle");
  $("finDesc").textContent = t("obSyncingDesc");

  await store.saveSettings(settings);

  const bar = ring.querySelector(".bar");
  let fake = 0;
  // 真实进度拿不到（采集是背景流程），用一个缓慢逼近 90% 的假进度条，
  // 同步真结束时再补满到 100% —— 比原地转圈好得多，但也不会撒谎说"快好了"
  const tick = setInterval(() => {
    fake = Math.min(90, fake + (90 - fake) * 0.055);
    bar.style.strokeDashoffset = 283 - (283 * fake / 100);
  }, 260);

  let ok = true;
  try {
    await chrome.runtime.sendMessage({ type: "RUN_CHECK_NOW" });
    // 等背景真的跑完（RUN_CHECK_NOW 会等到 runCheck 返回）
  } catch (_) {
    ok = false;
  }
  clearInterval(tick);

  bar.style.strokeDashoffset = 0;
  ring.classList.remove("busy");
  ring.classList.add("ok");

  const items = await store.getItems();
  const n = Object.keys(items).length;

  $("finTitle").textContent = ok ? t("obSyncedTitle") : t("obSyncedDesc");
  $("finDesc").textContent = ok
    ? t("obSyncedDesc", String(n))
    : t("obSyncingDesc");

  settings.onboarded = true;
  await store.saveSettings(settings);

  const btn = $("next");
  btn.hidden = false;
  btn.textContent = t("obBtnFinish");
  btn.disabled = false;
  syncing = false;
}

// ── 收尾 ────────────────────────────────────────────────
async function finish() {
  settings.onboarded = true;
  await store.saveSettings(settings);
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab) chrome.tabs.remove(tab.id);
    else window.close();
  } catch (_) {
    window.close();
  }
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const save = () => store.saveSettings(settings);

// ── 事件 ────────────────────────────────────────────────
$("next").addEventListener("click", () => {
  if (cur === 1 && !plats().some(enabledOf)) {
    // 至少选一个平台，不然同步没东西可做
    $("plats").classList.add("shake");
    setTimeout(() => $("plats").classList.remove("shake"), 480);
    return;
  }
  if (cur === STEPS - 1) {
    if (syncing) return;
    if ($("next").textContent === t("obBtnFinish")) return finish();
    return startSync();
  }
  show(cur + 1);
});

$("back").addEventListener("click", () => { if (cur > 0 && !syncing) show(cur - 1); });
$("skip").addEventListener("click", finish);
$("refresh").addEventListener("click", refreshLogins);

// 用户去别的标签页登录完回来，自动刷新登录状态
window.addEventListener("focus", () => { if (cur === 1) refreshLogins(); });

// ── 启动 ────────────────────────────────────────────────
(async () => {
  settings = await store.getSettings();
  // 首次使用：默认全开、每平台 100 条（用户可以自己调小）
  if (!settings.firstRunLimits) {
    settings.firstRunLimits = Object.fromEntries(plats().map((p) => [p, DEFAULT_LIMIT]));
  }
  for (const p of plats()) {
    if (settings.firstRunLimits[p] == null) settings.firstRunLimits[p] = DEFAULT_LIMIT;
  }
  renderPlats();
  renderDots();
  show(0);
})();
