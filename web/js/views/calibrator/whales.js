"use strict";
import { fetchJson } from "../../api.js";
import { escapeHtml, fmt$ } from "../../format.js";

// Calibrator-side Whales — per-whale PnL aggregation derived from positions
// joined with whale registry. Distinct from the main Whales tab (which is a
// directory). Filter chips by trust class.

const TRUST_CLASSES = ["informed", "sniper", "accumulator", "copycat", "noise"];
let activeClass = null; // null = all

function shorten(addr) {
  if (!addr) return "—";
  return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

async function aggregate() {
  const [whalesData, history] = await Promise.all([
    fetchJson("/api/whales?limit=500").catch(() => ({ whales: [] })),
    fetchJson("/api/history?windowHours=720").catch(() => ({ positions: [] })),
  ]);
  const whales = whalesData.whales ?? whalesData.rows ?? [];
  const positions = history.positions ?? history.closed ?? history.rows ?? [];
  const whaleMap = new Map();
  for (const w of whales) {
    const addr = (w.address ?? w.wallet ?? "").toLowerCase();
    if (addr) whaleMap.set(addr, w);
  }
  const stats = new Map();
  for (const p of positions) {
    const addr = String(
      p.whaleAddress
        ?? p.whale_address
        ?? p.payload?.whaleAddress
        ?? p.payload?.whale_address
        ?? ""
    ).toLowerCase();
    if (!addr) continue;
    const e = stats.get(addr) || { addr, trades: 0, wins: 0, pnl: 0 };
    e.trades += 1;
    const pnl = Number(p.realizedPnlUsd ?? p.realized_pnl_usd ?? 0);
    e.pnl += pnl;
    if (pnl > 0) e.wins += 1;
    stats.set(addr, e);
  }
  const rows = Array.from(stats.values()).map((e) => {
    const w = whaleMap.get(e.addr) ?? {};
    return {
      ...e,
      trustScore: Number(w.trustScore ?? w.trust_score ?? 0),
      trustClass: w.trustClass ?? w.trust_class ?? "noise",
      winRate: e.trades ? e.wins / e.trades : 0,
    };
  });
  rows.sort((a, b) => b.pnl - a.pnl);
  return rows;
}

function classCounts(rows) {
  const counts = Object.fromEntries(TRUST_CLASSES.map((c) => [c, 0]));
  for (const r of rows) {
    if (counts[r.trustClass] !== undefined) counts[r.trustClass] += 1;
  }
  return counts;
}

function renderTable(rows) {
  if (rows.length === 0) {
    return `<div class="muted">no whale-tagged positions in window.</div>`;
  }
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.pnl)), 1);
  return `
    <div class="cal-table-wrap">
      <table class="cal-whales-table">
        <thead><tr>
          <th>#</th><th>Гаманець</th><th>Угод</th><th>WR</th><th>TRUST</th>
          <th>Клас</th><th>PnL</th><th>Performance</th>
        </tr></thead>
        <tbody>
          ${rows.map((r, i) => {
            const pct = Math.round((Math.abs(r.pnl) / maxAbs) * 100);
            const fillClass = r.pnl >= 0 ? "cal-perf-pos" : "cal-perf-neg";
            return `<tr>
              <td>${i + 1}</td>
              <td><code>${escapeHtml(shorten(r.addr))}</code></td>
              <td>${r.trades}</td>
              <td>${(r.winRate * 100).toFixed(0)}%</td>
              <td>${r.trustScore.toFixed(2)}</td>
              <td><span class="cal-trust-badge cal-trust-${escapeHtml(r.trustClass)}">${escapeHtml(r.trustClass)}</span></td>
              <td class="${r.pnl >= 0 ? "ok" : "bad"}"><b>${fmt$(r.pnl)}</b></td>
              <td><div class="cal-perf-bar"><div class="cal-perf-fill ${fillClass}" style="width:${pct}%"></div></div></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

export async function render(container) {
  container.innerHTML = `<div class="muted">loading Whales…</div>`;
  const all = await aggregate();
  const counts = classCounts(all);

  function paint() {
    const filtered = activeClass ? all.filter((r) => r.trustClass === activeClass) : all;
    const chips = `
      <div class="cal-filter-chips">
        <button class="cal-chip ${activeClass === null ? "active" : ""}" data-cls="">all <span class="muted">${all.length}</span></button>
        ${TRUST_CLASSES.map((c) =>
          `<button class="cal-chip cal-trust-${c} ${activeClass === c ? "active" : ""}" data-cls="${c}">${c} <span class="muted">${counts[c]}</span></button>`
        ).join("")}
      </div>`;
    container.innerHTML = `
      <section class="card">
        <div class="card-title">WHALES — PnL по класам довіри</div>
        ${chips}
        ${renderTable(filtered)}
      </section>`;
    container.querySelectorAll(".cal-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cls = btn.getAttribute("data-cls");
        activeClass = cls || null;
        paint();
      });
    });
  }

  paint();
}
