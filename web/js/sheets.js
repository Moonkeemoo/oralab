"use strict";

export function openSheet(html) {
  const existing = document.getElementById("sheet-overlay");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.id = "sheet-overlay";
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-handle" aria-hidden="true"></div>
      <button class="sheet-close" aria-label="close">×</button>
      <div class="sheet-body">${html}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector(".sheet-backdrop")?.addEventListener("click", close);
  overlay.querySelector(".sheet-close")?.addEventListener("click", close);
  document.addEventListener(
    "keydown",
    function escListener(e) {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", escListener);
      }
    },
  );
  return { close, root: overlay.querySelector(".sheet-body") };
}
