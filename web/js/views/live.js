"use strict";
import { fetchJson, postJson } from "../api.js";
import { escapeHtml, fmt$, fmtAge, fmtPct } from "../format.js";
import { openPositionSheet } from "../sheets/position.js";

// ─────────────────────────────────────────────────────────────────────
// Live tab — v1 dashboard parity. Six KPI cards on top (Balance / PnL /
// Entry / Exit / Performance / Technical), then an active-positions table
// with mini sparkline + outcome name + resolves text, then a collapsible
// closed-positions section with exit-reason badges. Fast polling for live
// rows (2s), slower polling for KPI/PnL/history (10s).
// ─────────────────────────────────────────────────────────────────────

let pnlWindow = "all"; // "today" | "week" | "all" — drives PnL card sparkline
let closedExpanded = false;

export async function renderLive(root) {
  root.innerHTML = `
    <section class="kpi-row">
      <div class="kpi-card kpi-balance" id="card-balance"><div class="kpi-load">…</div></div>
      <div class="kpi-card kpi-pnl" id="card-pnl"><div class="kpi-load">…</div></div>
      <div class="kpi-card kpi-entry" id="card-entry"><div class="kpi-load">…</div></div>
      <div class="kpi-card kpi-exit" id="card-exit"><div class="kpi-load">…</div></div>
      <div class="kpi-card kpi-perf" id="card-perf"><div class="kpi-load">…</div></div>
      <div class="kpi-card kpi-tech" id="card-tech"><div class="kpi-load">…</div></div>
    </section>

    <section class="card" id="active-card">
      <div class="card-title">Active positions <span id="active-count" class="muted"></span></div>
      <div id="active-body" class="pos-table">…</div>
    </section>

    <section class="card" id="closed-card">
      <div class="card-title closed-toggle" id="closed-toggle" role="button">
        Closed positions <span id="closed-count" class="muted"></span>
        <span class="closed-arrow" id="closed-arrow">▸</span>
      </div>
      <div id="closed-body" class="pos-table closed-collapsed">…</div>
    </section>

    <div class="actions">
      <button id="pause-btn" class="btn btn-warn">Pause</button>
      <button id="resume-btn" class="btn btn-ok">Resume</button>
    </div>
  `;

  document.getElementById("pause-btn").onclick = async () => {
    await postJson("/api/kill_switch", { active: true, reason: "mini_app" });
    await loadFast();
  };
  document.getElementById("resume-btn").onclick = async () => {
    await postJson("/api/kill_switch", { active: false, reason: "mini_app" });
    await loadFast();
  };

  document.getElementById("closed-toggle").onclick = () => {
    closedExpanded = !closedExpanded;
    const body = document.getElementById("closed-body");
    const arrow = document.getElementById("closed-arrow");
    if (!body || !arrow) return;
    body.classList.toggle("closed-collapsed", !closedExpanded);
    arrow.textContent = closedExpanded ? "▾" : "▸";
    if (closedExpanded) loadHistory().catch(() => {});
  };

  await Promise.all([loadFast(), loadSlow()]);

  const fast = setInterval(loadFast, 2000);
  const slow = setInterval(loadSlow, 10000);
  const observer = new MutationObserver(() => {
    if (!document.getElementById("card-balance")) {
      clearInterval(fast);
      clearInterval(slow);
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById("view"), { childList: true });
}

async function loadFast() {
  await Promise.all([loadBalance(), loadPositions()]);
}

async function loadSlow() {
  await Promise.all([loadKpi(), loadPnl(), loadFilters()]);
  if (closedExpanded) await loadHistory();
}

// ─── Card 1: Balance ───────────────────────────────────────────────
async function loadBalance() {
  const card = document.getElementById("card-balance");
  if (!card) return;
  let b;
  try { b = await fetchJson("/api/balance"); } catch (err) { card.innerHTML = errBlock("balance", err); return; }
  if (b.error) { card.innerHTML = errBlock("balance", b.error); return; }
  const total = (b.totalBudgetUsd ?? 0);
  const positions = (b.allocatedUsd ?? 0);
  const free = (b.freeUsd ?? b.pUsdAvailable ?? 0);
  const pct = total > 0 ? Math.min(100, (positions / total) * 100) : 0;
  card.innerHTML = `
    <div class="kpi-head">
      <span class="kpi-label">Balance</span>
      <a class="kpi-action" href="${escapeHtml(b.topUpUrl ?? "#")}" target="_blank" rel="noopener">↑ Top Up</a>
    </div>
    <div class="kpi-big">$${total.toFixed(2)}</div>
    <div class="kpi-split">
      <span class="dot dot-blue"></span>Positions $${positions.toFixed(2)}
      <span class="dot dot-green"></span>Available $${free.toFixed(2)}
    </div>
    <div class="kpi-bar"><div class="kpi-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
    <div class="kpi-footer">
      <span class="badge ${b.phantomCount ? "badge-warn" : ""}">${b.phantomCount ?? 0} phantom</span>
      <span class="badge ${b.untrackedCount ? "badge-warn" : ""}">${b.untrackedCount ?? 0} untracked</span>
      <span class="muted">${escapeHtml(b.mode ?? "")}</span>
    </div>
  `;
}

// ─── Card 2: PnL ───────────────────────────────────────────────────
async function loadPnl() {
  const card = document.getElementById("card-pnl");
  if (!card) return;
  let p;
  try { p = await fetchJson("/api/pnl?windowHours=720"); } catch (err) { card.innerHTML = errBlock("pnl", err); return; }
  const today = p.today ?? 0;
  const week = p.week ?? 0;
  const all = p.all ?? 0;
  const v = pnlWindow === "today" ? today : pnlWindow === "week" ? week : all;
  const cls = v >= 0 ? "pnl-up" : "pnl-down";
  const series = (p.timeseries ?? []).map((t) => Number(t.cumulativeUsd ?? 0));
  card.innerHTML = `
    <div class="kpi-head">
      <span class="kpi-label">Profit &amp; Loss</span>
    </div>
    <div class="kpi-big ${cls}">${fmt$(v)}</div>
    <div class="kpi-toggle-row">
      <button class="toggle ${pnlWindow === "today" ? "active" : ""}" data-w="today">TODAY ${fmt$(today)}</button>
      <button class="toggle ${pnlWindow === "week" ? "active" : ""}" data-w="week">WEEK ${fmt$(week)}</button>
      <button class="toggle ${pnlWindow === "all" ? "active" : ""}" data-w="all">ALL ${fmt$(all)}</button>
    </div>
    <div class="kpi-spark">${sparklineSvg(series, 220, 36, v >= 0 ? "var(--ok)" : "var(--bad)")}</div>
  `;
  card.querySelectorAll(".toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      pnlWindow = btn.getAttribute("data-w");
      loadPnl();
    });
  });
}

