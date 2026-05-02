"use strict";
import { fetchJson } from "../api.js";
import { escapeHtml } from "../format.js";
import { openWhaleSheet } from "../sheets/whale.js";

const CLASS_OPTIONS = ["all", "INFORMED", "SHARP", "FOLLOWER", "NOISE"];

export async function renderWhales(root) {
  let modeTracked = "tracked"; // tracked | all
  let modeClass = "all";       // all | INFORMED | SHARP | FOLLOWER | NOISE

  async function refresh() {
    const list = await fetchJson("/api/whales");
    let filtered = modeTracked === "tracked" ? list.filter((w) => w.tracked) : list;
    if (modeClass !== "all") filtered = filtered.filter((w) => w.classification === modeClass);

    const classCounts = list.reduce((acc, w) => {
      acc[w.classification] = (acc[w.classification] ?? 0) + 1;
      return acc;
    }, {});

    root.innerHTML = `
      <div class="chip-row">
        <button class="chip ${modeTracked === "tracked" ? "active" : ""}" data-tracked="tracked">tracked</button>
        <button class="chip ${modeTracked === "all" ? "active" : ""}" data-tracked="all">all (${list.length})</button>
      </div>
      <div class="chip-row">
        ${CLASS_OPTIONS.map((c) => {
          const cnt = c === "all" ? list.length : (classCounts[c] ?? 0);
          return `<button class="chip ${modeClass === c ? "active" : ""}" data-class="${c}">${c} ${cnt}</button>`;
        }).join("")}
      </div>
      <section class="card">
        <div class="card-title">${filtered.length} whales</div>
        <div class="card-body">
          ${filtered.slice(0, 200).map((w) => `
            <div class="pos" data-addr="${w.address}" role="button">
              <div class="pos-head">
                <span class="pos-id">${escapeHtml(w.address.slice(0, 10))}…</span>
                <span class="pos-status ${w.tracked ? "OPEN" : ""}">${w.tracked ? "tracked" : "untracked"}</span>
              </div>
              <div class="pos-row">
                <span><b>${escapeHtml(w.classification ?? "—")}</b></span>
                <span class="muted">conf ${(w.confidence ?? 0).toFixed(2)}</span>
              </div>
            </div>
          `).join("") || '<span class="muted">no whales in this view</span>'}
          ${filtered.length > 200 ? `<div class="muted" style="margin-top:8px">showing 200 of ${filtered.length}</div>` : ""}
        </div>
      </section>
    `;
    root.querySelectorAll(".chip[data-tracked]").forEach((el) => el.addEventListener("click", () => {
      modeTracked = el.getAttribute("data-tracked"); refresh();
    }));
    root.querySelectorAll(".chip[data-class]").forEach((el) => el.addEventListener("click", () => {
      modeClass = el.getAttribute("data-class"); refresh();
    }));
    root.querySelectorAll(".pos[data-addr]").forEach((el) => el.addEventListener("click", () => {
      const w = filtered.find((x) => x.address === el.getAttribute("data-addr"));
      if (w) openWhaleSheet(w, refresh);
    }));
  }
  await refresh();
}
