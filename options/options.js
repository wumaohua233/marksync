// options：检测间隔设置与数据重置。

import * as store from "../lib/store.js";
import { t, applyI18n } from "../lib/i18n.js";

applyI18n();

const $ = (id) => document.getElementById(id);

const escapeHtml = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

function showMsg(text, ok) {
  const el = $("msg");
  el.textContent = text;
  el.className = ok ? "ok" : "err";
  setTimeout(() => { el.textContent = ""; }, 6000);
}

// 按平台分组渲染数据源开关；勾选状态来自 settings.sources
function renderSources(sources) {
  const groups = {};
  for (const [key, meta] of Object.entries(store.SOURCES)) {
    (groups[meta.platform] = groups[meta.platform] || []).push(key);
  }
  let html = "";
  for (const [plat, keys] of Object.entries(groups)) {
    const items = keys
      .map(
        (key) =>
          `<label class="src-item"><input type="checkbox" data-source="${key}"${
            sources[key] ? " checked" : ""
          }> ${escapeHtml(store.sourceShortLabel(key))}</label>`
      )
      .join("");
    html += `<div class="src-group"><span class="src-plat">${escapeHtml(
      store.platformLabel(plat)
    )}</span><div class="src-items">${items}</div></div>`;
  }
  $("sources").innerHTML = html;
}

// 首次同步条数：按平台一个数字输入，上限 100（和引导页的滑块同一个值）
function renderLimits(limits) {
  $("limits").innerHTML = store.platforms().map((p) => `
    <div class="lim-row">
      <span class="lim-name">${escapeHtml(store.platformLabel(p))}</span>
      <input type="number" min="0" max="100" step="5" data-limit="${p}" value="${limits[p] ?? 10}">
      <span class="lim-unit">/ 100</span>
    </div>`).join("");
}

async function load() {
  const s = await store.getSettings();
  renderSources(s.sources);
  renderLimits(s.firstRunLimits);
  const mins = Math.max(1, s.intervalMinutes || 180);
  if (mins % 1440 === 0) {
    $("intervalValue").value = mins / 1440;
    $("intervalUnit").value = "1440";
  } else if (mins % 60 === 0) {
    $("intervalValue").value = mins / 60;
    $("intervalUnit").value = "60";
  } else {
    $("intervalValue").value = mins;
    $("intervalUnit").value = "1";
  }
}

$("btn-save").addEventListener("click", async () => {
  const s = await store.getSettings();
  const sources = {};
  document.querySelectorAll("#sources input[data-source]").forEach((cb) => {
    sources[cb.dataset.source] = cb.checked;
  });
  s.sources = sources;

  const limits = {};
  document.querySelectorAll("#limits input[data-limit]").forEach((inp) => {
    const v = parseInt(inp.value, 10);
    limits[inp.dataset.limit] = Math.max(0, Math.min(100, Number.isFinite(v) ? v : 10));
  });
  s.firstRunLimits = limits;
  const raw = parseFloat($("intervalValue").value);
  const unit = parseInt($("intervalUnit").value, 10) || 60;
  let mins = Number.isFinite(raw) && raw > 0 ? raw * unit : 180;
  let note = t("msgSaved");
  if (mins < 0.5) {
    mins = 0.5; // Chrome alarms 最小周期 30 秒
    note = t("msgSavedClamped");
  }
  s.intervalMinutes = mins;
  delete s.intervalHours; // 清掉旧字段
  await store.saveSettings(s);
  await chrome.runtime.sendMessage({ type: "RESET_ALARM" });
  showMsg(note, true);
});

$("btn-clear").addEventListener("click", async () => {
  if (!confirm(t("confirmClear"))) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_ALL" });
  showMsg(t("msgCleared"), true);
});

$("btn-onboarding").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "OPEN_ONBOARDING" });
});

load();
