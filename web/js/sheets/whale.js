"use strict";
import { postJson } from "../api.js";
import { escapeHtml } from "../format.js";
import { openSheet } from "../sheets.js";

export function openWhaleSheet(w, onChanged) {
  const sheet = openSheet(`
    <h3>Whale ${escapeHtml(w.address.slice(0, 10))}…</h3>
    <div class="kv"><span class="k">classification</span><span class="v">${escapeHtml(w.classification ?? "—")}</span></div>
    <div class="kv"><span class="k">confidence</span><span class="v">${(w.confidence ?? 0).toFixed(2)}</span></div>
    <div class="kv"><span class="k">tracked</span><span class="v">${w.tracked ? "yes" : "no"}</span></div>
    <div class="actions" style="margin-top:12px">
      <button id="toggle-btn" class="btn ${w.tracked ? "btn-warn" : "btn-ok"}">${w.tracked ? "Untrack" : "Track"}</button>
    </div>
    <div class="muted" style="margin-top:10px">Per-whale signal history + P&L attribution coming in P2c.</div>
  `);
  sheet.root.querySelector("#toggle-btn").addEventListener("click", async () => {
    await postJson(`/api/whales/${w.address}/track`, { tracked: !w.tracked });
    sheet.close();
    onChanged?.();
  });
}
