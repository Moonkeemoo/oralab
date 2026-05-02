"use strict";
import { postJson } from "../api.js";
import { escapeHtml } from "../format.js";
import { openSheet } from "../sheets.js";

export function openEditParamSheet(args) {
  const sheet = openSheet(`
    <h3>${escapeHtml(args.title)}</h3>
    <div class="kv"><span class="k">current</span><span class="v">${args.currentValue}</span></div>
    <input id="edit-input" type="number" step="any" value="${args.currentValue}" style="width:100%; margin-top:12px; padding:8px; background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:6px; font-size:16px;" />
    <div class="actions" style="margin-top:12px">
      <button id="cancel-btn" class="btn">Cancel</button>
      <button id="save-btn" class="btn btn-ok">Save</button>
    </div>
    <div id="edit-error" class="muted" style="margin-top:8px"></div>
  `);
  sheet.root.querySelector("#cancel-btn").addEventListener("click", () => sheet.close());
  sheet.root.querySelector("#save-btn").addEventListener("click", async () => {
    const v = Number(sheet.root.querySelector("#edit-input").value);
    try {
      const r = await postJson(args.postPath, { [args.paramKey]: v });
      if (r.errors) {
        sheet.root.querySelector("#edit-error").innerHTML =
          `<span class="bad">${escapeHtml(JSON.stringify(r.errors))}</span>`;
        return;
      }
      args.onSaved?.(v);
      sheet.close();
    } catch (err) {
      sheet.root.querySelector("#edit-error").innerHTML =
        `<span class="bad">${escapeHtml(err.message)}</span>`;
    }
  });
}
