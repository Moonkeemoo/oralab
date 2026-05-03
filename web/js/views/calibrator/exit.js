"use strict";
import { fetchJson } from "../../api.js";
import { escapeHtml, fmt$, fmtPct } from "../../format.js";

// Exit sub-tab — LIFT MATRIX (exit-side knobs widen/narrow), close-reason
// distribution, 4 analysis cards (TP/SL/Trail/Time) and current params table.

const EXIT_KPIS = ["sl_rate", "tp_hit_rate", "exit_efficiency", "left_on_table"];
const EXIT_HEAD = { sl_rate: "Δ SL_RATE", tp_hit_rate: "Δ TP_HIT", exit_efficiency: "Δ EFF", left_on_table: "Δ LOT" };
const MIN_LIFT_THRESHOLD = 0.08;

function deltaCell(v) {
  const num = Number(v ?? 0);
  if (!isFinite(num) || Math.abs(num) < 1e-4) return `<td class="cal-lift-cell muted">—</td>`;
  const cls = num > 0 ? "delta-pos" : "delta-neg";
  const sign = num > 0 ? "+" : "";
  return `<td class="cal-lift-cell ${cls}">${sign}${num.toFixed(3)}</td>`;
}

async function renderLiftMatrix() {
  try {
    const data = await fetchJson("/api/calibrator/lift_matrix?phase=exit");
    const matrix = data.matrix ?? [];
    if (matrix.length === 0) return `<div class="muted">no exit-side recommendations.</div>`;
    const rows = matrix.map((row) => {
      const lift = row.lift || {};
      const score = Number(row.score ?? 0);
      const conf = row.confidence ?? "—";
      const dim = score < MIN_LIFT_THRESHOLD ? "cal-row-dim" : "";
      return `<tr class="${dim}">
        <td>${escapeHtml(row.filterName)}</td>
        <td><span class="cal-knob-dir cal-dir-${escapeHtml(row.direction || "")}">${escapeHtml(row.direction || "—")}</span></td>
        ${EXIT_KPIS.map((k) => deltaCell(lift[k])).join("")}
        <td>${escapeHtml(String(conf))}</td>
        <td><b>${score.toFixed(3)}</b></td>
      </tr>`;
    }).join("");
    return `
      <div class="cal-table-wrap">
        <table class="cal-lift-table">
          <thead><tr>
            <th>Knob</th><th>Dir</th>
            ${EXIT_KPIS.map((k) => `<th>${EXIT_HEAD[k]}</th>`).join("")}
            <th>CONF</th><th>SCORE</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (err) {
    return `<div class="error-banner">lift_matrix: ${escapeHtml(err.message)}</div>`;
  }
}

function aggregateClosures(closed) {
  const buckets = new Map();
  for (const p of closed) {
    const reason = p.closeReason ?? p.close_reason ?? "other";
    const e = buckets.get(reason) || { count: 0, sumPnl: 0, sumDur: 0 };
    e.count += 1;
    e.sumPnl += Number(p.realizedPnlUsd ?? p.realized_pnl_usd ?? 0);
    const dur = (Number(p.lastStateChangeTs ?? p.last_state_change_ts ?? 0) - Number(p.fillTs ?? p.fill_ts ?? 0)) / 1000;
    if (isFinite(dur) && dur > 0) e.sumDur += dur;
    buckets.set(reason, e);
  }
  const total = closed.length;
  const arr = Array.from(buckets.entries()).map(([reason, v]) => ({
    reason,
    count: v.count,
    pct: total ? v.count / total : 0,
    avgPnl: v.count ? v.sumPnl / v.count : 0,
    sumPnl: v.sumPnl,
    avgDurSec: v.count ? Math.round(v.sumDur / v.count) : 0,
  }));
  arr.sort((a, b) => b.count - a.count);
  return { rows: arr, total };
}

async function renderClosureDistribution(closed) {
  const { rows, total } = aggregateClosures(closed);
  if (total === 0) return `<div class="muted">no closed positions in window.</div>`;
  const max = Math.max(...rows.map((r) => r.count), 1);
  const tbody = rows.map((r) => {
    const widthPct = Math.round((r.count / max) * 100);
    const dur = r.avgDurSec >= 60 ? `${Math.round(r.avgDurSec / 60)}m` : `${r.avgDurSec}s`;
    return `<tr>
      <td><span class="badge badge-exit-${escapeHtml(r.reason)}">${escapeHtml(r.reason)}</span></td>
      <td>${r.count}</td>
      <td><div class="cal-distrib-bar"><div class="cal-distrib-fill" style="width:${widthPct}%"></div></div></td>
      <td>${(r.pct * 100).toFixed(1)}%</td>
      <td class="${r.avgPnl >= 0 ? "ok" : "bad"}">${fmt$(r.avgPnl)}</td>
      <td class="${r.sumPnl >= 0 ? "ok" : "bad"}">${fmt$(r.sumPnl)}</td>
      <td class="muted">${dur}</td>
    </tr>`;
  }).join("");
  return `
    <div class="cal-table-wrap">
      <table class="cal-distrib-table">
        <thead><tr><th>Reason</th><th>Count</th><th>Bar</th><th>%</th><th>Avg PnL</th><th>Sum PnL</th><th>Avg Dur</th></tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
}

function paramAnalysisCards(closed) {
  const groups = {
    tp: closed.filter((p) => /^tp/i.test(String(p.closeReason ?? ""))),
    sl: closed.filter((p) => /^sl/i.test(String(p.closeReason ?? ""))),
    trail: closed.filter((p) => /trail/i.test(String(p.closeReason ?? ""))),
    time: closed.filter((p) => /time|timeout|expir/i.test(String(p.closeReason ?? ""))),
  };
  function card(title, accent, list) {
    const sumPnl = list.reduce((acc, p) => acc + Number(p.realizedPnlUsd ?? 0), 0);
    const avgPnl = list.length ? sumPnl / list.length : 0;
    const wins = list.filter((p) => Number(p.realizedPnlUsd ?? 0) > 0).length;
    return `<div class="cal-status-card cal-accent-${accent}">
      <div class="cal-status-card-title">${escapeHtml(title)}</div>
      <div class="cal-status-card-row"><span>тригер</span><span class="cal-status-card-val">${list.length}</span></div>
      <div class="cal-status-card-row"><span>avg pnl</span><span class="cal-status-card-val ${avgPnl >= 0 ? "ok" : "bad"}">${fmt$(avgPnl)}</span></div>
      <div class="cal-status-card-row"><span>sum pnl</span><span class="cal-status-card-val ${sumPnl >= 0 ? "ok" : "bad"}">${fmt$(sumPnl)}</span></div>
      <div class="cal-status-card-row"><span>wins</span><span class="cal-status-card-val">${wins}/${list.length}</span></div>
    </div>`;
  }
  return `
    <div class="cal-status-row">
      ${card("TAKE PROFIT", "green", groups.tp)}
      ${card("STOP LOSS", "red", groups.sl)}
      ${card("TRAILING STOP", "orange", groups.trail)}
      ${card("TIME / DURATION", "blue", groups.time)}
    </div>`;
}

const PARAM_DEFAULTS = {
  takeProfit: 0.20,
  stopLoss: -0.15,
  stopLossEmergency: -0.17,
  trailActivate: 0.15,
  trailStop: -0.05,
  ceilingTpPrice: 0.97,
  minSlAgeSec: 300,
  drawdownMin: -0.15,
  drawdownReduce: 0.5,
  timeExitSec: null,
};

async function renderCurrentParams() {
  try {
    const cur = await fetchJson("/api/exit_config");
    const eff = cur.effective || cur;
    const rows = Object.entries(PARAM_DEFAULTS).map(([key, def]) => {
      const value = eff[key];
      const status = value === undefined || value === null ? "—" : (Number(value) === Number(def) ? "✓" : "·");
      return `<tr>
        <td>${escapeHtml(key)}</td>
        <td>${value === undefined || value === null ? "—" : escapeHtml(String(value))}</td>
        <td class="muted">${def === null ? "—" : escapeHtml(String(def))}</td>
        <td>${status}</td>
      </tr>`;
    }).join("");
    return `<div class="cal-table-wrap"><table class="cal-params-table">
      <thead><tr><th>Param</th><th>Current</th><th>Default</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  } catch (err) {
    return `<div class="error-banner">exit_config: ${escapeHtml(err.message)}</div>`;
  }
}

export async function render(container) {
  container.innerHTML = `<div class="muted">loading Exit…</div>`;
  let history = { positions: [] };
  try {
    history = await fetchJson("/api/history?windowHours=168");
  } catch { /* ignore */ }
  const closed = history.positions ?? history.closed ?? history.rows ?? [];

  const [lift, distrib, params] = await Promise.all([
    renderLiftMatrix(),
    renderClosureDistribution(closed),
    renderCurrentParams(),
  ]);
  const analysis = paramAnalysisCards(closed);

  container.innerHTML = `
    <section class="card">
      <div class="card-title">LIFT MATRIX — EXIT</div>
      ${lift}
    </section>
    <section class="card">
      <div class="card-title">РОЗПОДІЛ ВИХОДІВ (7d)</div>
      ${distrib}
    </section>
    <section class="card">
      <div class="card-title">АНАЛІЗ ПАРАМЕТРІВ</div>
      ${analysis}
    </section>
    <section class="card">
      <div class="card-title">ПОТОЧНІ ПАРАМЕТРИ</div>
      ${params}
    </section>
  `;
}
