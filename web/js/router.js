"use strict";

const TABS = ["live", "history", "strategy", "whales", "more"];

export function currentTab() {
  const hash = location.hash.replace("#", "");
  return TABS.includes(hash) ? hash : "live";
}

export function navigate(tab) {
  if (!TABS.includes(tab)) return;
  if (location.hash !== `#${tab}`) {
    location.hash = `#${tab}`;
  }
}

export function onTabChange(handler) {
  window.addEventListener("hashchange", () => handler(currentTab()));
  handler(currentTab());
}

export const ALL_TABS = TABS;