// ─── Card 3: Entry ─────────────────────────────────────────────────
async function loadKpi() {
  const card = document.getElementById("card-entry");
  if (!card) return;
  let k;
  try { k = await fetchJson("/api/kpi?windowHours=24"); } catch (err) {
    card.innerHTML = errBlock("entry", err);
    document.getElementById("card-exit").innerHTML = errBlock("exit", err);
    document.getElementById("card-perf").innerHTML = errBlock("perf", err);
    document.getElementById("card-tech").innerHTML = errBlock("tech", err);
    return;
  }
  const passClass = k.passRatePct >= 1 ? "pnl-up" : "pnl-down";
  card.innerHTML = `
    <div class="kpi-head"><span class="kpi-label">Entry</span></div>
    <div class="kpi-mini-grid">
      ${miniStat("PASS RATE", `${(k.passRatePct ?? 0).toFixed(1)}%`, `${k.signalsAccepted ?? 0} / ${k.signalsTotal ?? 0}`, passClass)}
      ${miniStat("TOP REJECTION", k.topRejection ? escapeHtml(String(k.topRejection)) : "—", `${k.topRejectionCount ?? 0} hits`, "warn")}
      ${miniStat("SIGNALS/HR", `${Math.round(k.signalsPerHour ?? 0)}`, `~${Math.round((k.signalsPerHour ?? 0) * 24)}/day`, "")}
      ${miniStat("CF NET", fmt$(k.cfNetUsd ?? 0), `${fmt$(k.cfSavedUsd ?? 0)} saved`, (k.cfNetUsd ?? 0) >= 0 ? "pnl-up" : "pnl-down")}
    </div>
  `;
  // Exit, Perf, Tech share /api/kpi response
  renderExitCard(k);
  renderPerfCard(k);
  renderTechCard(k);
}

