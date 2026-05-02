"use strict";
import { fetchJson, postJson } from "../api.js";
import { escapeHtml } from "../format.js";
import { openEditParamSheet } from "../sheets/edit_param.js";

const GROUP_LABELS = {
  hard_safety: "Hard Safety",
  conviction: "Conviction",
  wallet_quality: "Wallet Quality",
  market_quality: "Market Quality",
  price_quality: "Price Quality",
  risk_exposure: "Risk Exposure",
};

export async function renderStrategy(root) {
  const [strategies, exitCfg, filterStats, filterRegistry] = await Promise.all([
    fetchJson("/api/strategies"),
    fetchJson("/api/exit_config"),
    fetchJson("/api/filters/stats?windowHours=24"),
    fetchJson("/api/filters/registry"),
  ]);
  const s = strategies[0];
  if (!s) {
    root.innerHTML = `<div class="muted">no strategy configured</div>`;
    return;
  }
  const params = s.params || {};
  const byReason = filterStats.byReason || {};
  const bottlenecks = new Set(filterStats.bottlenecks || []);

  // Group filters
  const groups = {};
  for (const f of (filterRegistry.filters || [])) {
    (groups[f.group] = groups[f.group] || []).push(f);
  }
  const portedCount = (filterRegistry.filters || []).filter((f) => f.ported).length;
  const totalCount = (filterRegistry.filters || []).length;

  function renderGroup(groupKey, list) {
    const sorted = list.slice().sort((a, b) => {
      const ca = byReason[a.name] || 0;
      const cb = byReason[b.name] || 0;
      if (cb !== ca) return cb - ca;
      return a.name.localeCompare(b.name);
    });
    return `
      <section class="card">
        <div class="card-title">${GROUP_LABELS[groupKey] || groupKey} · ${list.length}</div>
        <div class="card-body">
          <table class="filters">
            <tr><th>filter</th><th>24h</th><th>thr</th><th></th></tr>
            ${sorted.map((f) => {
              const cnt = byReason[f.name] || 0;
              const portedBadge = f.ported
                ? '<span class="pill" style="background:rgba(63,185,80,0.15);color:var(--ok);border-color:var(--ok);font-size:10px;padding:1px 6px">ported</span>'
                : '<span class="pill" style="background:rgba(248,81,73,0.10);color:var(--bad);border-color:var(--bad);font-size:10px;padding:1px 6px">v1 only</span>';
              const bn = bottlenecks.has(f.name) ? "⚡" : "";
              const thr = f.defaultThreshold !== undefined && f.defaultThreshold !== null ? String(f.defaultThreshold) : "—";
              return `<tr title="${escapeHtml(f.description)}">
                <td>${escapeHtml(f.name)} ${bn}</td>
                <td>${cnt}</td>
                <td><code style="font-size:11px">${escapeHtml(thr)}</code></td>
                <td>${portedBadge}</td>
              </tr>`;
            }).join("")}
          </table>
        </div>
      </section>
    `;
  }

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
      <div class="card-title">Filters · ${portedCount}/${totalCount} ported · ${filterStats.windowHours}h activity</div>
      <div class="card-body">
        <div class="muted" style="margin-bottom:8px">accept ${filterStats.accepted}/${filterStats.total} = ${filterStats.acceptRatePct.toFixed(1)}%</div>
      </div>
    </section>

    ${Object.keys(GROUP_LABELS).map((g) => groups[g] ? renderGroup(g, groups[g]) : "").join("")}
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
