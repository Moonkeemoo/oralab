"use strict";
import { fetchJson } from "../api.js";
import { escapeHtml } from "../format.js";
import { openWhaleSheet } from "../sheets/whale.js";

export async function renderWhales(root) {
  let mode = "tracked";
  async function refresh() {
    const list = await fetchJson("/api/whales");
    const filtered = mode === "tracked" ? list.filter((w) => w.tracked) : list;
    root.innerHTML = `
      <div class="chip-row">
        <button class="chip ${mode === "tracked" ? "active" : ""}" data-mode="tracked">tracked</button>
        <button class="chip ${mode === "all" ? "active" : ""}" data-mode="all">all</button>
      </div>
      <section class="card">
        <div class="card-title">${filtered.length} whales</div>
        <div class="card-body">
          ${filtered.map((w) => `
            <div class="pos" data-addr="${w.address}" role="button">
              <div class="pos-head">
                <span class="pos-id">${escapeHtml(w.address.slice(0, 10))}…</span>
                <span class="pos-status ${w.tracked ? "OPEN" : ""}">${w.tracked ? "tracked" : "untracked"}</span>
              </div>
              <div class="pos-row">
                <span>${escapeHtml(w.classification ?? "—")}</span>
                <span class="muted">conf ${(w.confidence ?? 0).toFixed(2)}</span>
              </div>
            </div>
          `).join("") || '<span class="muted">no whales in this view</span>'}
        </div>
      </section>
    `;
    root.querySelectorAll(".chip[data-mode]").forEach((el) => el.addEventListener("click", () => {
      mode = el.getAttribute("data-mode"); refresh();
    }));
    root.querySelectorAll(".pos[data-addr]").forEach((el) => el.addEventListener("click", () => {
      const w = filtered.find((x) => x.address === el.getAttribute("data-addr"));
      if (w) openWhaleSheet(w, refresh);
    }));
  }
  await refresh();
}