function renderExitCard(k) {
  const card = document.getElementById("card-exit");
  if (!card) return;
  const tp = k.tpHitRatePct ?? 0;
  const sl = k.slRatePct ?? 0;
  const eff = k.exitEfficiencyPct ?? 0;
  const lot = k.leftOnTableUsd ?? 0;
  const tpClass = tp >= 35 ? "pnl-up" : "warn";
  const slClass = sl < 30 ? "pnl-up" : "warn";
  const effClass = eff >= 100 ? "pnl-up" : eff >= 50 ? "warn" : "pnl-down";
  card.innerHTML = `
    <div class="kpi-head"><span class="kpi-label">Exit</span></div>
    <div class="kpi-mini-grid">
      ${miniStat("TP HIT RATE", `${tp.toFixed(1)}%`, "target ≥35%", tpClass)}
      ${miniStat("SL RATE", `${sl.toFixed(1)}%`, "target &lt;30%", slClass)}
      ${miniStat("EXIT EFF.", `${eff.toFixed(1)}%`, "realised / peak", effClass)}
      ${miniStat("LEFT ON TABLE", fmt$(-Math.abs(lot)), "unrealised upside", "pnl-down")}
    </div>
  `;
}

function renderPerfCard(k) {
  const card = document.getElementById("card-perf");
  if (!card) return;
  const wr = k.winRatePct ?? 0;
  const pf = k.profitFactor;
  const dd = k.drawdownUsd ?? 0;
  const wins = k.winsCount ?? 0;
  const losses = k.lossesCount ?? 0;
  const wrClass = wr >= 50 ? "pnl-up" : wr >= 40 ? "warn" : "pnl-down";
  const pfClass = (pf ?? 0) >= 1.2 ? "pnl-up" : (pf ?? 0) >= 1 ? "warn" : "pnl-down";
  const pfStr = pf == null || !isFinite(pf) ? "—" : pf.toFixed(2);
  card.innerHTML = `
    <div class="kpi-head"><span class="kpi-label">Performance</span></div>
    <div class="kpi-mini-grid">
      ${miniStat("WIN RATE", `${wr.toFixed(0)}%`, `${wins}W ${losses}L`, wrClass)}
      ${miniStat("PROFIT FACTOR", pfStr, `$${(k.grossWinUsd ?? 0).toFixed(2)}W / $${(k.grossLossUsd ?? 0).toFixed(2)}L`, pfClass)}
      ${miniStat("AVG PNL/TRADE", fmt$(k.avgPnlPerTradeUsd ?? 0), `${k.closedCount ?? 0} closed`, (k.avgPnlPerTradeUsd ?? 0) >= 0 ? "pnl-up" : "pnl-down")}
      ${miniStat("MAX DRAWDOWN", fmt$(-Math.abs(dd)), "peak → trough", "pnl-down")}
    </div>
  `;
}

function renderTechCard(k) {
  const card = document.getElementById("card-tech");
  if (!card) return;
  const dur = k.avgDurationSec ?? 0;
  const expPct = (k.exposurePct ?? 0) * 100;
  card.innerHTML = `
    <div class="kpi-head"><span class="kpi-label">Technical</span></div>
    <div class="kpi-mini-grid">
      ${miniStat("AVG LATENCY", "—", "deferred", "muted-stat")}
      ${miniStat("AVG DURATION", `${(dur / 60).toFixed(0)}m`, `${k.closedCount ?? 0} closed · ${k.openPositionCount ?? 0} open`, "")}
      ${miniStat("EXPOSURE", `${expPct.toFixed(0)}%`, `$${(k.exposureUsd ?? 0).toFixed(2)} / $${(k.totalBudgetUsd ?? 0).toFixed(2)}`, "")}
      ${miniStat("OPEN POS.", `${k.openPositionCount ?? 0}`, `position${(k.openPositionCount ?? 0) === 1 ? "" : "s"}`, "")}
    </div>
  `;
}

