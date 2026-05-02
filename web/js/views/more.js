"use strict";
import { fetchJson } from "../api.js";
import { escapeHtml, fmtAge } from "../format.js";

export async function renderMore(root) {
  const [conns, perf, audit, build] = await Promise.all([
    fetchJson("/api/connections"),
    fetchJson("/api/perf"),
    fetchJson("/api/audit?limit=30"),
    fetchJson("/api/build"),
  ]);
  root.innerHTML = `
    <section class="card">
      <div class="card-title">Notifications</div>
      <div class="card-body muted">
        wired: BUY filled, position closed, FROZEN, fatal error.<br>
        per-event toggles + daily summary scheduling: P2d.
      </div>
    </section>

    <section class="card">
      <div class="card-title">Connections</div>
      <div class="card-body">
        ${conns.map((c) => `
          <div class="kv">
            <span class="k">${escapeHtml(c.source)}</span>
            <span class="v">
              <span class="health-dot ${c.state === "ok" ? "ok" : c.state === "stale" ? "warn" : "bad"}"></span>
              ${fmtAge(c.ageMs ?? Infinity)}
            </span>
          </div>
        `).join("")}
      </div>
    </section>

    <section class="card">
      <div class="card-title">Performance</div>
      <div class="card-body">
        <div class="kv"><span class="k">node</span><span class="v">${escapeHtml(perf.nodeVersion)}</span></div>
        <div class="kv"><span class="k">uptime</span><span class="v">${perf.uptimeSec}s</span></div>
        <div class="kv"><span class="k">rss memory</span><span class="v">${perf.memoryRssMb} MB</span></div>
      </div>
    </section>

    <section class="card">
      <div class="card-title">Audit log (last ${audit.length})</div>
      <div class="card-body audit">
        ${audit.map((a) => `
          <div class="audit-row">
            <span class="muted">${new Date(a.ts).toLocaleString()}</span>
            <b>${escapeHtml(a.action)}</b>
            <span class="muted">${escapeHtml(a.target ?? "")}</span>
            <span class="muted">${escapeHtml(a.actor)}</span>
          </div>
        `).join("")}
      </div>
    </section>

    <section class="card">
      <div class="card-title">Build</div>
      <div class="card-body">
        <div class="kv"><span class="k">service</span><span class="v">${escapeHtml(build.service)}</span></div>
        <div class="kv"><span class="k">started</span><span class="v">${escapeHtml(build.startedAt)}</span></div>
        <div class="kv"><span class="k">git</span><span class="v">${escapeHtml(build.gitCommit)}</span></div>
      </div>
    </section>
  `;
}
