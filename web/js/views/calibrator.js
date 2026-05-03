"use strict";
import { fetchJson, postJson } from "../api.js";
import { escapeHtml } from "../format.js";

// Calibrator tab — surfaces /api/calibrator/{status,recommendations,run}.
// Auto-refreshes status every 30s, recs every 60s. Manual "Run now" POSTs
// to /run (audit-logged on the server).
//
// We intentionally do NOT auto-apply recommendations from the UI — engine
// design is advisory-only (see src/calibrator/README.md). Operator-driven
// apply lives elsewhere (Strategy tab edit_param flow).

const STATUS_REFRESH_MS = 30_000;
const RECS_REFRESH_MS = 60_000;
const intervals = []; // cleared on tab switch via the next render call

function fmtAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "in future";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtIn(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return "now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}min`;
  return `in ${Math.round(m / 60)}h`;
}

function fmtSigned(n) {
  const v = Number(n) || 0;
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
}

function dirClass(d) {
  if (d === "relax") return "calib-relax";
  if (d === "tighten") return "calib-tighten";
  return "calib-hold";
}

function confClass(c) {
  if (c === "stable") return "calib-stable";
  if (c === "exploring") return "calib-exploring";
  return "calib-low-data";
}

function renderRec(r) {
  const aims = Array.isArray(r.aims) && r.aims.length > 0
    ? `<div class="muted" style="margin-top:4px">aims: ${r.aims.map((a) => escapeHtml(String(a))).join(" · ")}</div>`
    : "";
  const lift = Number(r.liftEstimateUsd) || 0;
  const liftStr = lift !== 0
    ? `<span class="${lift > 0 ? "ok" : "bad"}">${lift > 0 ? "+" : ""}$${lift.toFixed(2)}</span>`
    : `<span class="muted">$0</span>`;
  // Multi-KPI lift matrix (added in calibrator: multi-KPI lift matrix
  // commit). Shows top non-zero KPI deltas inline so the operator can see
  // *which* metric is moving, not just net pnl.
  const matrix = (r.liftMatrix && typeof r.liftMatrix === "object")
    ? Object.entries(r.liftMatrix)
        .filter(([_, v]) => Math.abs(Number(v) || 0) > 0.001)
        .sort((a, b) => Math.abs(Number(b[1])) - Math.abs(Number(a[1])))
        .slice(0, 3)
        .map(([k, v]) => `<span class="muted" style="margin-right:8px">Δ${escapeHtml(k)} ${fmtSigned(v)}</span>`)
        .join("")
    : "";
  return `
    <div class="calib-rec ${dirClass(r.direction)}">
      <div class="pos-head">
        <span class="pos-id">${escapeHtml(r.filterName)} <span class="muted">(${escapeHtml(r.paramKey)})</span></span>
        <span class="calib-dir">${escapeHtml(String(r.direction).toUpperCase())}</span>
      </div>
      <div class="pos-row">
        <span><b>${Number(r.currentValue).toFixed(4)}</b> → <b>${Number(r.recommendedValue).toFixed(4)}</b></span>
        <span class="calib-conf ${confClass(r.confidence)}">${escapeHtml(r.confidence)}</span>
      </div>
      <div class="pos-row" style="margin-top:6px">
        <span>${liftStr} <span class="muted">${escapeHtml(r.liftKpi || "net_pnl")} · ${r.sampleSize} sample</span></span>
      </div>
      ${matrix ? `<div style="margin-top:6px">${matrix}</div>` : ""}
      ${aims}
      <div class="muted" style="margin-top:6px">${escapeHtml(r.reason ?? "")}</div>
    </div>
  `;
}

async function loadStatus(into) {
  try {
    const s = await fetchJson("/api/calibrator/status");
    into.innerHTML = `
      <div class="kv"><span class="k">last run</span><span class="v">${fmtAgo(s.lastRunAt)}${s.lastCycleId ? ` · <span class="muted">${escapeHtml(s.lastCycleId.slice(0, 16))}…</span>` : ""}</span></div>
      <div class="kv"><span class="k">next run</span><span class="v">${fmtIn(s.nextRunAt)} · interval ${Math.round((s.intervalMs ?? 0) / 60000)}min</span></div>
      <div class="kv"><span class="k">mode</span><span class="v">${escapeHtml(s.mode ?? "—")}</span></div>
      <div class="kv"><span class="k">last rec count</span><span class="v">${s.lastRecCount ?? 0}</span></div>
    `;
  } catch (err) {
    into.innerHTML = `<div class="error-banner">status error: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadRecs(into) {
  try {
    const data = await fetchJson("/api/calibrator/recommendations");
    const recs = Array.isArray(data.recommendations) ? data.recommendations : [];
    if (recs.length === 0) {
      into.innerHTML = `<div class="muted">no recommendations yet — run the calibrator at least once.</div>`;
      return;
    }
    into.innerHTML = recs.map(renderRec).join("");
  } catch (err) {
    into.innerHTML = `<div class="error-banner">recs error: ${escapeHtml(err.message)}</div>`;
  }
}

function clearTimers() {
  while (intervals.length > 0) {
    const id = intervals.pop();
    if (id) clearInterval(id);
  }
}

export async function renderCalibrator(root) {
  // Wipe any timers from a previous mount of this view (tab switching).
  clearTimers();

  root.innerHTML = `
    <section class="card">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>Calibrator</span>
        <button id="calib-run" class="btn btn-ok" style="flex:0 0 auto;padding:6px 12px">Run now ⟳</button>
      </div>
      <div id="calib-status" class="card-body"><span class="muted">loading…</span></div>
    </section>
    <section class="card">
      <div class="card-title">Recommendations</div>
      <div id="calib-recs" class="card-body"><span class="muted">loading…</span></div>
    </section>
    <div id="calib-toast" class="muted" style="text-align:center;margin:8px 0"></div>
  `;

  const statusEl = root.querySelector("#calib-status");
  const recsEl = root.querySelector("#calib-recs");
  const runBtn = root.querySelector("#calib-run");
  const toastEl = root.querySelector("#calib-toast");

  function toast(msg, kind = "muted") {
    toastEl.textContent = msg;
    toastEl.className = kind === "bad" ? "bad" : kind === "ok" ? "ok" : "muted";
    toastEl.style.textAlign = "center";
    toastEl.style.margin = "8px 0";
    setTimeout(() => {
      toastEl.textContent = "";
    }, 5000);
  }

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    const orig = runBtn.textContent;
    runBtn.textContent = "running…";
    try {
      const res = await postJson("/api/calibrator/run", {});
      toast(`cycle ${res.cycleId.slice(0, 16)}… · ${res.recCount} recs · avgPnl $${(Number(res.avgPnlPerTradeUsd) || 0).toFixed(2)}`, "ok");
      await Promise.all([loadStatus(statusEl), loadRecs(recsEl)]);
    } catch (err) {
      toast(`run failed: ${err.message}`, "bad");
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = orig;
    }
  });

  await Promise.all([loadStatus(statusEl), loadRecs(recsEl)]);

  intervals.push(setInterval(() => loadStatus(statusEl), STATUS_REFRESH_MS));
  intervals.push(setInterval(() => loadRecs(recsEl), RECS_REFRESH_MS));
}
