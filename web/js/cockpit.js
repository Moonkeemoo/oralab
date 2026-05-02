"use strict";
import { fetchJson } from "./api.js";
import { fmt$ } from "./format.js";

export async function refreshCockpit() {
  const root = document.getElementById("cockpit");
  if (!root) return;
  try {
    const [status, pnl, conns] = await Promise.all([
      fetchJson("/api/status"),
      fetchJson("/api/pnl?windowHours=24"),
      fetchJson("/api/connections"),
    ]);
    const health = computeHealth(conns);
    root.innerHTML = `
      <span class="pill ${status.mode === "LIVE" ? "live" : "dry"}">${status.mode}</span>
      <span class="pill ${status.killSwitch ? "ks-on" : "ks-off"}">
        ${status.killSwitch ? "🟥 KILL ON" : "🟩 KILL OFF"}
      </span>
      <span class="pill">${fmt$(pnl.netPnlUsd)} 24h</span>
      <span class="pill">${status.activePositions} active</span>
      <span class="health-dot ${health}" title="connections: ${health}"></span>
    `;
  } catch (err) {
    root.innerHTML = `<span class="pill" style="color:var(--bad)">cockpit error: ${err.message}</span>`;
  }
}

function computeHealth(conns) {
  if (!Array.isArray(conns) || conns.length === 0) return "warn";
  const states = conns.map((c) => c.state);
  if (states.every((s) => s === "ok")) return "ok";
  if (states.some((s) => s === "down")) return "bad";
  return "warn";
}