async function loadFilters() {
  // No-op now — top rejection comes from /api/kpi. Kept stub for symmetry / future
  // breakdown chart in a sheet drilldown.
}

// ─── Active positions table ────────────────────────────────────────
async function loadPositions() {
  const body = document.getElementById("active-body");
  const count = document.getElementById("active-count");
  if (!body) return;
  let list;
  try { list = await fetchJson("/api/positions"); } catch (err) { body.innerHTML = errBlock("positions", err); return; }
  if (count) count.textContent = `(${list.length})`;
  if (list.length === 0) {
    body.innerHTML = '<div class="muted" style="padding:8px 0">No active positions</div>';
    return;
  }
  body.innerHTML = list.map(activeRowHtml).join("");
  body.querySelectorAll(".pos-row-card").forEach((el) => {
    el.addEventListener("click", () => openPositionSheet(Number(el.getAttribute("data-id"))));
  });
}

function activeRowHtml(p) {
  const cur = p.currentPrice;
  const pnl = p.currentPnlUsd;
  const pnlPct = p.currentPnlPct;
  const pnlCls = pnl == null ? "" : pnl >= 0 ? "pnl-up" : "pnl-down";
  const pnlStr = pnl == null
    ? '<span class="muted">no mark</span>'
    : `${fmt$(pnl)}<br><small>${fmtPct(pnlPct ?? 0)}</small>`;
  const dur = fmtAge(p.durationMs ?? 0);
  const fillTime = p.fillTs ? new Date(p.fillTs).toISOString().slice(11, 19) : "—";
  const sideBadge = sideBadgeHtml(p);
  const resolves = p.resolvesText ?? "—";
  const resolveCls = /overdue/i.test(resolves) ? "bad" : /resolved/i.test(resolves) ? "muted" : "";
  const title = p.marketTitle ? escapeHtml(p.marketTitle) : `<code>${escapeHtml(String(p.assetId).slice(0, 14))}…</code>`;
  const spark = sparklineSvg(p.priceChartPoints ?? [], 80, 24, pnl == null || pnl >= 0 ? "var(--ok)" : "var(--bad)");
  const drift = p.driftStatus && p.driftStatus !== "ok"
    ? `<div class="pos-drift drift-${p.driftStatus}">⚠ chain drift ${p.driftPct != null ? (p.driftPct * 100).toFixed(2) + "%" : ""}</div>`
    : "";
  return `
    <div class="pos-row-card" data-id="${p.id}" role="button">
      <div class="pos-row-top">
        <span class="pos-time">${fillTime}</span>
        <span class="pos-mode mode-${(p.mode || "").toLowerCase()}">${escapeHtml(p.mode || "")}</span>
        <span class="pos-title">${title}</span>
        ${sideBadge}
        <span class="pos-resolves ${resolveCls}">${escapeHtml(resolves)}</span>
      </div>
      <div class="pos-row-grid">
        <div class="cell"><div class="cell-label">ENTRY</div><div class="cell-val">${(p.fillPrice ?? 0).toFixed(3)}</div></div>
        <div class="cell"><div class="cell-label">NOW</div><div class="cell-val">${cur != null ? cur.toFixed(3) : "—"}</div></div>
        <div class="cell"><div class="cell-label">SHARES</div><div class="cell-val">${(p.shares ?? 0).toFixed(2)}</div></div>
        <div class="cell"><div class="cell-label">COST</div><div class="cell-val">$${(p.entryCostUsd ?? 0).toFixed(2)}</div></div>
        <div class="cell"><div class="cell-label">P&amp;L</div><div class="cell-val ${pnlCls}">${pnlStr}</div></div>
        <div class="cell cell-spark"><div class="cell-label">CHART</div><div class="cell-val">${spark}</div></div>
        <div class="cell"><div class="cell-label">DUR</div><div class="cell-val">${dur}</div></div>
      </div>
      ${drift}
    </div>`;
}

// ─── Closed positions ──────────────────────────────────────────────
async function loadHistory() {
  const body = document.getElementById("closed-body");
  const count = document.getElementById("closed-count");
  if (!body) return;
  let h;
  try { h = await fetchJson("/api/history?windowHours=720"); } catch (err) { body.innerHTML = errBlock("history", err); return; }
  const trades = h.trades ?? [];
  if (count) count.textContent = `(${trades.length})`;
  if (trades.length === 0) {
    body.innerHTML = '<div class="muted" style="padding:8px 0">No closed positions yet</div>';
    return;
  }
  body.innerHTML = trades.map(closedRowHtml).join("");
}

