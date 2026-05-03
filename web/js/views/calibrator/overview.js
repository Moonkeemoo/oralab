"use strict";
import { fetchJson } from "../../api.js";
import { escapeHtml, fmt$, fmtPct, fmtAge } from "../../format.js";

// Огляд sub-tab — three coloured status cards (Entry/Exit/Performance),
// MULTI-KPI OBJECTIVE bar showing each KPI's value vs ideal weighted by
// importance, conditions checklist (mode, sample size, top-lift, daemon
// alive), then change-history tables sourced from the trace event stream.

const KPI_META = {
  win_rate: { label: "WR", kind: "pct", ideal: 0.62, worst: 0.40, dir: "up" },
  profit_factor: { label: "PF", kind: "ratio", ideal: 2.0, worst: 0.5, dir: "up" },
  avg_pnl: { label: "AVG_PNL", kind: "money", ideal: 0.35, worst: -0.45, dir: "up" },
  pass_rate: { label: "PASS_RATE", kind: "pct", ideal: 0.05, worst: 0.10, dir: "band" },
  sl_rate: { label: "SL_RATE", kind: "pct", ideal: 0.15, worst: 0.60, dir: "down" },
  tp_hit_rate: { label: "TP_RATE", kind: "pct", ideal: 0.35, worst: 0.05, dir: "up" },
  exit_efficiency: { label: "EFF", kind: "pct", ideal: 0.75, worst: 0.30, dir: "up" },
  left_on_table: { label: "LOT", kind: "pct", ideal: 0.15, worst: 0.70, dir: "down" },
};

function fmtKpi(v, kind) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  if (kind === "pct") return `${(v * 100).toFixed(1)}%`;
  if (kind === "money") return `$${v.toFixed(2)}`;
  if (kind === "ratio") return v.toFixed(2);
  return String(v);
}

function deficitRatio(value, meta) {
  if (typeof value !== "number" || !isFinite(value)) return 0;
  if (meta.dir === "up") {
    if (value >= meta.ideal) return 0;
    if (value <= meta.worst) return 1;
    return (meta.ideal - value) / (meta.ideal - meta.worst);
  }
  if (meta.dir === "down") {
    if (value <= meta.ideal) return 0;
    if (value >= meta.worst) return 1;
    return (value - meta.ideal) / (meta.worst - meta.ideal);
  }
  return 0;
}

function statusCard(accent, title, lines) {
  return `
    <div class="cal-status-card cal-accent-${accent}">
      <div class="cal-status-card-title">${escapeHtml(title)}</div>
      ${lines.map(([k, v, sub]) =>
        `<div class="cal-status-card-row"><span>${escapeHtml(k)}</span><span class="cal-status-card-val">${v ?? "—"}${sub ? ` <span class="muted">${sub}</span>` : ""}</span></div>`
      ).join("")}
    </div>
  `;
}

function objectiveBar(snapshot) {
  const kpi = { ...(snapshot.kpi || {}), ...(snapshot.exitKpi || {}) };
  const weights = snapshot.weights || {};
  const rows = Object.entries(KPI_META).map(([key, meta]) => {
    const value = kpi[key];
    const w = Number(weights[key] ?? 0);
    const def = deficitRatio(value, meta);
    const pct = Math.round((1 - def) * 100); // higher = closer to target
    const colorClass = def > 0.5 ? "cal-bar-bad" : def > 0.2 ? "cal-bar-warn" : "cal-bar-ok";
    return `
      <div class="cal-objective-row">
        <span class="cal-objective-label">${escapeHtml(meta.label)}</span>
        <span class="cal-objective-val">${fmtKpi(value, meta.kind)}</span>
        <div class="cal-objective-bar"><div class="cal-objective-bar-fill ${colorClass}" style="width:${pct}%"></div></div>
        <span class="cal-objective-w muted">w ${w.toFixed(2)}</span>
      </div>
    `;
  }).join("");
  return rows;
}

function checklistView(snapshot) {
  // Backend returns either an array of items, or { ok, reasons } summary.
  // Synthesize a 4-row v1-parity checklist from snapshot fields.
  const cl = snapshot.checklist;
  let items;
  if (Array.isArray(cl)) {
    items = cl.map((it) => ({
      ok: !!(it.ok ?? it.met ?? it.pass),
      label: it.label ?? it.name ?? it.key ?? "—",
      detail: it.detail ?? "",
    }));
  } else {
    const reasons = Array.isArray(cl?.reasons) ? cl.reasons : [];
    const reasonText = (key) => reasons.find((r) => String(r).includes(key)) ?? "";
    const closed = Number(snapshot.closedTrades ?? 0);
    items = [
      {
        ok: snapshot.mode !== "manual",
        label: "Mode != manual",
        detail: snapshot.mode ? `mode = ${snapshot.mode}` : "",
      },
      {
        ok: !reasonText("min_trades"),
        label: "Закритих трейдів ≥ CAL_MIN_TRADES",
        detail: `${closed} трейдів`,
      },
      {
        ok: !reasonText("lift") && !reasonText("score"),
        label: "Top lever score ≥ MIN_LIFT_THRESHOLD",
        detail: reasonText("lift") || reasonText("score") || "",
      },
      {
        ok: !reasonText("daemon") && !reasonText("alive"),
        label: "Калібратор працює",
        detail: reasonText("daemon") || reasonText("alive") || "",
      },
    ];
  }
  if (items.length === 0) return `<div class="muted">no checklist data</div>`;
  return items.map((item) => `
    <div class="cal-checklist-item ${item.ok ? "ok" : "bad"}">
      <span class="cal-checklist-icon">${item.ok ? "✓" : "✗"}</span>
      <span>${escapeHtml(item.label)}</span>
      ${item.detail ? `<span class="muted">${escapeHtml(String(item.detail))}</span>` : ""}
    </div>
  `).join("");
}

