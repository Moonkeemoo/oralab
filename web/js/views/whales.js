"use strict";
import { fetchJson } from "../api.js";
import { escapeHtml } from "../format.js";
import { openWhaleSheet } from "../sheets/whale.js";

// Backend (handleWhalesList in src/api/rest_server.ts) returns:
//   { total, counts:{tracked,INFORMED,SHARP,SNIPER,FOLLOWER,COPYCAT,NOISE,
//     MARKET_MAKER}, page:{limit,offset,returned}, items:[...] }
// We render the full corpus by paging through it (page-size = PAGE) so the
// header reflects the real 1500+ whale count instead of the old 200 cap.
//
// Known v1-parity gap: no virtual scrolling — we use a "Load N more" button
// instead. Good enough for 1500 rows; revisit if corpus grows past 5k.
const CLASS_OPTIONS = [
  "all",
  "INFORMED",
  "SHARP",
  "SNIPER",
  "FOLLOWER",
  "COPYCAT",
  "NOISE",
  "MARKET_MAKER",
];
const PAGE = 200;

export async function renderWhales(root) {
  let modeTracked = "tracked"; // tracked | all — default to what we trade
  let modeClass = "all";
  let loaded = []; // accumulated items across "Load more" clicks
  let corpusTotal = 0; // whale count matching active filter (server-side)
  let unfilteredTotal = 0; // whales overall (counts.tracked or .total)
  let counts = {};

  function buildQuery(offset) {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE));
    params.set("offset", String(offset));
    if (modeTracked === "tracked") params.set("trackedOnly", "true");
    if (modeClass !== "all") params.set("classification", modeClass);
    return `/api/whales?${params.toString()}`;
  }

  async function fetchPage(offset) {
    const data = await fetchJson(buildQuery(offset));
    counts = data.counts ?? {};
    unfilteredTotal = Number(data.total ?? 0);
    // For "showing N of M" footer we need the count *matching* the active
    // filter. Classification chips are exact buckets; tracked-only collapses
    // to counts.tracked; otherwise corpus = total.
    if (modeClass !== "all") {
      corpusTotal = Number(counts[modeClass] ?? 0);
    } else if (modeTracked === "tracked") {
      corpusTotal = Number(counts.tracked ?? 0);
    } else {
      corpusTotal = unfilteredTotal;
    }
    return Array.isArray(data.items) ? data.items : [];
  }

  function chipBar() {
    const trackedChip = `<button class="chip ${modeTracked === "tracked" ? "active" : ""}" data-tracked="tracked">tracked ${counts.tracked ?? 0}</button>`;
    const allChip = `<button class="chip ${modeTracked === "all" ? "active" : ""}" data-tracked="all">all ${unfilteredTotal}</button>`;
    const classChips = CLASS_OPTIONS.map((c) => {
      const cnt = c === "all" ? "" : ` ${counts[c] ?? 0}`;
      const active = modeClass === c ? "active" : "";
      return `<button class="chip ${active}" data-class="${c}">${escapeHtml(c)}${cnt}</button>`;
    }).join("");
    return `
      <div class="chip-row">${trackedChip}${allChip}</div>
      <div class="chip-row">${classChips}</div>
    `;
  }

  function listBody() {
    const rowsHtml = loaded.map((w) => `
      <div class="pos" data-addr="${escapeHtml(w.address)}" role="button">
        <div class="pos-head">
          <span class="pos-id">${escapeHtml(w.address.slice(0, 10))}…</span>
          <span class="pos-status ${w.tracked ? "OPEN" : ""}">${w.tracked ? "tracked" : "untracked"}</span>
        </div>
        <div class="pos-row">
          <span><b>${escapeHtml(w.classification ?? "—")}</b></span>
          <span class="muted">conf ${(Number(w.confidence) || 0).toFixed(2)}</span>
        </div>
      </div>
    `).join("");
    if (loaded.length === 0) return '<span class="muted">no whales in this view</span>';
    const remaining = corpusTotal - loaded.length;
    const more = remaining > 0
      ? `<button class="chip" id="whales-load-more" style="margin-top:10px;width:100%">Load ${Math.min(PAGE, remaining)} more (${loaded.length} of ${corpusTotal})</button>`
      : `<div class="muted" style="margin-top:8px">all ${corpusTotal} loaded</div>`;
    return `${rowsHtml}${more}`;
  }

  async function refreshAll() {
    loaded = await fetchPage(0);
    paint();
  }

  async function loadMore() {
    const next = await fetchPage(loaded.length);
    loaded = loaded.concat(next);
    paint();
  }

  function paint() {
    root.innerHTML = `
      ${chipBar()}
      <section class="card">
        <div class="card-title">${corpusTotal} whales · loaded ${loaded.length}</div>
        <div class="card-body">${listBody()}</div>
      </section>
    `;
    root.querySelectorAll(".chip[data-tracked]").forEach((el) => {
      el.addEventListener("click", () => {
        modeTracked = el.getAttribute("data-tracked") ?? "tracked";
        void refreshAll();
      });
    });
    root.querySelectorAll(".chip[data-class]").forEach((el) => {
      el.addEventListener("click", () => {
        modeClass = el.getAttribute("data-class") ?? "all";
        void refreshAll();
      });
    });
    root.querySelectorAll(".pos[data-addr]").forEach((el) => {
      el.addEventListener("click", () => {
        const addr = el.getAttribute("data-addr");
        const w = loaded.find((x) => x.address === addr);
        if (w) openWhaleSheet(w, refreshAll);
      });
    });
    const moreBtn = root.querySelector("#whales-load-more");
    if (moreBtn) {
      moreBtn.addEventListener("click", () => {
        moreBtn.textContent = "loading…";
        void loadMore();
      });
    }
  }

  await refreshAll();
}
