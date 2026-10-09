// MarkSync 新手引导
//
// 为什么是独立页面而不是弹窗：第 2 步要让用户去别的标签页登录平台，
// 弹窗一点到外面就关了，回来进度全丢。独立页还能让液玻效果有足够空间。

import * as store from "../lib/store.js";
import { t, applyI18n } from "../lib/i18n.js";

applyI18n();

const $ = (id) => document.getElementById(id);
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;   // 见 lib/store.js 里为什么是 10

// 同步频率选项（分钟）。默认 3 小时。
const FREQ = [30, 60, 180, 360, 720, 1440];
const FREQ_KEY = { 30: "freq30m", 60: "freq1h", 180: "freq3h", 360: "freq6h", 720: "freq12h", 1440: "freq1d" };
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
let lastState = "freq";   // 最后一步的三个形态：freq → syncing → done

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
  cur = n;
  document.querySelectorAll(".step").forEach((el) => {
    const i = Number(el.dataset.step);
    el.classList.toggle("active", i === n);
    el.classList.toggle("left", i < n);          // 已划过的往左退，形成方向感
    if (i === n) el.scrollTop = 0;
  });
  renderDots();

  const next = $("next");
  $("back").hidden = n === 0;
  $("skip").hidden = n === STEPS - 1;
  next.disabled = n === 1 && !plats().some(enabledOf);
  next.textContent = n === 0 ? t("obStart") : n === STEPS - 1 ? t("obBtnStartSync") : t("obNext");

  if (n === 1) refreshLogins();
  if (n === 2) renderLimits();
  if (n === 3) setLastState("freq");
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
          <label class="ms-sw">
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

// ── 第 4 步：同步频率 ───────────────────────────────────
function renderFreq() {
  let v = settings.intervalMinutes;
  // 用户可能在设置页填过任意分钟数（比如 45），不在这 6 个选项里。
  // 就近吸附到一个选项，避免一个都没选中。
  if (!FREQ.includes(v)) {
    v = FREQ.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
    settings.intervalMinutes = v;
    save();
  }
  $("freq-opts").innerHTML = FREQ.map((m) =>
    `<button class="freq ${m === v ? "on" : ""}" type="button" data-freq="${m}">` +
    `<span class="f-check"></span><span>${esc(t(FREQ_KEY[m]))}</span></button>`
  ).join("");

  $("freq-opts").querySelectorAll("button[data-freq]").forEach((b) => {
    b.addEventListener("click", () => {
      settings.intervalMinutes = Number(b.dataset.freq);
      save();
      $("freq-opts").querySelectorAll("button").forEach((x) =>
        x.classList.toggle("on", x === b));
      moveFreqHl();
    });
  });
  // 首帧不要动画，否则会从顶部"滑"到当前选项
  moveFreqHl(false);
}

function moveFreqHl(animate = true) {
  const opts = $("freq-opts");
  const on = opts.querySelector(".freq.on");
  const hl = $("freq-hl");
  if (!on) return;
  hl.style.transition = animate ? "" : "none";
  hl.style.transform = `translateY(${on.offsetTop}px)`;
  hl.style.height = on.offsetHeight + "px";
  if (!animate) void hl.offsetHeight;   // 强制回流，避免 next frame 又动画一次
}

// ── 最后一步的三个形态：选频率 → 同步中 → 结果 ───────────
// 合并成同一个 step，省掉一个"完成"圆点——用户在那一步其实没东西可配。
function setLastState(s) {
  lastState = s;
  $("freq-view").hidden = s !== "freq";
  $("finish-view").hidden = s === "freq";

  const btn = $("next");
  const ring = $("ring");
  btn.disabled = false;

  if (s === "freq") {
    btn.textContent = t("obBtnStartSync");
    btn.hidden = false;
    $("back").hidden = false;
    $("skip").hidden = false;
    renderFreq();
  } else if (s === "syncing") {
    btn.hidden = true;
    $("back").hidden = true;
    $("skip").hidden = true;
    ring.classList.remove("ok");
    ring.classList.add("busy");
    ring.querySelector(".bar").style.strokeDashoffset = 283;
    $("finTitle").textContent = t("obSyncingTitle");
    $("finDesc").textContent = t("obSyncingDesc");
  } else {
    ring.classList.remove("busy");
    ring.classList.add("ok");
    btn.textContent = t("obBtnFinish");
    btn.hidden = false;
    $("back").hidden = true;
    $("skip").hidden = true;
  }
}

async function startSync() {
  if (syncing) return;
  syncing = true;
  setLastState("syncing");

  await store.saveSettings(settings);

  const ring = $("ring");
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

  const items = await store.getItems();
  const n = Object.keys(items).length;

  setLastState("done");
  $("finTitle").textContent = t("obSyncedTitle");
  $("finDesc").textContent = n > 0 ? t("obSyncedDesc", String(n)) : t("obSyncedNone");

  settings.onboarded = true;
  await store.saveSettings(settings);
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
    if (lastState === "done") return finish();
    return startSync();
  }
  show(cur + 1);
});

$("back").addEventListener("click", () => { if (cur > 0 && !syncing) show(cur - 1); });
$("skip").addEventListener("click", finish);
$("refresh").addEventListener("click", refreshLogins);

// 用户去别的标签页登录完回来，自动刷新登录状态
window.addEventListener("focus", () => { if (cur === 1) refreshLogins(); });
// 高亮是绝对定位的，尺寸一变就要重算，否则会错位
window.addEventListener("resize", () => { if (cur === 3 && lastState === "freq") moveFreqHl(false); });

// ── 启动 ────────────────────────────────────────────────
(async () => {
  settings = await store.getSettings();
  // 首次使用：默认全开、每平台 10 条（用户可以自己调大）
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
