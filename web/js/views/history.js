"use strict";
import { fetchJson } from "../api.js";
import { escapeHtml, fmt$, fmtAge, fmtPct } from "../format.js";
import { openPositionSheet } from "../sheets/position.js";

const WINDOW_OPTIONS = [
  { label: "today", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

export async function renderHistory(root) {
  let windowHours = 24;
  let outcome = "all";

  function chips() {
    return `
      <div class="chip-row">
        ${WINDOW_OPTIONS.map((o) =>
          `<button class="chip ${o.hours === windowHours ? "active" : ""}" data-hours="${o.hours}">${o.label}</button>`
        ).join("")}
        <span style="flex:1"></span>
        ${["all", "wins", "losses"].map((o) =>
          `<button class="chip ${o === outcome ? "active" : ""}" data-outcome="${o}">${o}</button>`
        ).join("")}
      </div>
    `;
  }

  async function refresh() {
    const data = await fetchJson(`/api/history?windowHours=${windowHours}`);
    const a = data.aggregates;
    const filtered = (data.trades || []).filter((t) =>
      outcome === "all" ? true : (outcome === "wins" ? t.outcome === "win" : t.outcome === "loss"),
    );
    root.innerHTML = `
      ${chips()}
      <section class="card">
        <div class="card-title">Aggregates</div>
        <div class="card-body">
          <div class="kv"><span class="k">trades</span><span class="v">${a.trades}</span></div>
          <div class="kv"><span class="k">win rate</span><span class="v">${a.winRatePct.toFixed(1)}%</span></div>
          <div class="kv"><span class="k">net</span><span class="v ${a.netPnlUsd >= 0 ? "ok" : "bad"}">${fmt$(a.netPnlUsd)} (${fmtPct(a.netPnlPct)})</span></div>
          <div class="kv"><span class="k">avg / best / worst</span><span class="v">${fmt$(a.avgUsd)} / ${fmt$(a.bestUsd)} / ${fmt$(a.worstUsd)}</span></div>
        </div>
      </section>
      <section class="card">
        <div class="card-title">Trades (${filtered.length})</div>
        <div class="card-body">
          ${filtered.length === 0 ? '<span class="muted">no trades in window</span>' : filtered.map((t) => `
            <div class="pos" data-id="${t.id}" role="button">
              <div class="pos-head">
                <span class="pos-id">#${t.id} ${t.outcome === "win" ? "✓" : "✗"} ${fmt$(t.pnlUsd)}</span>
                <span class="pos-status">${escapeHtml(String(t.closeReason ?? ""))}</span>
              </div>
              <div class="pos-row">
                <span class="muted">entry $${t.entryUsd.toFixed(2)}</span>
                <span class="muted">exit $${t.exitUsd.toFixed(2)}</span>
                <span class="muted">${fmtAge(Date.now() - t.closeTs)}</span>
              </div>
            </div>
          `).join("")}
        </div>
      </section>
    `;
    root.querySelectorAll(".chip[data-hours]").forEach((el) => el.addEventListener("click", () => {
      windowHours = Number(el.getAttribute("data-hours"));
      refresh();
    }));
    root.querySelectorAll(".chip[data-outcome]").forEach((el) => el.addEventListener("click", () => {
      outcome = el.getAttribute("data-outcome");
      refresh();
    }));
    root.querySelectorAll(".pos[data-id]").forEach((el) => el.addEventListener("click", () =>
      openPositionSheet(Number(el.getAttribute("data-id"))),
    ));
  }

  await refresh();
}
