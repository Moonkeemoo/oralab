/* Ora et Labora — Calibrator Log sub-tab */
/* Trace audit log table with color-coded action badges */

(function (App) {
  'use strict';

  const esc = App.esc;

  // ── Action badge config ────────────────────────────────────────────────────
  const ACTION_BADGE = {
    cycle_start:     { color: '#6366f1', bg: '#1e1b4b', border: '#4f46e533' },
    cycle_complete:  { color: '#22c55e', bg: '#052e16', border: '#22c55e33' },
    thermostat:      { color: '#3b82f6', bg: '#0c1a2e', border: '#3b82f633' },
    attribution:     { color: '#22d3ee', bg: '#0c1a2e', border: '#0891b233' },
    bayesian:        { color: '#a78bfa', bg: '#2e1065', border: '#7c3aed33' },
    recommendations: { color: '#f59e0b', bg: '#1c1003', border: '#f59e0b33' },
    overlay_write:   { color: '#22c55e', bg: '#052e16', border: '#22c55e33' },
    overlay_remove:  { color: '#94a3b8', bg: '#1e293b', border: '#33415533' },
    manual_apply:    { color: '#22c55e', bg: '#052e16', border: '#22c55e33' },
    auto_applied:    { color: '#22c55e', bg: '#052e16', border: '#22c55e33' },
    skip:            { color: '#64748b', bg: '#0f172a', border: '#33415533' },
    rollback_all:    { color: '#f43f5e', bg: '#2d0a14', border: '#f43f5e33' },
    safety_rollback: { color: '#f43f5e', bg: '#2d0a14', border: '#f43f5e33' },
    cycle_error:     { color: '#f43f5e', bg: '#2d0a14', border: '#f43f5e33' },
    verify_failed:   { color: '#f59e0b', bg: '#1c1003', border: '#f59e0b33' },
    // Multi-KPI (2026-04-22 rework) — purple to flag the new Layer-3 actions.
    weights:         { color: '#a78bfa', bg: '#2e1065', border: '#7c3aed33' },
    lift_matrix:     { color: '#c4b5fd', bg: '#2e1065', border: '#7c3aed33' },
  };

  // Actions introduced by the Multi-KPI Objective rework get a tiny [NEW]
  // badge so operators can scan the log for new code paths.
  const NEW_ACTIONS = new Set(['weights', 'lift_matrix']);

  const DEFAULT_BADGE = { color: '#94a3b8', bg: '#1e293b', border: '#33415533' };

  // ── Action badge HTML ──────────────────────────────────────────────────────
  function _actionBadge(action) {
    const s = ACTION_BADGE[action] || DEFAULT_BADGE;
    const newTag = NEW_ACTIONS.has(action)
      ? `<span style="display:inline-block;font-size:7px;font-weight:800;margin-left:4px;padding:1px 4px;border-radius:3px;background:#a78bfa;color:#0a0a0a;letter-spacing:.04em">${App.t('cal.new_tag')}</span>`
      : '';
    return `<span style="display:inline-block;font-size:9px;font-weight:600;font-family:monospace;padding:2px 8px;border-radius:10px;background:${s.bg};color:${s.color};border:1px solid ${s.border};white-space:nowrap">${esc(action)}</span>${newTag}`;
  }

  // ── Format timestamp as HH:MM:SS ──────────────────────────────────────────
  function _fmtTime(ts) {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleTimeString('uk-UA', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  // ── Build details string from trace entry ─────────────────────────────────
  // Excludes trace_id, ts, action (shown in other columns)
  const SKIP_FIELDS = new Set(['trace_id', 'ts', 'action']);

  function _detailsStr(entry) {
    const parts = [];
    for (const [k, v] of Object.entries(entry)) {
      if (SKIP_FIELDS.has(k)) continue;
      if (v == null) continue;
      const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
      parts.push(`${k}: ${valStr}`);
    }
    return parts.join(', ');
  }

  // ── Status indicator for action type ──────────────────────────────────────
  function _statusDot(action) {
    const isError = action === 'cycle_error' || action === 'verify_failed' || action === 'safety_rollback';
    const isOk    = action === 'cycle_complete' || action === 'overlay_write' || action === 'manual_apply' || action === 'auto_applied';
    if (isError) return `<span style="color:#f43f5e;font-size:10px">✕</span>`;
    if (isOk)    return `<span style="color:#22c55e;font-size:10px">✓</span>`;
    return `<span style="color:#475569;font-size:10px">·</span>`;
  }

  // ── Table row HTML ─────────────────────────────────────────────────────────
  function _traceRow(entry, idx) {
    const isEven = idx % 2 === 0;
    const rowBg  = isEven ? '#0c0f1a' : '#0e1120';
    const time    = _fmtTime(entry.ts);
    const traceId = entry.trace_id || '—';
    const details = _detailsStr(entry);

    return `
      <tr style="background:${rowBg};border-bottom:1px solid rgba(255,255,255,0.04)">
        <td style="padding:8px 12px;font-size:10px;color:#94a3b8;white-space:nowrap;font-family:monospace">${esc(time)}</td>
        <td style="padding:8px 12px">
          <span style="font-family:monospace;font-size:9px;color:#93c5fd;letter-spacing:.02em" title="${esc(traceId)}">${esc(traceId)}</span>
        </td>
        <td style="padding:8px 12px;white-space:nowrap">${_actionBadge(entry.action || '—')}</td>
        <td style="padding:8px 12px;font-size:10px;color:#64748b;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(details)}">${esc(details) || '<span style="color:#1e293b">—</span>'}</td>
        <td style="padding:8px 12px;text-align:center">${_statusDot(entry.action || '')}</td>
      </tr>`;
  }

  // ── Section header with refresh button ────────────────────────────────────
  function _header() {
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:3px;height:14px;background:#6366f1;border-radius:2px;flex-shrink:0"></div>
          <span style="font-size:11px;font-weight:700;color:#f1f5f9;text-transform:uppercase;letter-spacing:.06em">${esc(App.t('cal.log_title'))}</span>
        </div>
        <button
          onclick="CalLog.refresh()"
          style="padding:5px 13px;border-radius:6px;font-size:10px;font-weight:600;cursor:pointer;background:#1e293b;color:#93c5fd;border:1px solid rgba(255,255,255,0.08)">
          ${esc(App.t('cal.log_refresh'))}
        </button>
      </div>`;
  }

  // ── Timestamp footer ───────────────────────────────────────────────────────
  function _tsFooter(ts, count) {
    if (!ts) return '';
    const time = new Date(ts * 1000).toLocaleTimeString('uk-UA', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    return `<div style="font-size:9px;color:#475569;text-align:right;margin-top:6px">${App.t('cal.log_footer', {count, time})}</div>`;
  }

  // ── Main module ────────────────────────────────────────────────────────────
  const CalLog = {

    async load() {
      const el = document.getElementById('calTabLog');
      if (!el) return;

      el.innerHTML = `<div style="color:#475569;font-size:12px;padding:24px 0;text-align:center">${esc(App.t('cal.loading'))}</div>`;

      let data;
      try {
        data = await App.fetchJSON('/api/polymarket/calibration/traces?limit=100');
      } catch (e) {
        el.innerHTML = `<div style="color:#f43f5e;font-size:12px;padding:24px 0;text-align:center">${esc(App.t('cal.load_error', {error: e.message}))}</div>`;
        return;
      }

      this.render(data);
    },

    render(data) {
      const el = document.getElementById('calTabLog');
      if (!el) return;

      const traces = (data && Array.isArray(data.traces)) ? data.traces : [];
      const ts     = data && data.ts;

      if (!traces.length) {
        el.innerHTML = `
          <div style="padding:2px 0">
            ${_header()}
            <div style="background:#0c0f1a;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:40px;text-align:center;color:#475569;font-size:12px">
              ${esc(App.t('cal.log_empty'))}
            </div>
          </div>`;
        return;
      }

      const rows = traces.map((entry, i) => _traceRow(entry, i)).join('');

      el.innerHTML = `
        <div style="padding:2px 0">
          ${_header()}
          <div style="border:1px solid rgba(255,255,255,0.06);border-radius:10px;overflow:hidden">
            <table style="width:100%;border-collapse:collapse">
              <thead>
                <tr style="background:#111520;border-bottom:1px solid rgba(255,255,255,0.08)">
                  <th style="padding:8px 12px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:left;white-space:nowrap">${esc(App.t('cal.log_time'))}</th>
                  <th style="padding:8px 12px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:left">Trace ID</th>
                  <th style="padding:8px 12px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:left">${esc(App.t('cal.log_action'))}</th>
                  <th style="padding:8px 12px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:left">${esc(App.t('cal.log_details'))}</th>
                  <th style="padding:8px 12px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:center">${esc(App.t('cal.log_status'))}</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          ${_tsFooter(ts, traces.length)}
        </div>`;
    },

    async refresh() {
      await this.load();
      App.toast(App.t('cal.log_refreshed'), 'ok');
    },
  };

  window.CalLog = CalLog;

})(window.App);
