"use strict";
import { fetchJson, postJson } from "../api.js";
import { escapeHtml } from "../format.js";
import { openEditParamSheet } from "../sheets/edit_param.js";

export async function renderStrategy(root) {
  const [strategies, exitCfg, filters] = await Promise.all([
    fetchJson("/api/strategies"),
    fetchJson("/api/exit_config"),
    fetchJson("/api/filters/stats?windowHours=24"),
  ]);
  const s = strategies[0];
  if (!s) {
    root.innerHTML = `<div class="muted">no strategy configured</div>`;
    return;
  }
  const params = s.params || {};
  root.innerHTML = `
    <section class="card">
      <div class="card-title">Strategy: ${escapeHtml(s.kind)} #${s.id}</div>
      <div class="card-body">
        <div class="kv"><span class="k">enabled</span><span class="v"><label class="switch"><input id="strat-enabled" type="checkbox" ${s.enabled ? "checked" : ""}/></label></span></div>
        ${paramRow("budgetUsd", params.budgetUsd)}
        ${paramRow("baseSizeUsd", params.baseSizeUsd)}
        ${paramRow("maxEntryShares", params.maxEntryShares)}
        ${paramRow("defaultConviction", params.defaultConviction)}
        ${paramRow("exitReentryCooldownSec", params.exitReentryCooldownSec)}
      </div>
    </section>

    <section class="card">
      <div class="card-title">Exit config (live)</div>
      <div class="card-body">
        ${exitRow("stopLoss", exitCfg.stopLoss)}
        ${exitRow("stopLossEmergency", exitCfg.stopLossEmergency)}
        ${exitRow("takeProfit", exitCfg.takeProfit)}
        ${exitRow("trailActivate", exitCfg.trailActivate)}
        ${exitRow("trailStop", exitCfg.trailStop)}
        ${exitRow("ceilingTpPrice", exitCfg.ceilingTpPrice)}
        ${exitRow("minStopLossAgeSeconds", exitCfg.minStopLossAgeSeconds)}
      </div>
    </section>

    <section class="card">
      <div class="card-title">Filters · ${filters.windowHours}h</div>
      <div class="card-body">
        <table class="filters">
          <tr><th>filter</th><th>count</th><th></th></tr>
          ${Object.entries(filters.byReason || {}).sort(([, a], [, b]) => b - a).map(([k, v]) => `
            <tr>
              <td>${escapeHtml(k)}</td>
              <td>${v}</td>
              <td>${(filters.bottlenecks || []).includes(k) ? "⚡" : ""}</td>
            </tr>
          `).join("")}
        </table>
        <div class="muted">accept: ${filters.accepted}/${filters.total} = ${filters.acceptRatePct.toFixed(1)}%</div>
      </div>
    </section>
  `;
  root.querySelector("#strat-enabled").addEventListener("change", async (e) => {
    await postJson(`/api/strategies/${s.id}/enabled`, { enabled: e.target.checked });
  });
  root.querySelectorAll("[data-param]").forEach((el) => el.addEventListener("click", () => {
    const k = el.getAttribute("data-param");
    openEditParamSheet({
      title: `strategy.${k}`,
      currentValue: el.getAttribute("data-value"),
      postPath: `/api/strategies/${s.id}/params`,
      paramKey: k,
      onSaved: () => renderStrategy(root),
    });
  }));
  root.querySelectorAll("[data-exit]").forEach((el) => el.addEventListener("click", () => {
    const k = el.getAttribute("data-exit");
    openEditParamSheet({
      title: `exit.${k}`,
      currentValue: el.getAttribute("data-value"),
      postPath: `/api/exit_config`,
      paramKey: k,
      onSaved: () => renderStrategy(root),
    });
  }));
}

function paramRow(k, v) {
  return `<div class="kv" data-param="${k}" data-value="${v ?? ""}" role="button"><span class="k">${k}</span><span class="v">${v ?? "—"} ✎</span></div>`;
}
function exitRow(k, v) {
  return `<div class="kv" data-exit="${k}" data-value="${v}" role="button"><span class="k">${k}</span><span class="v">${v} ✎</span></div>`;
}
