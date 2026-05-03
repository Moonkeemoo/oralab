"use strict";
import { fetchJson } from "../../api.js";
import { escapeHtml, fmtAge } from "../../format.js";

// Лог sub-tab — calibrator trace event timeline. Polls every 10s.
// Click row to expand full payload JSON.

const POLL_MS = 10_000;
const intervals = [];

const TYPE_BADGE = {
  cycle_start: "cal-evt-gray",
  cycle_complete: "cal-evt-gray",
  recommendation: "cal-evt-purple",
  apply: "cal-evt-green",
  rollback: "cal-evt-red",
  weights: "cal-evt-blue",
  lift_matrix: "cal-evt-blue",
  deficits: "cal-evt-blue",
  reject: "cal-evt-red",
  set_assist: "cal-evt-purple",
};
const NEW_TYPES = new Set(["weights", "lift_matrix", "deficits"]);

function badge(type) {
  const cls = TYPE_BADGE[type] ?? "cal-evt-gray";
  const tag = NEW_TYPES.has(type) ? ' <span class="cal-evt-new">[NEW]</span>' : "";
  return `<span class="cal-evt-badge ${cls}">${escapeHtml(type)}${tag}</span>`;
}

function rowsHtml(rows) {
  if (rows.length === 0) {
    return `<div class="muted">no trace events yet — run calibrator at least once.</div>`;
  }
  return `<div class="cal-table-wrap"><table class="cal-trace-table">
    <thead><tr><th>Час</th><th>Cycle</th><th>Event</th><th>Filter</th><th>Payload</th></tr></thead>
    <tbody>
      ${rows.map((r) => {
        const ts = Number(r.ts ?? r.createdAt ?? r.created_at ?? 0);
        const age = ts ? fmtAge(Date.now() - ts) : "—";
        const filterName = r.filterName ?? r.payload?.filterName ?? r.payload?.paramKey ?? "";
        const payload = r.payload ? JSON.stringify(r.payload, null, 2) : "{}";
        const cycleId = r.cycleId ?? r.cycle_id ?? "";
        return `<tr class="cal-trace-row">
          <td class="muted">${escapeHtml(age)}</td>
          <td><code>${escapeHtml(String(cycleId).slice(0, 12))}</code></td>
          <td>${badge(r.eventType ?? r.event_type ?? "—")}</td>
          <td>${escapeHtml(String(filterName))}</td>
          <td><details><summary class="muted">…</summary><pre class="cal-trace-payload">${escapeHtml(payload)}</pre></details></td>
        </tr>`;
      }).join("")}
    </tbody>
  </table></div>`;
}

let renderToken = 0;

async function load(container, token) {
  if (token !== renderToken) return;
  try {
    const data = await fetchJson("/api/calibrator/trace?limit=200");
    if (token !== renderToken) return;
    const rows = data.rows ?? [];
    container.innerHTML = `
      <section class="card">
        <div class="card-title">CALIBRATOR EVENTS <span class="muted">(${rows.length})</span></div>
        ${rowsHtml(rows)}
      </section>`;
  } catch (err) {
    if (token !== renderToken) return;
    container.innerHTML = `<div class="error-banner">trace: ${escapeHtml(err.message)}</div>`;
  }
}

function clearTimers() {
  while (intervals.length) clearInterval(intervals.pop());
}

export function stop() {
  renderToken += 1; // invalidate any in-flight load() calls
  clearTimers();
}

export async function render(container) {
  clearTimers();
  // Bump token: any prior load() callbacks will silently no-op when they
  // resolve since their captured token < renderToken.
  renderToken += 1;
  const myToken = renderToken;
  await load(container, myToken);
  intervals.push(setInterval(() => load(container, myToken), POLL_MS));
  // Stop polling if the container leaves the DOM.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(container)) {
      clearTimers();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