function closedRowHtml(t) {
  const reason = t.closeReasonLabel ?? "—";
  const icon = t.closeReasonIcon ?? "·";
  const family = t.closeReasonFamily ?? "other";
  const result = t.result ?? "break_even";
  const resultCls = result === "won" ? "badge-won" : result === "lost" ? "badge-lost" : "badge-neutral";
  const resultLabel = result === "won" ? "Won ✓" : result === "lost" ? "Lost ✗" : "Even";
  const pnlCls = (t.pnlUsd ?? 0) >= 0 ? "pnl-up" : "pnl-down";
  const closeTime = t.closeTs ? new Date(t.closeTs).toISOString().slice(11, 19) : "—";
  const dur = fmtAge(t.durationMs ?? 0);
  const sideBadge = sideBadgeHtml(t);
  const resolves = t.resolvesText ?? "—";
  const title = t.marketTitle ? escapeHtml(t.marketTitle) : `<code>${escapeHtml(String(t.assetId).slice(0, 14))}…</code>`;
  return `
    <div class="pos-row-card closed-row" data-id="${t.id}">
      <div class="pos-row-top">
        <span class="pos-time">${closeTime}</span>
        <span class="pos-mode mode-${(t.mode || "").toLowerCase()}">${escapeHtml(t.mode || "")}</span>
        <span class="pos-title">${title}</span>
        ${sideBadge}
        <span class="pos-resolves muted">${escapeHtml(resolves)}</span>
      </div>
      <div class="pos-row-grid">
        <div class="cell"><div class="cell-label">ENTRY</div><div class="cell-val">${(t.fillPrice ?? 0).toFixed(3)}</div></div>
        <div class="cell"><div class="cell-label">EXIT</div><div class="cell-val">${t.exitPrice != null ? Number(t.exitPrice).toFixed(3) : "—"}</div></div>
        <div class="cell"><div class="cell-label">SHARES</div><div class="cell-val">${(t.shares ?? 0).toFixed(2)}</div></div>
        <div class="cell"><div class="cell-label">COST</div><div class="cell-val">$${(t.entryUsd ?? 0).toFixed(2)}</div></div>
        <div class="cell"><div class="cell-label">P&amp;L</div><div class="cell-val ${pnlCls}">${fmt$(t.pnlUsd ?? 0)}<br><small>${fmtPct(t.pnlPct ?? 0)}</small></div></div>
        <div class="cell"><div class="cell-label">EXIT REASON</div><div class="cell-val"><span class="badge badge-exit-${family}">${icon} ${escapeHtml(reason)}</span></div></div>
        <div class="cell"><div class="cell-label">RESULT</div><div class="cell-val"><span class="badge ${resultCls}">${resultLabel}</span></div></div>
        <div class="cell"><div class="cell-label">DUR</div><div class="cell-val">${dur}</div></div>
      </div>
    </div>`;
}

// ─── Helpers ───────────────────────────────────────────────────────
function miniStat(label, value, sub, cls) {
  return `
    <div class="mini-stat">
      <div class="mini-label">${label}</div>
      <div class="mini-value ${cls || ""}">${value}</div>
      <div class="mini-sub">${sub}</div>
    </div>`;
}

function errBlock(name, err) {
  return `<div class="kpi-load bad">${escapeHtml(name)}: ${escapeHtml(String(err?.message || err || "error"))}</div>`;
}

function sideBadgeHtml(p) {
  const name = p.outcomeName ?? p.side ?? "—";
  const isYesNo = /^yes$|^no$/i.test(name);
  const cls = isYesNo
    ? (p.side === "YES" ? "side-yes" : "side-no")
    : "side-team";
  return `<span class="badge ${cls}">${escapeHtml(name)}</span>`;
}

function sparklineSvg(values, width, height, color) {
  if (!values || values.length === 0) return `<span class="muted">—</span>`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `
    <svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <polyline fill="none" stroke="${color}" stroke-width="1.5" points="${points}" />
    </svg>`;
}
