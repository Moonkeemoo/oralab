"use strict";
import { fetchJson } from "../../api.js";
import { escapeHtml, fmt$ } from "../../format.js";

// Entry sub-tab — three sections:
//   1. LIFT MATRIX (per-lever per-KPI deltas + score). Sourced from
//      /api/calibrator/lift_matrix?phase=entry.
//   2. $ ВАРТІСТЬ ФІЛЬТРІВ — counterfactual saved/lost net per filter.
//   3. БАЙЕСІВСЬКА ВПЕВНЕНІСТЬ — Beta(α,β) confidence per filter with
//      stable/exploring/uncertain badges.

const DELTA_KPIS = ["win_rate", "profit_factor", "avg_pnl", "pass_rate", "sl_rate", "tp_hit_rate", "exit_efficiency", "left_on_table"];
const KPI_HEAD = { win_rate: "Δ WR", profit_factor: "Δ PF", avg_pnl: "Δ AVG_PNL", pass_rate: "Δ PASS_RATE", sl_rate: "Δ SL_RATE", tp_hit_rate: "Δ TP", exit_efficiency: "Δ EFF", left_on_table: "Δ LOT" };
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
    const data = await fetchJson("/api/calibrator/lift_matrix?phase=entry");
    const matrix = data.matrix ?? [];
    if (matrix.length === 0) {
      return `<div class="muted">no entry-side lift recommendations in last cycle.</div>`;
    }
    const rows = matrix.map((row) => {
      const lift = row.lift || {};
      const score = Number(row.score ?? 0);
      const conf = row.confidence ?? row.beliefStatus ?? "—";
      const sportBadge = row.sport ? `<span class="cal-sport-badge cal-sport-${escapeHtml(row.sport).toLowerCase()}">🏷️ ${escapeHtml(row.sport)}</span>` : "";
      const dim = score < MIN_LIFT_THRESHOLD ? "cal-row-dim" : "";
      const okScore = score >= MIN_LIFT_THRESHOLD ? "cal-row-strong" : "";
      return `<tr class="${dim} ${okScore}">
        <td>${escapeHtml(row.filterName)} ${sportBadge}</td>
        ${DELTA_KPIS.map((k) => deltaCell(lift[k])).join("")}
        <td>${escapeHtml(String(conf))}</td>
        <td><b>${score.toFixed(3)}</b></td>
      </tr>`;
    }).join("");
    return `
      <div class="cal-table-wrap">
        <table class="cal-lift-table">
          <thead><tr>
            <th>Lever</th>
            ${DELTA_KPIS.map((k) => `<th>${KPI_HEAD[k]}</th>`).join("")}
            <th>CONF</th><th>SCORE</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  } catch (err) {
    return `<div class="error-banner">lift_matrix: ${escapeHtml(err.message)}</div>`;
  }
}

async function renderAttribution() {
  try {
    const data = await fetchJson("/api/calibrator/attribution?windowHours=24");
    const list = data.attribution ?? [];
    if (list.length === 0) return `<div class="muted">no counterfactual attribution data.</div>`;
    const sorted = [...list].sort((a, b) =>
      Number((b.savedUsd ?? 0) - (b.lostUsd ?? 0)) - Number((a.savedUsd ?? 0) - (a.lostUsd ?? 0))
    );
    const rows = sorted.map((r) => {
      const saved = Number(r.savedUsd ?? r.saved ?? 0);
      const lost = Number(r.lostUsd ?? r.lost ?? 0);
      const net = saved - lost;
      const cls = net > 0 ? "ok" : net < 0 ? "bad" : "muted";
      return `<tr>
        <td>${escapeHtml(r.rejectKey ?? r.filterName ?? "—")}</td>
        <td class="ok">${fmt$(saved)}</td>
        <td class="bad">${fmt$(-lost)}</td>
        <td class="${cls}"><b>${fmt$(net)}</b></td>
        <td>${Number(r.rejectCount ?? r.dataPoints ?? 0)}</td>
      </tr>`;
    }).join("");
    return `
      <div class="cal-table-wrap">
        <table class="cal-attr-table">
          <thead><tr><th>Filter</th><th>Saved $</th><th>Lost $</th><th>Net $</th><th>Rejects</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  } catch (err) {
    return `<div class="error-banner">attribution: ${escapeHtml(err.message)}</div>`;
  }
}

async function renderBeliefs() {
  try {
    const data = await fetchJson("/api/calibrator/beliefs");
    const list = data.beliefs ?? [];
    if (list.length === 0) return `<div class="muted">no bayesian belief data yet — needs apply outcomes.</div>`;
    const rows = list.map((b) => {
      const conf = Number(b.confidence ?? 0);
      const status = b.status ?? (conf >= 0.7 ? "stable" : conf >= 0.5 ? "exploring" : "uncertain");
      const pct = Math.round(conf * 100);
      return `<tr>
        <td>${escapeHtml(b.rejectKey ?? b.filterName ?? "—")}</td>
        <td>${Number(b.alpha ?? 0).toFixed(1)}</td>
        <td>${Number(b.beta ?? 0).toFixed(1)}</td>
        <td>
          <div class="cal-confidence-bar"><div class="cal-confidence-fill" style="width:${pct}%"></div></div>
          <span class="muted">${(conf * 100).toFixed(0)}%</span>
        </td>
        <td><span class="cal-status cal-status-${escapeHtml(status)}">${escapeHtml(status)}</span></td>
      </tr>`;
    }).join("");
    return `
      <div class="cal-table-wrap">
        <table class="cal-beliefs-table">
          <thead><tr><th>Filter</th><th>α</th><th>β</th><th>Confidence</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  } catch (err) {
    return `<div class="error-banner">beliefs: ${escapeHtml(err.message)}</div>`;
  }
}

export async function render(container) {
  container.innerHTML = `<div class="muted">loading Entry…</div>`;
  const [lift, attr, beliefs] = await Promise.all([
    renderLiftMatrix(),
    renderAttribution(),
    renderBeliefs(),
  ]);
  container.innerHTML = `
    <section class="card">
      <div class="card-title">LIFT MATRIX — ENTRY</div>
      ${lift}
    </section>
    <section class="card">
      <div class="card-title">$ ВАРТІСТЬ ФІЛЬТРІВ</div>
      ${attr}
    </section>
    <section class="card">
      <div class="card-title">БАЙЕСІВСЬКА ВПЕВНЕНІСТЬ</div>
      ${beliefs}
    </section>
  `;
}
