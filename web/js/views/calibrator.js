"use strict";
import { fetchJson, postJson } from "../api.js";
import { escapeHtml, fmtAge } from "../format.js";

import * as overview from "./calibrator/overview.js";
import * as entry from "./calibrator/entry.js";
import * as exitView from "./calibrator/exit.js";
import * as whales from "./calibrator/whales.js";
import * as sport from "./calibrator/sport.js";
import * as log from "./calibrator/log.js";
import * as settings from "./calibrator/settings.js";

// Calibrator shell — top bar with mode pills + run button + cycle metadata,
// sub-tab nav (7 buttons), and a swappable sub-view container.
//
// Polling: status bar 5s. Sub-views own their own polling; we dispose them
// on sub-tab switch by simply re-rendering the container (their own
// MutationObservers detach when they fall out of the DOM).

const SUB_TABS = [
  { id: "overview", label: "Огляд",          mod: overview },
  { id: "entry",    label: "Entry",          mod: entry },
  { id: "exit",     label: "Exit",           mod: exitView },
  { id: "whales",   label: "Whales",         mod: whales },
  { id: "sport",    label: "Спорт",          mod: sport },
  { id: "log",      label: "Лог",            mod: log },
  { id: "settings", label: "Налаштування",   mod: settings },
];

const STATUS_REFRESH_MS = 5_000;
const intervals = [];
let activeSub = "overview";

function clearTimers() {
  while (intervals.length) clearInterval(intervals.pop());
}

function fmtIn(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}м`;
  return `${Math.round(m / 60)}h`;
}

async function loadStatusBar(barEl) {
  try {
    const s = await fetchJson("/api/calibrator/status");
    const lastAge = s.lastRunAt ? fmtAge(Date.now() - new Date(s.lastRunAt).getTime()) : "—";
    const nextIn = fmtIn(s.nextRunAt);
    const mode = s.mode ?? "watch";
    const modeBtns = ["manual", "watch", "auto"]
      .map((m) => `<button class="cal-mode-pill ${mode === m ? "active" : ""}" data-mode="${m}">${m}</button>`)
      .join("");
    barEl.innerHTML = `
      <div class="cal-mode-row">${modeBtns}</div>
      <button id="cal-run" class="btn btn-ok cal-run-btn">Запустити ⟳</button>
      <div class="cal-cycle-meta muted">
        Цикл: ${escapeHtml(lastAge)} · наст. ${escapeHtml(nextIn)}
        ${s.lastRecCount !== undefined ? ` · ${s.lastRecCount} recs` : ""}
      </div>
    `;
    barEl.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const newMode = btn.getAttribute("data-mode");
        try {
          await postJson("/api/calibrator/mode", { mode: newMode });
          await loadStatusBar(barEl);
        } catch (err) {
          console.error("mode change failed", err);
        }
      });
    });
    const runBtn = barEl.querySelector("#cal-run");
    if (runBtn) {
      runBtn.addEventListener("click", async () => {
        runBtn.disabled = true;
        const orig = runBtn.textContent;
        runBtn.textContent = "running…";
        try {
          await postJson("/api/calibrator/run", {});
          await loadStatusBar(barEl);
          // Refresh the active sub-view too — it likely cares about new data.
          const sub = SUB_TABS.find((t) => t.id === activeSub);
          const subEl = document.getElementById("cal-subview");
          if (sub && subEl) sub.mod.render(subEl).catch(() => {});
        } catch (err) {
          runBtn.textContent = `failed: ${err.message.slice(0, 30)}`;
          setTimeout(() => { runBtn.textContent = orig; }, 3000);
        } finally {
          runBtn.disabled = false;
          if (runBtn.textContent === "running…") runBtn.textContent = orig;
        }
      });
    }
  } catch (err) {
    barEl.innerHTML = `<div class="error-banner">status: ${escapeHtml(err.message)}</div>`;
  }
}

function highlightSub() {
  document.querySelectorAll(".cal-sub-tab").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-sub") === activeSub);
  });
}

async function renderSub(root) {
  // Stop polling sub-views before swapping (Лог + status bar polling would
  // otherwise keep clobbering the new sub-view's container).
  for (const t of SUB_TABS) {
    if (typeof t.mod.stop === "function" && t.id !== activeSub) {
      try { t.mod.stop(); } catch { /* ignore */ }
    }
  }
  const sub = SUB_TABS.find((t) => t.id === activeSub) ?? SUB_TABS[0];
  const subEl = root.querySelector("#cal-subview");
  if (!subEl) return;
  subEl.innerHTML = `<div class="muted">loading ${escapeHtml(sub.label)}…</div>`;
  try {
    await sub.mod.render(subEl);
  } catch (err) {
    subEl.innerHTML = `<div class="error-banner">${escapeHtml(sub.label)} render error: ${escapeHtml(err.message)}</div>`;
  }
}

export async function renderCalibrator(root) {
  clearTimers();

  root.innerHTML = `
    <section class="cal-shell card">
      <div id="cal-status-bar" class="cal-status-bar"><div class="muted">loading…</div></div>
    </section>
    <nav class="cal-tabbar">
      ${SUB_TABS.map((t) => `<button class="cal-sub-tab" data-sub="${t.id}">${escapeHtml(t.label)}</button>`).join("")}
    </nav>
    <div id="cal-subview" class="cal-subview"></div>
  `;

  const statusBar = root.querySelector("#cal-status-bar");

  root.querySelectorAll(".cal-sub-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeSub = btn.getAttribute("data-sub");
      highlightSub();
      renderSub(root).catch(() => {});
    });
  });

  highlightSub();
  await Promise.all([loadStatusBar(statusBar), renderSub(root)]);
  intervals.push(setInterval(() => loadStatusBar(statusBar), STATUS_REFRESH_MS));

  const observer = new MutationObserver(() => {
    if (!document.body.contains(statusBar)) {
      clearTimers();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