async function loadHistoryTable(filter) {
  // Pull apply events from trace; filter by entry vs exit by inspecting
  // the rec's filter name or payload.
  try {
    const data = await fetchJson(`/api/calibrator/trace?eventType=apply&limit=50`);
    const rows = (data.rows || []).filter((r) => {
      const isExit = String(r.filterName ?? r.payload?.filterName ?? "").startsWith("EXIT_");
      return filter === "exit" ? isExit : !isExit;
    });
    if (rows.length === 0) return `<div class="muted">no applied changes yet.</div>`;
    return `
      <table class="cal-history-table">
        <thead><tr><th>Фільтр</th><th>Було</th><th>Стало</th><th>Коли</th></tr></thead>
        <tbody>
          ${rows.map((r) => {
            const p = r.payload || {};
            return `<tr>
              <td>${escapeHtml(r.filterName ?? p.filterName ?? p.paramKey ?? "—")}</td>
              <td>${p.currentValue !== undefined ? Number(p.currentValue).toFixed(4) : (p.previousValue !== undefined ? Number(p.previousValue).toFixed(4) : "—")}</td>
              <td>${p.recommendedValue !== undefined ? Number(p.recommendedValue).toFixed(4) : (p.newValue !== undefined ? Number(p.newValue).toFixed(4) : "—")}</td>
              <td class="muted">${fmtAge(Date.now() - Number(r.ts ?? r.createdAt ?? 0))}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;
  } catch (err) {
    return `<div class="error-banner">history error: ${escapeHtml(err.message)}</div>`;
  }
}

export async function render(container) {
  container.innerHTML = `<div class="muted">loading Огляд…</div>`;

  let snapshot = {};
  let kpi = {};
  try {
    [snapshot, kpi] = await Promise.all([
      fetchJson("/api/calibrator/snapshot").catch(() => ({})),
      fetchJson("/api/kpi").catch(() => ({})),
    ]);
  } catch {
    // continue with empty
  }

  const k = snapshot.kpi || {};
  const ek = snapshot.exitKpi || {};
  const perf = kpi || {};

  const entryCard = statusCard("blue", "ENTRY PIPELINE", [
    ["pass_rate", fmtKpi(k.pass_rate, "pct")],
    ["top_rejection", escapeHtml(snapshot.topRejection ?? "—")],
    ["signals/hr", typeof snapshot.signalsPerHour === "number" ? snapshot.signalsPerHour.toFixed(1) : (snapshot.totalSignals ? `${(snapshot.totalSignals / 24).toFixed(1)}` : "—")],
    ["cf_net", fmt$(Number(snapshot.cfNetUsd ?? 0))],
  ]);

  const exitCard = statusCard("orange", "EXIT ENGINE TP/SL/Trail", [
    ["exit_efficiency", fmtKpi(ek.exit_efficiency, "pct")],
    ["tp_hit_rate", fmtKpi(ek.tp_hit_rate, "pct")],
    ["left_on_table", fmtKpi(ek.left_on_table, "pct")],
    ["sl_rate", fmtKpi(ek.sl_rate, "pct")],
  ]);

  const perfCard = statusCard("green", "PERFORMANCE", [
    ["win_rate", fmtKpi(k.win_rate, "pct")],
    ["profit_factor", fmtKpi(k.profit_factor, "ratio")],
    ["avg_pnl/trade", fmt$(Number(perf.avgPnlPerTrade ?? k.avg_pnl ?? 0))],
    ["total_pnl", fmt$(Number(perf.totalPnl ?? perf.realizedPnlUsd ?? 0))],
  ]);

  const histEntry = await loadHistoryTable("entry");
  const histExit = await loadHistoryTable("exit");

  container.innerHTML = `
    <div class="cal-status-row">
      ${entryCard}
      ${exitCard}
      ${perfCard}
    </div>

    <section class="card">
      <div class="card-title">MULTI-KPI OBJECTIVE</div>
      <div class="cal-objective">${objectiveBar(snapshot)}</div>
      <div class="muted" style="margin-top:8px;font-size:12px">
        Як читати: бар показує наскільки KPI близький до цільового значення.
        Червоний — далеко (deficit), сірий — біля цілі. <b>w</b> — вага у поточному циклі (calc: importance × deficit / Σ).
      </div>
    </section>

    <section class="card">
      <div class="card-title">УМОВИ РЕКОМЕНДАЦІЙ</div>
      <div class="cal-checklist">${checklistView(snapshot)}</div>
    </section>

    <section class="card">
      <div class="card-title">ІСТОРІЯ ЗМІН ENTRY</div>
      ${histEntry}
    </section>

    <section class="card">
      <div class="card-title">ІСТОРІЯ ЗМІН EXIT</div>
      ${histExit}
    </section>
  `;
}
