"use strict";
import { fetchJson, postJson } from "../api.js";
import { escapeHtml, fmtAge } from "../format.js";
import { openSheet } from "../sheets.js";

export async function openPositionSheet(id) {
  const sheet = openSheet(`<div class="muted">loading…</div>`);
  try {
    const data = await fetchJson(`/api/positions/${id}/timeline`);
    if (data.error) {
      sheet.root.innerHTML = `<div class="error-banner">${escapeHtml(data.error)}</div>`;
      return;
    }
    const p = data.position;
    const fills = (data.fills || []).slice().sort((a, b) => a.ts - b.ts);
    const decisions = data.recentDecisions || [];
    // Current mark from latest decision (top of recentDecisions)
    const latest = decisions[0] || {};
    const cur = latest.mark != null ? Number(latest.mark) : null;
    const fp = Number(p.fillPrice || 0);
    const sh = Number(p.shares || 0);
    const livePnlUsd = cur != null && fp > 0 ? (cur - fp) * sh : null;
    const livePnlPct = cur != null && fp > 0 ? (cur - fp) / fp : null;
    const sign = livePnlUsd != null && livePnlUsd >= 0 ? "+" : "";
    const pnlClass = livePnlUsd == null ? "" : livePnlUsd >= 0 ? "good" : "bad";
    sheet.root.innerHTML = `
      <h3>Position #${p.id} <span class="pos-status ${p.status}">${p.status}</span></h3>
      <div class="kv"><span class="k">side</span><span class="v">${p.side}</span></div>
      <div class="kv"><span class="k">shares</span><span class="v">${(p.shares || 0).toFixed(4)}</span></div>
      <div class="kv"><span class="k">fill price</span><span class="v">${(p.fillPrice || 0).toFixed(3)}</span></div>
      <div class="kv"><span class="k">current price</span><span class="v">${cur != null ? cur.toFixed(3) : "—"}${latest.markSource ? ` <span class="muted">(${escapeHtml(latest.markSource)}, ${Math.round((latest.markFreshnessMs || 0))}ms)</span>` : ""}</span></div>
      <div class="kv"><span class="k">live PnL</span><span class="v ${pnlClass}">${livePnlUsd == null ? "—" : `${sign}$${livePnlUsd.toFixed(2)} (${sign}${(livePnlPct * 100).toFixed(1)}%)`}</span></div>
      <div class="kv"><span class="k">peak price</span><span class="v">${(p.peakPrice || 0).toFixed(3)}</span></div>
      <div class="kv"><span class="k">sweep count</span><span class="v">${p.sweepCount}</span></div>
      <div class="kv"><span class="k">entry cost</span><span class="v">$${(p.entryCostUsd || 0).toFixed(2)}</span></div>
      <div class="kv"><span class="k">age</span><span class="v">${fmtAge(Date.now() - (p.fillTs || Date.now()))}</span></div>
      ${p.closeReason ? `<div class="kv"><span class="k">close reason</span><span class="v">${escapeHtml(p.closeReason)}</span></div>` : ""}

      <div class="card-title" style="margin-top:14px">Initiator</div>
      <div class="kv"><span class="k">whale</span><span class="v"><code>${escapeHtml((data.initiator?.whaleAddress ?? "—").toString().slice(0, 14))}</code></span></div>
      <div class="kv"><span class="k">whale size USD</span><span class="v">${data.initiator?.whaleSizeUsd ? "$" + Number(data.initiator.whaleSizeUsd).toFixed(2) : "—"}</span></div>
      <div class="kv"><span class="k">conviction</span><span class="v">${data.initiator?.conviction ?? "—"}</span></div>
      <div class="kv"><span class="k">trust score</span><span class="v">${data.initiator?.trustScore ?? "—"}</span></div>
      <div class="kv"><span class="k">sm score</span><span class="v">${data.initiator?.smScore ?? "—"}</span></div>
      <div class="kv"><span class="k">convergence (±60s)</span><span class="v">${data.initiator?.convergenceCount ?? 0}</span></div>

      <div class="card-title" style="margin-top:14px">Verification</div>
      <div class="kv"><span class="k">PnL source</span><span class="v">${escapeHtml(data.verification?.pnlSource ?? "—")}</span></div>
      <div class="kv"><span class="k">exit tx</span><span class="v">${data.verification?.exitTxHash ? `<code>${escapeHtml(String(data.verification.exitTxHash).slice(0, 14))}…</code>` : "—"}</span></div>
      ${data.verification?.anomaly ? '<div class="kv"><span class="k">⚠ anomaly</span><span class="v bad">flagged</span></div>' : ""}

      <div class="card-title" style="margin-top:14px">Timeline</div>
      <ol class="timeline">
        ${fills.map((f) => `
          <li>
            <span class="t-side">${f.side}</span>
            <b>${(f.shares || 0).toFixed(3)}</b> @ ${(f.price || 0).toFixed(3)}
            <span class="muted">tx ${escapeHtml((f.txHash || "").slice(0, 12))}…</span>
          </li>`).join("")}
      </ol>

      <div class="card-title" style="margin-top:14px">Recent decisions (last ${decisions.length})</div>
      <ul class="decisions">
        ${decisions.map((d) => `
          <li>
            <span class="muted">${new Date(d.ts).toLocaleTimeString()}</span>
            <b>${escapeHtml(String(d.action))}</b>
            <span class="muted">${escapeHtml(String(d.reason))}</span>
            <span class="muted">[${(d.gates || []).map(escapeHtml).join(", ")}]</span>
            <span class="muted">${d.markSource ? escapeHtml(String(d.markSource)) : ""}${d.markFreshnessMs !== null && d.markFreshnessMs !== undefined ? " " + Math.round(d.markFreshnessMs) + "ms" : ""}</span>
          </li>`).join("")}
      </ul>

      <div class="actions" style="margin-top:14px">
        ${(p.status === "OPEN" || p.status === "EXITING") ? `
          <button id="exit-now-btn" class="btn btn-warn">Exit Now</button>
          <button id="freeze-btn" class="btn">Freeze</button>
        ` : ""}
      </div>
    `;
    sheet.root.querySelector("#exit-now-btn")?.addEventListener("click", async () => {
      if (!confirm("Place FAK SELL with 20% slippage?")) return;
      const r = await postJson(`/api/positions/${id}/exit`, { mode: "FAK", slippagePct: 0.2 });
      alert(`exit: ok=${r.ok} status=${r.status ?? ""} err=${r.errorCode ?? ""}`);
      sheet.close();
    });
    sheet.root.querySelector("#freeze-btn")?.addEventListener("click", async () => {
      if (!confirm("Mark position as FROZEN (manual recovery later)?")) return;
      await postJson(`/api/positions/${id}/freeze`, {});
      sheet.close();
    });
  } catch (err) {
    sheet.root.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  }
}
