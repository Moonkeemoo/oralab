/* Ora et Labora — Calibrator Sports sub-tab
 * Read-only per-sport-subcategory analytics: sortable table + heatmap.
 * Spec: docs/superpowers/specs/2026-04-26-cal-sports-tab-design.md
 */
(function (App) {
  'use strict';

  const esc = App.esc;
  const t   = App.t;
  const S   = App.state;

  S.calSports = { data: null, sortKey: 'net_pnl', sortDir: 'desc', view: 'pnl' };

  // ── Sport badge classes (pure CSS; styling defined inline) ─────────────────
  const SPORT_BADGE = {
    NBA:     { bg: '#2a0a13', fg: '#f43f5e', bd: '#f43f5e33' },
    NFL:     { bg: '#2e1065', fg: '#a78bfa', bd: '#7c3aed33' },
    NHL:     { bg: '#0c1a2a', fg: '#93c5fd', bd: '#3b82f633' },
    MLB:     { bg: '#1e293b', fg: '#94a3b8', bd: '#33415533' },
    Soccer:  { bg: '#052e16', fg: '#22c55e', bd: '#22c55e33' },
    Tennis:  { bg: '#2e1065', fg: '#c4b5fd', bd: '#7c3aed33' },
    UFC:     { bg: '#4c0519', fg: '#fb7185', bd: '#f43f5e33' },
    Esports: { bg: '#451a03', fg: '#f59e0b', bd: '#f59e0b33' },
    Other:   { bg: '#1e293b', fg: '#64748b', bd: '#33415533' },
  };

  function _badge(sport) {
    const s = SPORT_BADGE[sport] || SPORT_BADGE.Other;
    return `<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:9px;font-weight:600;letter-spacing:.03em;background:${s.bg};color:${s.fg};border:1px solid ${s.bd}">${esc(sport)}</span>`;
  }

  function _wrColor(wr) {
    if (wr > 0.60) return '#22c55e';
    if (wr >= 0.50) return '#f59e0b';
    return '#f43f5e';
  }

  function _pnlColor(p) {
    if (p > 0) return '#22c55e';
    if (p < 0) return '#f43f5e';
    return '#64748b';
  }

  function _fmtPnl(p) {
    if (p == null) return '—';
    const sign = p >= 0 ? '+$' : '−$';
    return sign + Math.abs(p).toFixed(2);
  }

  // ── Heatmap cell color bucket ──────────────────────────────────────────────
  function _cellBg(view, val) {
    if (val == null) return { bg: '#0c0f1a', color: '#1e293b' };
    if (view === 'pnl') {
      if (val >= 1.0)   return { bg: '#16a34a',   color: '#ffffff' };
      if (val >= 0.5)   return { bg: '#16a34a99', color: '#f1f5f9' };
      if (val > 0)      return { bg: '#16a34a55', color: '#dbeafe' };
      if (val === 0)    return { bg: '#1e293b',   color: '#475569' };
      if (val > -0.5)   return { bg: '#f43f5e55', color: '#fecaca' };
      if (val > -1.0)   return { bg: '#f43f5e99', color: '#f1f5f9' };
      return { bg: '#f43f5e', color: '#ffffff' };
    }
    if (view === 'wr') {
      const pct = val * 100;
      if (pct >= 65)    return { bg: '#16a34a',   color: '#ffffff' };
      if (pct >= 55)    return { bg: '#16a34a99', color: '#f1f5f9' };
      if (pct >= 45)    return { bg: '#1e293b',   color: '#cbd5e1' };
      if (pct >= 35)    return { bg: '#f43f5e55', color: '#fecaca' };
      return { bg: '#f43f5e', color: '#ffffff' };
    }
    // count
    if (val >= 10)      return { bg: '#16a34a',   color: '#ffffff' };
    if (val >= 5)       return { bg: '#16a34a99', color: '#f1f5f9' };
    if (val >= 2)       return { bg: '#16a34a55', color: '#dbeafe' };
    if (val >= 1)       return { bg: '#1e293b',   color: '#cbd5e1' };
    return { bg: '#0c0f1a', color: '#1e293b' };
  }

  function _cellText(view, val) {
    if (val == null) return '';
    if (view === 'pnl') return _fmtPnl(val).replace('$', '');
    if (view === 'wr')  return Math.round(val * 100) + '';
    return val + '';
  }

  // ── Table rendering ────────────────────────────────────────────────────────
  function _renderTable(rows) {
    if (!rows || rows.length === 0) {
      return `<div style="padding:24px;text-align:center;color:#64748b;font-size:11px">${esc(t('cal.sports_no_data'))}</div>`;
    }

    const sortKey = S.calSports.sortKey;
    const sortDir = S.calSports.sortDir;
    const sorted = [...rows].sort((a, b) => {
      const av = a[sortKey] != null ? a[sortKey] : 0;
      const bv = b[sortKey] != null ? b[sortKey] : 0;
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? av - bv : bv - av;
    });

    const maxAbs = Math.max(1, ...sorted.map(r => Math.abs(r.net_pnl || 0)));

    const headCell = (key, label) => {
      const active = sortKey === key;
      const arrow = active ? (sortDir === 'asc' ? '↑' : '↓') : '↕';
      const color = active ? '#93c5fd' : '#64748b';
      return `<th data-sort="${key}" style="padding:10px 10px;text-align:right;font-size:10px;color:${color};font-weight:600;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer;user-select:none">${esc(label)} <span style="font-size:8px">${arrow}</span></th>`;
    };

    let h = '<div class="cal-table-wrap"><table style="width:100%;min-width:760px;border-collapse:collapse;background:#0a0e1a;border:1px solid rgba(255,255,255,0.04);border-radius:6px;overflow:hidden">';
    h += '<thead><tr>';
    h += `<th style="padding:10px 10px;text-align:left;font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid rgba(255,255,255,0.06)">${esc(t('cal.sports_col_sport'))}</th>`;
    h += headCell('n', t('cal.sports_col_n'));
    h += headCell('wins', t('cal.sports_col_wins'));
    h += headCell('losses', t('cal.sports_col_losses'));
    h += headCell('net_pnl', t('cal.sports_col_net'));
    h += headCell('wr', t('cal.sports_col_wr'));
    h += headCell('tp_rate', t('cal.sports_col_tp'));
    h += headCell('sl_rate', t('cal.sports_col_sl'));
    h += headCell('avg_dur_min', t('cal.sports_col_dur'));
    h += headCell('avg_bet', t('cal.sports_col_bet'));
    h += `<th style="padding:10px 10px;text-align:left;font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid rgba(255,255,255,0.06)">${esc(t('cal.sports_col_perf'))}</th>`;
    h += '</tr></thead><tbody>';

    sorted.forEach((r, idx) => {
      const rowBg = idx % 2 === 0 ? '#0c0f1a' : '#0e1120';
      const wrPct = (r.wr * 100).toFixed(0) + '%';
      const tpPct = (r.tp_rate * 100).toFixed(0) + '%';
      const slPct = (r.sl_rate * 100).toFixed(0) + '%';
      const barPct = Math.round(Math.abs(r.net_pnl || 0) / maxAbs * 100);
      const barColor = (r.net_pnl || 0) >= 0 ? '#22c55e' : '#f43f5e';
      h += `<tr style="background:${rowBg}">`;
      h += `<td style="padding:9px 10px">${_badge(r.sport)}</td>`;
      h += `<td class="num" style="padding:9px 10px;text-align:right;font-family:ui-monospace,monospace;font-variant-numeric:tabular-nums">${r.n}</td>`;
      h += `<td class="num" style="padding:9px 10px;text-align:right;font-family:ui-monospace,monospace">${r.wins}</td>`;
      h += `<td class="num" style="padding:9px 10px;text-align:right;font-family:ui-monospace,monospace">${r.losses}</td>`;
      h += `<td class="num" style="padding:9px 10px;text-align:right;font-family:ui-monospace,monospace;color:${_pnlColor(r.net_pnl)}">${_fmtPnl(r.net_pnl)}</td>`;
      h += `<td class="num" style="padding:9px 10px;text-align:right;font-family:ui-monospace,monospace;color:${_wrColor(r.wr)}">${wrPct}</td>`;
      h += `<td class="num" style="padding:9px 10px;text-align:right;font-family:ui-monospace,monospace">${tpPct}</td>`;
      h += `<td class="num" style="padding:9px 10px;text-align:right;font-family:ui-monospace,monospace">${slPct}</td>`;
      h += `<td class="num" style="padding:9px 10px;text-align:right;font-family:ui-monospace,monospace">${Math.round(r.avg_dur_min)}m</td>`;
      h += `<td class="num" style="padding:9px 10px;text-align:right;font-family:ui-monospace,monospace">$${r.avg_bet.toFixed(2)}</td>`;
      h += `<td style="padding:9px 10px"><div style="display:inline-flex;align-items:center;gap:6px;min-width:110px"><div style="flex:1;height:6px;background:rgba(255,255,255,0.05);border-radius:3px;overflow:hidden"><div style="height:100%;width:${barPct}%;background:${barColor};border-radius:3px"></div></div><span style="font-size:9px;color:#475569;font-family:ui-monospace,monospace;width:32px;text-align:right">${barPct}%</span></div></td>`;
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }

  // ── Heatmap rendering ──────────────────────────────────────────────────────
  function _renderHeatmap(hm) {
    if (!hm || !hm.sports || hm.sports.length === 0) return '';
    const view = S.calSports.view;
    const cells = view === 'pnl' ? hm.cells_pnl : view === 'wr' ? hm.cells_wr : hm.cells_count;

    let h = '<div style="background:#0a0e1a;border:1px solid rgba(255,255,255,0.04);border-radius:6px;padding:14px;overflow-x:auto">';
    h += '<div style="display:grid;grid-template-columns:80px repeat(24, 1fr);gap:2px;font-size:9px;font-family:ui-monospace,monospace;min-width:800px">';
    // Header row
    h += '<div></div>';
    for (let i = 0; i < 24; i++) {
      h += `<div style="color:#475569;text-align:center;padding:4px 0;font-weight:600">${i.toString().padStart(2,'0')}</div>`;
    }
    // Rows
    hm.sports.forEach((sport, sIdx) => {
      h += `<div style="color:#94a3b8;padding:6px 8px 6px 0;text-align:right;font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:flex-end">${_badge(sport)}</div>`;
      for (let hour = 0; hour < 24; hour++) {
        const v = cells[sIdx][hour];
        const c = _cellBg(view, v);
        const txt = _cellText(view, v);
        const tooltip = v != null
          ? `${sport} @ ${hour}:00 — ${view}: ${view === 'pnl' ? _fmtPnl(v) : view === 'wr' ? (Math.round(v*100)+'%') : v + ' trades'} (${hm.cells_count[sIdx][hour]} trades)`
          : `${sport} @ ${hour}:00 — no data`;
        h += `<div title="${esc(tooltip)}" style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;border-radius:2px;background:${c.bg};color:${c.color};font-weight:600;min-height:24px;font-size:9px">${esc(txt)}</div>`;
      }
    });
    h += '</div></div>';
    return h;
  }

  // ── View toggle controls ──────────────────────────────────────────────────
  function _renderViewControls() {
    const cur = S.calSports.view;
    const btn = (key, label) => {
      const active = cur === key;
      const color = active ? '#93c5fd' : '#475569';
      const bg = active ? '#0c1a2a' : 'transparent';
      const bd = active ? '#93c5fd' : '#33415555';
      return `<button data-view="${key}" style="padding:3px 10px;border-radius:3px;background:${bg};cursor:pointer;font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:9px;color:${color};border:1px solid ${bd}">${esc(label)}</button>`;
    };
    let h = '<div style="display:flex;gap:8px;margin-bottom:8px;align-items:center;font-size:10px;color:#64748b;padding-left:11px">';
    h += '<span style="margin-right:8px">View:</span>';
    h += btn('pnl', t('cal.sports_view_pnl'));
    h += btn('wr', t('cal.sports_view_wr'));
    h += btn('count', t('cal.sports_view_count'));
    h += '</div>';
    return h;
  }

  // ── Section header ─────────────────────────────────────────────────────────
  function _sectionHeader(barColor, titleText, descText) {
    return `
      <div style="display:flex;align-items:center;gap:8px;margin:24px 0 6px">
        <div style="width:3px;height:14px;background:${barColor};border-radius:2px;flex-shrink:0"></div>
        <span style="font-size:11px;font-weight:700;color:#f1f5f9;text-transform:uppercase;letter-spacing:.06em">${esc(titleText)}</span>
      </div>
      <div style="font-size:10px;color:#64748b;line-height:1.5;margin-bottom:12px;padding-left:11px">${esc(descText)}</div>`;
  }

  function _render() {
    const pane = document.getElementById('calTabSports');
    if (!pane) return;
    const data = S.calSports.data;
    if (!data) {
      pane.innerHTML = '<div style="padding:24px;text-align:center;color:#64748b;font-size:11px">Loading…</div>';
      return;
    }

    let h = '';
    h += `<div style="font-size:11px;color:#64748b;margin-bottom:8px">${esc(t('cal.sports_title'))} · ${data.meta.total_trades} trades · ${data.meta.window_h}h window</div>`;

    // Section A — table
    h += _sectionHeader('#22c55e', t('cal.sports_title'), t('cal.sports_desc_table'));
    h += _renderTable(data.table);

    // Section C — heatmap
    h += _sectionHeader('#a78bfa', 'Hour-of-day heatmap', t('cal.sports_desc_heatmap'));
    h += _renderViewControls();
    h += _renderHeatmap(data.heatmap);

    pane.innerHTML = h;

    // Wire up sort clicks
    pane.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.getAttribute('data-sort');
        if (S.calSports.sortKey === k) {
          S.calSports.sortDir = S.calSports.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          S.calSports.sortKey = k;
          S.calSports.sortDir = 'desc';
        }
        _render();
      });
    });

    // Wire up view toggle
    pane.querySelectorAll('button[data-view]').forEach(b => {
      b.addEventListener('click', () => {
        S.calSports.view = b.getAttribute('data-view');
        _render();
      });
    });
  }

  async function load() {
    try {
      const data = await App.fetchJSON('/api/polymarket/calibration/sports?window_h=72');
      S.calSports.data = data;
      _render();
    } catch (e) {
      console.error('[cal-sports] load failed', e);
      const pane = document.getElementById('calTabSports');
      if (pane) pane.innerHTML = `<div style="padding:24px;text-align:center;color:#f43f5e;font-size:11px">Load error: ${esc(String(e))}</div>`;
    }
  }

  window.CalSports = { load };
})(window.App);
