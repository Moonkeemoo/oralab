"use strict";
import { refreshCockpit } from "./js/cockpit.js";
import { currentTab, navigate, onTabChange } from "./js/router.js";
import { renderLive } from "./js/views/live.js";
import { renderHistory } from "./js/views/history.js";
import { renderStrategy } from "./js/views/strategy.js";
import { renderWhales } from "./js/views/whales.js";
import { renderCalibrator } from "./js/views/calibrator.js";
import { renderMore } from "./js/views/more.js";

const VIEWS = {
  live: renderLive,
  history: renderHistory,
  strategy: renderStrategy,
  whales: renderWhales,
  calib: renderCalibrator,
  more: renderMore,
};

const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

function highlightActiveTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
  });
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => navigate(btn.getAttribute("data-tab")));
});

async function renderCurrent(tab) {
  highlightActiveTab(tab);
  const view = document.getElementById("view");
  if (!view) return;
  view.innerHTML = `<div class="muted">loading…</div>`;
  try {
    await VIEWS[tab](view);
  } catch (err) {
    view.innerHTML = `<div class="error-banner">render error: ${err.message}</div>`;
  }
}

onTabChange(renderCurrent);

refreshCockpit();
setInterval(refreshCockpit, 5000);
