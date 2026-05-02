"use strict";
import { fetchJson, postJson } from "../api.js";
import { escapeHtml } from "../format.js";
import { openSheet } from "../sheets.js";

export async function openWhaleSheet(w, onChanged) {
  const sheet = openSheet(`<div class="muted">loading profile…</div>`);
  try {
    const p = await fetchJson(`/api/whales/${w.address}/profile`);
    if (p.error) {
      sheet.root.innerHTML = `<div class="error-banner">${escapeHtml(p.error)}</div>`;
      return;
    }
    const domains = (p.domainBreakdown && typeof p.domainBreakdown === "object")
      ? Object.entries(p.domainBreakdown)
      : [];
    sheet.root.innerHTML = `
      <h3>Whale ${escapeHtml(w.address.slice(0, 10))}…</h3>
      <div class="kv"><span class="k">classification</span><span class="v"><b>${escapeHtml(p.classification ?? "—")}</b></span></div>
      <div class="kv"><span class="k">confidence</span><span class="v">${(p.confidence ?? 0).toFixed(2)}</span></div>
      <div class="kv"><span class="k">tracked</span><span class="v">${p.tracked ? "yes" : "no"}</span></div>

      <div class="card-title" style="margin-top:14px">Metrics</div>
      <div class="kv"><span class="k">total trades</span><span class="v">${p.totalTrades ?? 0}</span></div>
      <div class="kv"><span class="k">win rate</span><span class="v">${(p.winRate * 100).toFixed(1)}%</span></div>
      <div class="kv"><span class="k">avg hold</span><span class="v">${p.avgHoldHours.toFixed(1)} h</span></div>
      <div class="kv"><span class="k">directional ratio</span><span class="v">${p.directionalRatio.toFixed(2)}</span></div>
      <div class="kv"><span class="k">trust score</span><span class="v">${p.trustScore.toFixed(2)}</span></div>
      <div class="kv"><span class="k">sm score</span><span class="v">${p.smScore.toFixed(2)}</span></div>
      <div class="kv"><span class="k">last activity</span><span class="v">${p.lastActivityAt ? new Date(p.lastActivityAt).toLocaleDateString() : "—"}</span></div>

      ${domains.length > 0 ? `
      <div class="card-title" style="margin-top:14px">Domains</div>
      <table class="filters">
        <tr><th>domain</th><th>classification</th></tr>
        ${domains.map(([d, _]) => {
          const cls = (p.perDomainClassification && p.perDomainClassification[d]) || "—";
          return `<tr><td>${escapeHtml(d)}</td><td>${escapeHtml(String(cls))}</td></tr>`;
        }).join("")}
      </table>
      ` : ""}

      <div class="actions" style="margin-top:12px">
        <button id="toggle-btn" class="btn ${p.tracked ? "btn-warn" : "btn-ok"}">${p.tracked ? "Untrack" : "Track"}</button>
      </div>
      <div class="muted" style="margin-top:10px">Per-whale signal history + P&L attribution coming in P2c.</div>
    `;
    sheet.root.querySelector("#toggle-btn").addEventListener("click", async () => {
      await postJson(`/api/whales/${w.address}/track`, { tracked: !p.tracked });
      sheet.close();
      onChanged?.();
    });
  } catch (err) {
    sheet.root.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  }
}
