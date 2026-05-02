"use strict";
import { fetchJson, postJson } from "../api.js";
import { escapeHtml, fmtAge } from "../format.js";
import { openPositionSheet } from "../sheets/position.js";

export async function renderLive(root) {
  root.innerHTML = `
    <section class="card" id="balance-card"><div class="card-title">Balance</div><div class="card-body" id="balance-body">…</div></section>
    <section class="card" id="kpi-card"><div class="card-title">KPIs · 24h</div><div class="card-body" id="kpi-body">…</div></section>
    <section class="card" id="now-card"><div class="card-title">Now happening</div><div class="card-body" id="now-body">…</div></section>
    <section class="card" id="positions-card"><div class="card-title">Active positions</div><div class="card-body" id="positions-body">…</div></section>
    <section class="card" id="rejects-card"><div class="card-title">Recent rejects</div><div class="card-body" id="rejects-body">…</div></section>
    <div class="actions">
      <button id="pause-btn" class="btn btn-warn">⛔ Pause</button>
      <button id="resume-btn" class="btn btn-ok">✅ Resume</button>
    </div>
  `;
  await loadAll();
  const interval = setInterval(loadAll, 5000);
  const observer = new MutationObserver(() => {
    if (!document.getElementById("now-card")) {
      clearInterval(interval);
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById("view"), { childList: true });

  document.getElementById("pause-btn").onclick = async () => {
    await postJson("/api/kill_switch", { active: true, reason: "mini_app" });
    await loadAll();
  };
  document.getElementById("resume-btn").onclick = async () => {
    await postJson("/api/kill_switch", { active: false, reason: "mini_app" });
    await loadAll();
  };
}

async function loadAll() {
  await Promise.all([loadBalance(), loadKpis(), loadNow(), loadPositions(), loadRejects()]);
}

async function loadBalance() {
  const b = await fetchJson("/api/balance");
  const body = document.getElementById("balance-body");
  if (!body) return;
  if (b.error) {
    body.innerHTML = `<div class="bad">${b.error}</div>`;
    return;
  }
  body.innerHTML = `
    <div class="kv"><span class="k">mode</span><span class="v">${b.mode}</span></div>
    <div class="kv"><span class="k">free</span><span class="v"><b>$${(b.freeUsd ?? 0).toFixed(2)}</b></span></div>
    <div class="kv"><span class="k">allocated</span><span class="v">$${(b.allocatedUsd ?? 0).toFixed(2)}</span></div>
    <div class="kv"><span class="k">total budget</span><span class="v">$${(b.totalBudgetUsd ?? 0).toFixed(2)}</span></div>
    <div class="muted">${b.source}</div>
  `;
}

async function loadKpis() {
  const k = await fetchJson("/api/kpi?windowHours=24");
  document.getElementById("kpi-body").innerHTML = `
    <div class="kv"><span class="k">win rate</span><span class="v">${k.winRatePct.toFixed(1)}%</span></div>
    <div class="kv"><span class="k">profit factor</span><span class="v">${isFinite(k.profitFactor) && k.profitFactor !== null ? k.profitFactor.toFixed(2) : "—"}</span></div>
    <div class="kv"><span class="k">drawdown</span><span class="v bad">-$${k.drawdownUsd.toFixed(2)}</span></div>
    <div class="kv"><span class="k">avg hold</span><span class="v">${(k.avgHoldSec / 60).toFixed(1)} min</span></div>
    <div class="kv"><span class="k">pass rate</span><span class="v">${k.passRatePct.toFixed(1)}%</span></div>
    <div class="kv"><span class="k">signals/h</span><span class="v">${k.signalsPerHour.toFixed(0)}</span></div>
  `;
}

async function loadNow() {
  const conns = await fetchJson("/api/connections");
  const lastSig = conns.find((c) => c.source === "rtds_ws");
  const lastSports = conns.find((c) => c.source === "sports_ws");
  document.getElementById("now-body").innerHTML = `
    <div class="kv"><span class="k">last whale signal</span><span class="v">${fmtAge(lastSig?.ageMs ?? Infinity)}</span></div>
    <div class="kv"><span class="k">last sports event</span><span class="v">${fmtAge(lastSports?.ageMs ?? Infinity)}</span></div>
  `;
}

async function loadPositions() {
  const list = await fetchJson("/api/positions");
  const body = document.getElementById("positions-body");
  if (list.length === 0) { body.innerHTML = '<span class="muted">no active positions</span>'; return; }
  body.innerHTML = list.map((p) => `
    <div class="pos" data-id="${p.id}" role="button">
      <div class="pos-head">
        <span class="pos-id">#${p.id} ▶</span>
        <span class="pos-status ${p.status}">${p.status}</span>
      </div>
      <div class="pos-row">
        <span><b>${(p.shares || 0).toFixed(3)}</b> sh</span>
        <span>fill <b>${(p.fillPrice || 0).toFixed(3)}</b></span>
        <span>peak <b>${(p.peakPrice || 0).toFixed(3)}</b></span>
        <span>sweep <b>${p.sweepCount || 0}</b></span>
      </div>
    </div>
  `).join("");
  body.querySelectorAll(".pos").forEach((el) => {
    el.addEventListener("click", () => openPositionSheet(Number(el.getAttribute("data-id"))));
  });
}

async function loadRejects() {
  const stats = await fetchJson("/api/filters/stats?windowHours=24");
  const body = document.getElementById("rejects-body");
  const top = Object.entries(stats.byReason || {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)
    .map(([k, v]) => `${v} ${escapeHtml(k)}`)
    .join("  •  ");
  body.innerHTML = top || '<span class="muted">no rejects in window</span>';
}
