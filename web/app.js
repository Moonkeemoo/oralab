"use strict";
/* eslint-env browser */

// Hook Telegram WebApp SDK if running inside Telegram. Outside (regular
// browser tab), `tg` is undefined and we fall back to `?dev=<token>` query.
const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (tg) {
  tg.ready();
  tg.expand();
}

const API_BASE = (() => {
  // Same origin in production (served from ora2-api). For local dev with
  // a different host, set window.ORA2_API_BASE before app.js loads.
  return window.ORA2_API_BASE || "";
})();

const devToken = new URLSearchParams(location.search).get("dev");
const authMode = tg?.initData ? "telegram" : devToken ? "dev_token" : "none";

document.getElementById("auth-mode").textContent = `auth: ${authMode}`;

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (tg?.initData) h["X-Telegram-Init-Data"] = tg.initData;
  if (devToken) h["X-Dev-Bypass"] = devToken;
  return h;
}

async function fetchJson(path, opts = {}) {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: authHeaders(),
    ...opts,
  });
  if (resp.status === 401) {
    throw new Error("unauthorized — open via Telegram Mini App or pass ?dev=<DEV_AUTH_TOKEN>");
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

function fmt$(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}
function fmtPct(p) {
  if (typeof p !== "number" || !isFinite(p)) return "—";
  const sign = p >= 0 ? "+" : "";
  return `${sign}${(p * 100).toFixed(1)}%`;
}

function setError(msg) {
  const existing = document.querySelector(".error-banner");
  if (existing) existing.remove();
  if (!msg) return;
  const b = document.createElement("div");
  b.className = "error-banner";
  b.textContent = msg;
  document.querySelector("header").after(b);
}

async function loadStatus() {
  const s = await fetchJson("/api/status");
  const modePill = document.getElementById("mode-pill");
  modePill.textContent = s.mode;
  modePill.className = `pill ${s.mode === "LIVE" ? "live" : "dry"}`;
  const ks = document.getElementById("ks-pill");
  ks.textContent = s.killSwitch ? "🟥 KILL ON" : "🟩 KILL OFF";
  ks.className = `pill ${s.killSwitch ? "ks-on" : "ks-off"}`;

  const body = document.getElementById("status-body");
  const breakdown = Object.entries(s.byStatus || {})
    .map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`)
    .join("");
  body.innerHTML = `
    <div class="kv"><span class="k">mode</span><span class="v">${s.mode}</span></div>
    <div class="kv"><span class="k">kill_switch</span><span class="v">${s.killSwitch ? "ON" : "OFF"}</span></div>
    <div class="kv"><span class="k">active positions</span><span class="v">${s.activePositions}</span></div>
    ${breakdown}
  `;
}

async function loadPnl() {
  const p = await fetchJson("/api/pnl?windowHours=24");
  const cls = p.netPnlUsd >= 0 ? "ok" : "bad";
  const body = document.getElementById("pnl-body");
  body.innerHTML = `
    <div class="kv"><span class="k">closed positions</span><span class="v">${p.closedCount}</span></div>
    <div class="kv"><span class="k">entry total</span><span class="v">$${(p.totalEntryUsd || 0).toFixed(2)}</span></div>
    <div class="kv"><span class="k">exit total</span><span class="v">$${(p.totalExitUsd || 0).toFixed(2)}</span></div>
    <div class="kv"><span class="k">net P&amp;L</span><span class="v ${cls}">${fmt$(p.netPnlUsd)} (${fmtPct(p.netPnlPct)})</span></div>
  `;
}

async function loadPositions() {
  const list = await fetchJson("/api/positions");
  const body = document.getElementById("positions-body");
  if (list.length === 0) {
    body.innerHTML = '<span class="muted">no active positions</span>';
    return;
  }
  body.innerHTML = list
    .map(
      (p) => `
    <div class="pos">
      <div class="pos-head">
        <span class="pos-id">#${p.id}</span>
        <span class="pos-status ${p.status}">${p.status}</span>
      </div>
      <div class="pos-row">
        <span><b>${(p.shares || 0).toFixed(3)}</b> sh</span>
        <span>fill <b>${(p.fillPrice || 0).toFixed(3)}</b></span>
        <span>peak <b>${(p.peakPrice || 0).toFixed(3)}</b></span>
        <span>sweep <b>${p.sweepCount || 0}</b></span>
      </div>
      <div class="pos-row">
        <span class="muted">$${(p.entryCostUsd || 0).toFixed(2)} entry</span>
      </div>
    </div>`,
    )
    .join("");
}

async function refreshAll() {
  try {
    await Promise.all([loadStatus(), loadPnl(), loadPositions()]);
    setError("");
    document.getElementById("last-updated").textContent =
      `updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    setError(err.message || String(err));
  }
}

async function postKillSwitch(active) {
  // Bot-style: call the matching endpoint. ora2-api doesn't have a POST yet —
  // we POST to /api/kill_switch (added in the same commit on the server).
  try {
    const resp = await fetch(`${API_BASE}/api/kill_switch`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ active, reason: "mini_app" }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${body}`);
    }
    // tg.HapticFeedback (if available) for a satisfying click feel
    tg?.HapticFeedback?.notificationOccurred?.(active ? "warning" : "success");
    await refreshAll();
  } catch (err) {
    setError(err.message || String(err));
  }
}

document.getElementById("refresh-btn").addEventListener("click", refreshAll);
document.getElementById("pause-btn").addEventListener("click", () => postKillSwitch(true));
document.getElementById("resume-btn").addEventListener("click", () => postKillSwitch(false));

// Initial load + auto-refresh every 5s.
refreshAll();
setInterval(refreshAll, 5000);
