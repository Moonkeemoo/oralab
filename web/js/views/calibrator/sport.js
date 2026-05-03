"use strict";
import { fetchJson } from "../../api.js";
import { escapeHtml, fmt$ } from "../../format.js";

// Спорт sub-tab — two views:
//   A. Per-sport KPI table (24h)
//   B. Hour-of-day heatmap (7d, sport×hour)
// Heatmap toggle: PNL ($) / WIN RATE (%) / КІЛЬКІСТЬ.

let metric = "pnl"; // pnl | wr | count

function sportBadge(name) {
  const lc = String(name || "").toLowerCase();
  return `<span class="cal-sport-badge cal-sport-${escapeHtml(lc)}">${escapeHtml(name)}</span>`;
}

async function renderSportTable() {
  try {
    const data = await fetchJson("/api/calibrator/sport?windowHours=24");
    const sports = data.sports ?? [];
    if (sports.length === 0) return `<div class="muted">no closed positions in last 24h.</div>`;
    const maxAbs = Math.max(...sports.map((s) => Math.abs(Number(s.netPnl ?? 0))), 1);
    const rows = sports.map((s) => {
      const pnl = Number(s.netPnl ?? 0);
      const pct = Math.round((Math.abs(pnl) / maxAbs) * 100);
      const fillClass = pnl >= 0 ? "cal-perf-pos" : "cal-perf-neg";
      const dur = s.avgDurSec ? `${Math.round(s.avgDurSec / 60)}m` : "—";
      return `<tr>
        <td>${sportBadge(s.sport)}</td>
        <td>${s.trades}</td>
        <td class="ok">${s.wins}</td>
        <td class="bad">${s.losses}</td>
        <td class="${pnl >= 0 ? "ok" : "bad"}"><b>${fmt$(pnl)}</b></td>
        <td>${(Number(s.winRate) * 100).toFixed(0)}%</td>
        <td>${(Number(s.tpPct) * 100).toFixed(0)}%</td>
        <td>${(Number(s.slPct) * 100).toFixed(0)}%</td>
        <td>${dur}</td>
        <td>$${Number(s.avgStakeUsd ?? 0).toFixed(2)}</td>
        <td><div class="cal-perf-bar"><div class="cal-perf-fill ${fillClass}" style="width:${pct}%"></div></div></td>
      </tr>`;
    }).join("");
    return `
      <div class="cal-table-wrap">
        <table class="cal-sport-table">
          <thead><tr>
            <th>Спорт</th><th>Угод</th><th>Win</th><th>Loss</th><th>NET PNL</th>
            <th>WR</th><th>TP%</th><th>SL%</th><th>Сер.час</th><th>Сер.ставка</th><th>Performance</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (err) {
    return `<div class="error-banner">sport: ${escapeHtml(err.message)}</div>`;
  }
}

function fmtCell(v, m) {
  if (v === undefined || v === null) return "—";
  if (m === "pnl") return fmt$(Number(v));
  if (m === "wr") return `${Math.round(Number(v) * 100)}%`;
  return String(Math.round(Number(v)));
}

function cellShade(v, m, range) {
  if (v === undefined || v === null) return "cal-heat-empty";
  const n = Number(v);
  if (m === "wr") {
    if (n >= 0.6) return "cal-heat-pos-3";
    if (n >= 0.5) return "cal-heat-pos-2";
    if (n >= 0.4) return "cal-heat-pos-1";
    return "cal-heat-neg-2";
  }
  if (m === "count") {
    const t = range > 0 ? n / range : 0;
    if (t > 0.66) return "cal-heat-pos-3";
    if (t > 0.33) return "cal-heat-pos-2";
    return "cal-heat-pos-1";
  }
  // pnl
  if (n > 0) {
    if (n > range * 0.66) return "cal-heat-pos-3";
    if (n > range * 0.33) return "cal-heat-pos-2";
    return "cal-heat-pos-1";
  }
  if (n < 0) {
    if (n < -range * 0.66) return "cal-heat-neg-3";
    if (n < -range * 0.33) return "cal-heat-neg-2";
    return "cal-heat-neg-1";
  }
  return "cal-heat-zero";
}

async function renderHeatmap() {
  try {
    const data = await fetchJson(`/api/calibrator/sport/heatmap?days=7&metric=${metric}`);
    const sports = data.sports ?? [];
    const hours = data.hours ?? Array.from({ length: 24 }, (_, i) => i);
    const cells = data.cells ?? {};
    if (sports.length === 0) return `<div class="muted">no heatmap data in last 7 days.</div>`;
    const allValues = Object.values(cells).map((v) => Math.abs(Number(v))).filter((n) => isFinite(n));
    const range = Math.max(1, ...allValues);

    const head = `<thead><tr>
      <th></th>
      ${hours.map((h) => `<th>${String(h).padStart(2, "0")}</th>`).join("")}
    </tr></thead>`;
    const body = `<tbody>
      ${sports.map((s) => `<tr>
        <td>${sportBadge(s)}</td>
        ${hours.map((h) => {
          const v = cells[`${s}_${h}`];
          const cls = cellShade(v, metric, range);
          const txt = v === undefined ? "—" : fmtCell(v, metric);
          return `<td class="cal-heat-cell ${cls}">${escapeHtml(txt)}</td>`;
        }).join("")}
      </tr>`).join("")}
    </tbody>`;

    return `
      <div class="cal-heat-toggles">
        ${["pnl", "wr", "count"].map((m) =>
          `<button class="cal-chip ${metric === m ? "active" : ""}" data-metric="${m}">${m === "pnl" ? "PNL ($)" : m === "wr" ? "WIN RATE" : "КІЛЬКІСТЬ"}</button>`
        ).join("")}
      </div>
      <div class="cal-table-wrap"><table class="cal-heatmap">${head}${body}</table></div>`;
  } catch (err) {
    return `<div class="error-banner">heatmap: ${escapeHtml(err.message)}</div>`;
  }
}

export async function render(container) {
  async function paint() {
    container.innerHTML = `<div class="muted">loading Спорт…</div>`;
    const [table, heatmap] = await Promise.all([renderSportTable(), renderHeatmap()]);
    container.innerHTML = `
      <section class="card">
        <div class="card-title">АНАЛІТИКА ПО СПОРТУ (24h)</div>
        ${table}
      </section>
      <section class="card">
        <div class="card-title">HOUR-OF-DAY HEATMAP (7d)</div>
        ${heatmap}
      </section>
    `;
    container.querySelectorAll("[data-metric]").forEach((btn) => {
      btn.addEventListener("click", () => {
        metric = btn.getAttribute("data-metric");
        paint();
      });
    });
  }
  await paint();
}
