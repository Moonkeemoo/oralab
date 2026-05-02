"use strict";
import { fetchJson } from "../api.js";
import { escapeHtml, fmtAge } from "../format.js";

export async function renderMore(root) {
  const [conns, perf, audit, build, lat] = await Promise.all([
    fetchJson("/api/connections"),
    fetchJson("/api/perf"),
    fetchJson("/api/audit?limit=30"),
    fetchJson("/api/build"),
    fetchJson("/api/latency?windowHours=24"),
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
      <div class="card-title">Latency · 24h${lat.bottleneck ? ` · bottleneck: ${escapeHtml(lat.bottleneck)}` : ""}</div>
      <div class="card-body">
        ${(lat.stages || []).length === 0 ? '<span class="muted">no timings yet</span>' : `
          <table class="filters">
            <tr><th>chain</th><th>stage</th><th>avg ms</th><th>count</th></tr>
            ${(lat.stages || []).slice(0, 20).map((s) => `
              <tr>
                <td>${escapeHtml(s.chain)}</td>
                <td>${escapeHtml(s.stage)}</td>
                <td>${s.avgMs.toFixed(0)}</td>
                <td>${s.count}</td>
              </tr>
            `).join("")}
          </table>
        `}
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
