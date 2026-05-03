"use strict";
import { fetchJson, postJson } from "../../api.js";
import { escapeHtml } from "../../format.js";

// Налаштування sub-tab — 6 sections matching v1 layout. Each row inline-
// editable; "Зберегти" POSTs every changed key one by one.

const SECTIONS = [
  {
    id: "objective",
    title: "MULTI-KPI OBJECTIVE",
    accent: "purple",
    keys: [
      "MIN_LIFT_THRESHOLD",
      "IMPORTANCE_WIN_RATE",
      "IMPORTANCE_PROFIT_FACTOR",
      "IMPORTANCE_AVG_PNL",
      "IMPORTANCE_PASS_RATE",
      "IMPORTANCE_SL_RATE",
      "IMPORTANCE_TP_HIT_RATE",
      "IMPORTANCE_EXIT_EFFICIENCY",
      "IMPORTANCE_LEFT_ON_TABLE",
    ],
  },
  {
    id: "cf",
    title: "COUNTERFACTUAL TRACKING",
    accent: "teal",
    keys: ["CF_TRACKING_WINDOW_SEC", "CF_CHECK_INTERVAL_SEC", "CF_MAX_PENDING"],
  },
  {
    id: "engine",
    title: "CALIBRATOR ENGINE",
    accent: "blue",
    keys: [
      "CAL_RUN_INTERVAL_SEC",
      "CAL_MIN_TRADES",
      "CAL_MAX_STEP",
      "CAL_MAX_RECS",
      "CAL_MIN_TRADES_PER_SPORT",
      "PER_SPORT_ENABLED",
      "SPORT_OVERRIDE_MAX_DELTA",
    ],
  },
  {
    id: "decay",
    title: "TIME DECAY",
    accent: "orange",
    keys: ["DECAY_HALF_LIFE_SEC", "DECAY_MIN_WEIGHT"],
  },
  {
    id: "bayes",
    title: "BAYESIAN CONFIDENCE",
    accent: "cyan",
    keys: ["BAYES_STABLE_THRESHOLD", "BAYES_UNCERTAIN_THRESHOLD", "BAYES_AUTO_MIN_CONF"],
  },
  {
    id: "safety",
    title: "SAFETY GUARDRAILS",
    accent: "red",
    keys: ["SAFETY_WR_DROP_ROLLBACK", "SAFETY_VERIFY_TRADES_N", "SAFETY_VERIFY_TIMEOUT_SEC"],
  },
];

function rowHtml(key, current, def) {
  const isBool = typeof def === "boolean";
  const val = current ?? def;
  const input = isBool
    ? `<input type="checkbox" data-key="${escapeHtml(key)}" ${val ? "checked" : ""}>`
    : `<input type="number" step="any" data-key="${escapeHtml(key)}" value="${escapeHtml(String(val ?? ""))}" class="cal-input">`;
  return `<div class="cal-settings-row">
    <div class="cal-settings-label">
      <div class="cal-settings-title">${escapeHtml(key)}</div>
      <div class="cal-settings-key muted">${typeof def}</div>
    </div>
    <div class="cal-settings-input">${input}</div>
    <div class="cal-settings-default muted">за замовчуванням: ${escapeHtml(String(def))}</div>
  </div>`;
}

export async function render(container) {
  container.innerHTML = `<div class="muted">loading налаштування…</div>`;
  let data;
  try {
    data = await fetchJson("/api/calibrator/settings");
  } catch (err) {
    container.innerHTML = `<div class="error-banner">settings: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const current = data.current ?? {};
  const defaults = data.defaults ?? {};

  const sectionsHtml = SECTIONS.map((s) => `
    <section class="card cal-settings-section cal-accent-${s.accent}">
      <div class="card-title">${escapeHtml(s.title)}</div>
      ${s.keys.map((k) => rowHtml(k, current[k], defaults[k])).join("")}
    </section>
  `).join("");

  container.innerHTML = `
    ${sectionsHtml}
    <div class="cal-settings-actions">
      <button id="cal-settings-reset" class="btn btn-warn">Скинути до початкових</button>
      <button id="cal-settings-save" class="btn btn-ok">Зберегти налаштування</button>
    </div>
    <div id="cal-settings-toast" class="muted" style="text-align:center;margin:8px 0"></div>
  `;

  const toast = container.querySelector("#cal-settings-toast");
  function flash(msg, kind) {
    toast.textContent = msg;
    toast.className = kind === "bad" ? "bad" : kind === "ok" ? "ok" : "muted";
    toast.style.textAlign = "center";
    toast.style.margin = "8px 0";
    setTimeout(() => { toast.textContent = ""; }, 4000);
  }

  async function saveAll() {
    const changed = [];
    container.querySelectorAll("[data-key]").forEach((el) => {
      const key = el.getAttribute("data-key");
      const def = defaults[key];
      let val;
      if (typeof def === "boolean") {
        val = el.checked;
      } else {
        const raw = el.value.trim();
        if (raw === "") return;
        val = Number(raw);
        if (!isFinite(val)) return;
      }
      if (val !== current[key]) changed.push({ key, value: val });
    });
    if (changed.length === 0) {
      flash("нічого змінювати", "muted");
      return;
    }
    let okCount = 0;
    let badCount = 0;
    for (const c of changed) {
      try {
        const res = await postJson("/api/calibrator/settings", c);
        if (res?.ok === false) badCount += 1;
        else okCount += 1;
      } catch {
        badCount += 1;
      }
    }
    flash(`saved ${okCount}/${changed.length}${badCount ? ` (${badCount} failed)` : ""}`, badCount ? "bad" : "ok");
    if (okCount > 0) render(container);
  }

  function resetAll() {
    container.querySelectorAll("[data-key]").forEach((el) => {
      const key = el.getAttribute("data-key");
      const def = defaults[key];
      if (typeof def === "boolean") el.checked = !!def;
      else el.value = String(def ?? "");
    });
    flash("значення скинуто (натисни Зберегти, щоб застосувати)", "muted");
  }

  container.querySelector("#cal-settings-save").addEventListener("click", saveAll);
  container.querySelector("#cal-settings-reset").addEventListener("click", resetAll);
}
