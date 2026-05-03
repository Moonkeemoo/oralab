/* Ora et Labora — Calibrator Exit sub-tab */
/* Closure breakdown + per-parameter analysis cards + params table */

(function (App) {
  'use strict';

  const esc = App.esc;

  // ── Closure reason colors ──────────────────────────────────────────────────
  const _REASON_COLORS = {
    tp_fok:               '#22c55e',
    sl_fok:               '#f43f5e',
    sl_emergency:         '#fb923c',
    sl_aggressive:        '#f43f5e',
    trailing_stop:        '#38bdf8',
    whale_exit:           '#a78bfa',
    time_expiry:          '#f59e0b',
    price_resolved:       '#64748b',
    market_resolved_win:  '#22c55e',
    market_resolved_loss: '#f43f5e',
    write_off:            '#64748b',
  };

  function _reasonColor(reason) {
    return _REASON_COLORS[reason] || '#94a3b8';
  }

  function _reasonLabel(reason) {
    return App.t('cal.cr_' + reason) || reason;
  }

  function _pnlColor(v) {
    return v > 0 ? '#22c55e' : v < 0 ? '#f43f5e' : '#94a3b8';
  }

  function _fmtPnl(v) {
    if (v == null) return '—';
    return (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);
  }

  function _fmtPct(v) {
    if (v == null) return '—';
    return (v * 100).toFixed(0) + '%';
  }

  function _fmtDuration(h) {
    if (h == null) return '—';
    return h.toFixed(1) + 'h';
  }

  // ── Multi-KPI Lift matrix (2026-04-22 rework) ─────────────────────────────
  function _liftFmt(kpi, v) {
    if (v == null || isNaN(v)) return '—';
    const rates = ['win_rate', 'pass_rate', 'sl_rate', 'tp_hit_rate',
                   'exit_efficiency', 'left_on_table'];
    if (rates.includes(kpi)) {
      const s = v > 0 ? '+' : '';
      return s + (v * 100).toFixed(0) + 'pp';
    }
    if (kpi === 'avg_pnl') return (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);
    if (kpi === 'profit_factor') return (v >= 0 ? '+' : '') + v.toFixed(2);
    return (v >= 0 ? '+' : '') + v.toFixed(3);
  }

  function _liftColor(kpi, v) {
    if (v == null || v === 0) return '#64748b';
    const lower = (kpi === 'sl_rate' || kpi === 'left_on_table');
    const good = lower ? v < 0 : v > 0;
    return good ? '#4ade80' : '#f43f5e';
  }

  function _confColor(c) {
    if (c == null) return '#64748b';
    if (c >= 0.70) return '#22d3ee';
    if (c >= 0.50) return '#f59e0b';
    return '#94a3b8';
  }

  function _liftRow(row, threshold, isHead) {
    const cols = 'grid-template-columns:minmax(180px,2fr) repeat(6,minmax(0,1fr))';
    if (isHead) {
      const h = t => `<div style="text-align:center;font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:.05em;font-weight:600">${esc(t)}</div>`;
      return `
        <div style="display:grid;${cols};gap:8px;align-items:center;padding:4px 12px 8px">
          <div style="font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:.05em;font-weight:600">${App.t('cal.lift_col_param')}</div>
          ${h('Δ sl_rate')}${h('Δ tp_hit')}${h('Δ eff')}${h('Δ LoT')}${h('Conf')}${h('Score')}
        </div>`;
    }
    const lift = row.lift || {};
    const score = row.score != null ? Number(row.score) : 0;
    const above = score >= threshold;
    const bg = above ? 'background:rgba(34,197,94,0.04);' : '';
    const cfg = row.config_key || '';
    const delta = row.delta != null ? row.delta : '';
    const dirText = row.direction + (delta !== '' ? ' ' + (delta >= 0 ? '+' : '') + delta : '');

    const mk = (kpi) => {
      const v = lift[kpi] != null ? Number(lift[kpi]) : null;
      const col = _liftColor(kpi, v);
      return `<div style="text-align:center;font-family:ui-monospace,Menlo,monospace;font-weight:600;color:${col};font-size:11px">${esc(_liftFmt(kpi, v))}</div>`;
    };

    const confVal = row.confidence != null ? Number(row.confidence) : null;
    const confStr = confVal != null ? confVal.toFixed(2) : '—';
    const scoreStr = (score >= 0 ? '+' : '') + score.toFixed(2);
    const scoreCol = above ? '#4ade80' : score < 0 ? '#f43f5e' : '#94a3b8';

    return `
      <div style="display:grid;${cols};gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:11px;${bg}">
        <div>
          <div style="font-weight:600;color:#f1f5f9">${esc(row.human_name || cfg || '—')}</div>
          <div style="font-family:ui-monospace,Menlo,monospace;font-size:9px;color:#64748b">${esc(cfg)} · ${esc(dirText)}</div>
        </div>
        ${mk('sl_rate')}${mk('tp_hit_rate')}${mk('exit_efficiency')}${mk('left_on_table')}
        <div style="text-align:center;font-family:ui-monospace,Menlo,monospace;font-weight:600;color:${_confColor(confVal)};font-size:11px">${esc(confStr)}</div>
        <div style="text-align:center;font-family:ui-monospace,Menlo,monospace;font-weight:700;color:${scoreCol};font-size:11px">${esc(scoreStr)}</div>
      </div>`;
  }

  function _renderLiftMatrix(rows, threshold) {
    const hasRows = rows && rows.length;
    const thrStr = threshold != null ? Number(threshold).toFixed(2) : '0.08';
    const body = hasRows
      ? rows.map(r => _liftRow(r, threshold, false)).join('')
      : `<div style="padding:22px 14px;text-align:center;color:#64748b;font-size:11px;line-height:1.6">
           ${App.t('cal.lift_matrix_empty', {threshold: thrStr})}
         </div>`;
    const headerRow = hasRows ? _liftRow(null, threshold, true) : '';
    return `
      <div style="margin-bottom:20px;background:#0c0f1a;border:1px solid rgba(167,139,250,0.22);border-radius:12px;padding:14px 4px;position:relative">
        <div style="position:absolute;top:-7px;left:14px;background:#a78bfa;color:#0a0a0a;font-size:8px;font-weight:800;padding:2px 7px;border-radius:3px;letter-spacing:.06em">${App.t('cal.new_tag')}</div>
        <div style="display:flex;align-items:center;gap:8px;padding:0 12px 10px">
          <div style="width:3px;height:14px;background:#a78bfa;border-radius:2px"></div>
          <span style="font-size:11px;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:.06em">${App.t('cal.lift_matrix_exit_title')}</span>
          <span style="font-size:9px;background:rgba(167,139,250,0.15);color:#c4b5fd;border:1px solid rgba(167,139,250,0.3);border-radius:10px;padding:1px 7px;font-weight:600">multi-KPI</span>
        </div>
        <div class="cal-table-wrap"><div style="min-width:540px">
          ${headerRow}
          ${body}
        </div></div>
        <div style="padding:10px 12px 2px;font-size:10px;color:#94a3b8;line-height:1.5">
          ${App.t('cal.lift_matrix_exit_hint')}
        </div>
      </div>`;
  }

  // ── Section header ─────────────────────────────────────────────────────────
  function _sectionHeader(title, badge) {
    const badgeHtml = badge != null
      ? `<span style="font-size:8px;border-radius:10px;padding:2px 7px;font-weight:600;background:#f59e0b22;color:#fbbf24;border:1px solid #f59e0b33;margin-left:6px">${esc(String(badge))}</span>`
      : '';
    return `
      <div style="display:flex;align-items:center;gap:8px;margin:24px 0 14px">
        <div style="width:3px;height:14px;background:#f59e0b;border-radius:2px;flex-shrink:0"></div>
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#f1f5f9">${esc(title)}</span>
        ${badgeHtml}
      </div>`;
  }

  // ── Section 1: Closure breakdown table ────────────────────────────────────
  function _renderBreakdown(breakdown, total) {
    if (!breakdown || !breakdown.length) {
      return `${_sectionHeader(App.t('cal.exit_section_breakdown'))}
        <div style="background:#0c0f1a;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:20px;text-align:center;color:#475569;font-size:12px">No exit data yet</div>`;
    }

    const rows = breakdown.map(item => {
      const color = _reasonColor(item.reason);
      const label = _reasonLabel(item.reason);
      const sharePct = Math.round((item.share || 0) * 100);
      const pnlColor = _pnlColor(item.avg_pnl);
      const totalColor = _pnlColor(item.total_pnl);

      return `
        <tr>
          <td style="padding:8px 12px;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.03)">
            <span style="color:${color};font-weight:600">${esc(label)}</span>
          </td>
          <td style="padding:8px 12px;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.03);font-family:monospace">
            ${item.count}
          </td>
          <td style="padding:8px 12px;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.03);min-width:160px">
            <div style="display:flex;align-items:center;gap:8px">
              <div style="height:6px;border-radius:3px;background:#1e293b;flex:1;max-width:120px;overflow:hidden">
                <div style="height:100%;width:${sharePct}%;background:${color};border-radius:3px;transition:width .3s"></div>
              </div>
              <span style="font-size:9px;color:#64748b;min-width:28px;font-family:monospace">${sharePct}%</span>
            </div>
          </td>
          <td style="padding:8px 12px;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.03);text-align:right;font-family:monospace;color:${pnlColor}">
            ${esc(_fmtPnl(item.avg_pnl))}
          </td>
          <td style="padding:8px 12px;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.03);text-align:right;font-family:monospace;color:${totalColor}">
            ${esc(_fmtPnl(item.total_pnl))}
          </td>
          <td style="padding:8px 12px;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.03);text-align:center;color:#94a3b8;font-family:monospace">
            ${esc(_fmtDuration(item.avg_duration_h))}
          </td>
        </tr>`;
    }).join('');

    return `
      ${_sectionHeader(App.t('cal.exit_section_breakdown'), total + ' closed')}
      <div class="cal-table-wrap" style="background:#0c0f1a;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:2px;margin-bottom:10px">
        <table style="width:100%;min-width:640px;border-collapse:collapse">
          <thead>
            <tr>
              <th style="padding:8px 12px;font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:left;border-bottom:1px solid rgba(255,255,255,0.06)">${esc(App.t('cal.exit_reason'))}</th>
              <th style="padding:8px 12px;font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:left;border-bottom:1px solid rgba(255,255,255,0.06)">${esc(App.t('cal.exit_count'))}</th>
              <th style="padding:8px 12px;font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:left;border-bottom:1px solid rgba(255,255,255,0.06);min-width:160px">${esc(App.t('cal.exit_share'))}</th>
              <th style="padding:8px 12px;font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:right;border-bottom:1px solid rgba(255,255,255,0.06)">${esc(App.t('cal.exit_avg_pnl'))}</th>
              <th style="padding:8px 12px;font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:right;border-bottom:1px solid rgba(255,255,255,0.06)">${esc(App.t('cal.exit_total_pnl'))}</th>
              <th style="padding:8px 12px;font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:center;border-bottom:1px solid rgba(255,255,255,0.06)">${esc(App.t('cal.exit_avg_duration'))}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-bottom:20px;padding:10px 14px;background:rgba(167,139,250,0.06);border-left:3px solid #a78bfa;border-radius:0 8px 8px 0;font-size:10.5px;color:#cbd5e1;line-height:1.6">
        <strong style="color:#c4b5fd">${App.t('cal.tip_how_read')}:</strong> ${App.t('cal.tip_closure_body')}
      </div>`;
  }

  // ── Analysis card helper ───────────────────────────────────────────────────
  function _analysisRow(label, valueHtml) {
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.03)">
        <span style="font-size:10px;color:#94a3b8">${esc(label)}</span>
        <span style="font-size:12px;font-weight:700;font-family:monospace">${valueHtml}</span>
      </div>`;
  }

  function _analysisCard(title, rows, hint) {
    const hintHtml = hint
      ? `<div style="font-size:9px;color:#64748b;margin-top:8px;line-height:1.4;font-style:italic">${esc(hint)}</div>`
      : '';
    return `
      <div style="background:#0c0f1a;border:1px solid rgba(245,158,11,0.1);border-radius:10px;padding:16px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#fbbf24;margin-bottom:12px">${esc(title)}</div>
        ${rows}
        ${hintHtml}
      </div>`;
  }

  // ── Section 2: Analysis cards ──────────────────────────────────────────────
  function _renderAnalysis(analysis) {
    if (!analysis) return '';

    const tp = analysis.tp || {};
    const sl = analysis.sl || {};
    const trail = analysis.trail || {};
    const time = analysis.time || {};

    // TP card
    const tpTitle = `Take Profit (${((tp.current_value || 0) * 100).toFixed(0)}%)`;
    const leftOnTablePct = (tp.avg_peak_pnl && tp.avg_peak_pnl > 0)
      ? Math.round(((tp.left_on_table || 0) / tp.avg_peak_pnl) * 100)
      : 0;
    const tpRows = [
      _analysisRow(App.t('cal.exit_tp_exits'),
        `<span style="color:#22c55e">${tp.count || 0}</span> <span style="font-size:9px;color:#64748b;font-weight:400">/ ${tp.total || 0}</span>`),
      _analysisRow(App.t('cal.exit_avg_pnl_at_tp'),
        `<span style="color:${_pnlColor(tp.avg_pnl)}">${_fmtPnl(tp.avg_pnl)}</span>`),
      _analysisRow(App.t('cal.exit_avg_peak_pnl'),
        `<span style="color:#fbbf24">${_fmtPnl(tp.avg_peak_pnl)}</span>`),
      _analysisRow(App.t('cal.exit_left_on_table_detail'),
        `<span style="color:#f43f5e">${_fmtPnl(tp.left_on_table)} <span style="font-size:8px;border-radius:3px;padding:1px 5px;font-weight:500;background:#3b0a0a80;color:#fca5a5;border:1px solid #f43f5e33">${leftOnTablePct}%</span></span>`),
    ].join('');
    const tpHint = (tp.left_on_table || 0) > 0.3
      ? 'TP спрацьовує зарано — більшість трейдів продовжували рости після TP.'
      : 'TP parameters balanced.';
    const tpCard = _analysisCard(tpTitle, tpRows, tpHint);

    // SL card
    const slTitle = `Stop Loss (${((sl.current_value || 0) * 100).toFixed(0)}%)`;
    const slRateHigh = (sl.sl_rate || 0) > 0.3;
    const slBadgeColor = slRateHigh ? 'background:#f59e0b18;color:#fbbf24;border:1px solid #f59e0b33' : 'background:#1e293b;color:#64748b;border:1px solid rgba(255,255,255,0.06)';
    const slBadgeLabel = slRateHigh ? 'high' : 'normal';
    const slRows = [
      _analysisRow(App.t('cal.exit_sl_exits'),
        `<span style="color:#f43f5e">${sl.count || 0}</span> <span style="font-size:9px;color:#64748b;font-weight:400">/ ${sl.total || 0}</span>`),
      _analysisRow(App.t('cal.exit_avg_loss_at_sl'),
        `<span style="color:${_pnlColor(sl.avg_pnl)}">${_fmtPnl(sl.avg_pnl)}</span>`),
      _analysisRow(App.t('cal.kpi_sl_rate'),
        `<span style="color:#f59e0b">${_fmtPct(sl.sl_rate)} <span style="font-size:8px;border-radius:3px;padding:1px 5px;font-weight:500;${slBadgeColor}">${slBadgeLabel}</span></span>`),
      _analysisRow(App.t('cal.exit_had_positive_peak'),
        `<span style="color:#fbbf24">${sl.had_positive_peak || 0}</span> <span style="font-size:9px;color:#64748b;font-weight:400">/ ${sl.count || 0}</span>`),
      _analysisRow(App.t('cal.exit_emergency_count'),
        `<span style="color:#fb923c">${sl.emergency_count || 0}</span>`),
    ].join('');
    const slHint = slRateHigh
      ? `${_fmtPct(sl.sl_rate)} SL rate — on the high side. ${sl.had_positive_peak || 0} trades had positive peak before SL hit — possible timing issue or SL too tight.`
      : 'SL rate acceptable.';
    const slCard = _analysisCard(slTitle, slRows, slHint);

    // Trail card
    const trailTitle = `Trailing Stop (activate ${((trail.current_activate || 0) * 100).toFixed(0)}%, stop ${((trail.current_stop || 0) * 100).toFixed(0)}%)`;
    const trailActivationRate = (trail.total || 0) > 0 ? (trail.activated || 0) / (trail.total || 1) : 0;
    const trailRows = [
      _analysisRow(App.t('cal.exit_trail_exits'),
        `<span style="color:#38bdf8">${trail.count || 0}</span> <span style="font-size:9px;color:#64748b;font-weight:400">/ ${trail.total || 0}</span>`),
      _analysisRow(App.t('cal.exit_avg_pnl_at_tp'),
        `<span style="color:${_pnlColor(trail.avg_pnl)}">${_fmtPnl(trail.avg_pnl)}</span>`),
      _analysisRow(App.t('cal.exit_avg_peak_capture'),
        `<span style="color:#22c55e">${trail.avg_peak_capture != null ? Math.round(trail.avg_peak_capture * 100) + '%' : '—'}</span>`),
      _analysisRow(App.t('cal.exit_trail_activated'),
        `<span style="color:#94a3b8">${trail.activated || 0}</span> <span style="font-size:9px;color:#64748b;font-weight:400">/ ${trail.total || 0}</span>`),
    ].join('');
    const trailHint = (trail.count || 0) === 0
      ? 'No trailing stop exits yet — trail has not fired.'
      : trailActivationRate < 0.1
        ? `Trail activates rarely (${(trail.activated || 0)}/${trail.total || 0} trades). Consider lowering activate threshold.`
        : `Trail is working well — ${_fmtPct(trail.avg_peak_capture)} of peak captured on average.`;
    const trailCard = _analysisCard(trailTitle, trailRows, trailHint);

    // Time card
    const timeTitle = 'Time & Duration';
    const timeRows = [
      _analysisRow(App.t('cal.exit_time_exits'),
        `<span style="color:#f59e0b">${time.count || 0}</span> <span style="font-size:9px;color:#64748b;font-weight:400">/ ${time.total || 0}</span>`),
      _analysisRow(App.t('cal.exit_avg_pnl_at_tp'),
        `<span style="color:${_pnlColor(time.avg_pnl)}">${_fmtPnl(time.avg_pnl)}</span>`),
      _analysisRow(App.t('cal.exit_time_before_res'),
        `<span style="color:#94a3b8">${time.current_time_h != null ? time.current_time_h.toFixed(1) + 'h' : '—'}</span>`),
      _analysisRow(App.t('cal.exit_min_sl_age'),
        `<span style="color:#94a3b8">${time.current_min_sl_age != null ? time.current_min_sl_age + 's' : '—'}</span>`),
      _analysisRow(App.t('cal.exit_avg_hold'),
        `<span style="color:#94a3b8">${_fmtDuration(time.avg_duration_h)}</span>`),
    ].join('');
    const timeHint = (time.count || 0) > 0
      ? `${time.count} trade${time.count > 1 ? 's' : ''} exited by time expiry with avg PnL ${_fmtPnl(time.avg_pnl)}. These trades reached neither TP nor SL — sideways pattern.`
      : 'No time expiry exits yet.';
    const timeCard = _analysisCard(timeTitle, timeRows, timeHint);

    return `
      ${_sectionHeader(App.t('cal.exit_section_analysis'))}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        ${tpCard}
        ${slCard}
        ${trailCard}
        ${timeCard}
      </div>`;
  }

  // ── Section 3: Params summary (default → current) ──────────────────────────
  function _renderParams(params) {
    if (!params || !params.length) return '';

    const changedCount = params.filter(p => p.changed).length;

    const rows = params.map(p => {
      const unit = p.unit || '';
      const fmtVal = v => {
        if (v == null) return '—';
        if (unit === '%') return (v * 100).toFixed(0) + '%';
        if (unit === 'h') return v.toFixed(1) + 'h';
        if (unit === 'sec') return v + 's';
        return String(v);
      };
      const defStr = fmtVal(p.default);
      const curStr = fmtVal(p.current);
      const curColor = p.changed ? '#fbbf24' : '#64748b';

      return `
        <tr>
          <td style="padding:7px 10px;font-size:10px;color:#f1f5f9;font-weight:600;border-bottom:1px solid rgba(255,255,255,0.03)">${esc(p.label || p.key)}</td>
          <td style="padding:7px 10px;font-size:10px;color:#64748b;text-align:center;font-family:monospace;border-bottom:1px solid rgba(255,255,255,0.03)">${esc(defStr)}</td>
          <td style="padding:7px 10px;font-size:10px;color:${curColor};text-align:center;font-weight:600;font-family:monospace;border-bottom:1px solid rgba(255,255,255,0.03)">${esc(curStr)}</td>
        </tr>`;
    }).join('');

    return `
      ${_sectionHeader(App.t('cal.exit_section_params'), changedCount + ' ' + App.t('cal.exit_changed'))}
      <div class="cal-table-wrap" style="background:#0c0f1a;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:2px;margin-bottom:10px">
        <table style="width:100%;min-width:480px;border-collapse:collapse">
          <thead>
            <tr>
              <th style="padding:7px 10px;font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:left;border-bottom:1px solid rgba(255,255,255,0.06)">${esc(App.t('cal.exit_param_name'))}</th>
              <th style="padding:7px 10px;font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:center;border-bottom:1px solid rgba(255,255,255,0.06)">${esc(App.t('cal.history_before'))}</th>
              <th style="padding:7px 10px;font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:center;border-bottom:1px solid rgba(255,255,255,0.06)">${esc(App.t('cal.history_after'))}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="padding:10px 14px;background:rgba(167,139,250,0.06);border-left:3px solid #a78bfa;border-radius:0 8px 8px 0;font-size:10.5px;color:#cbd5e1;line-height:1.6">
        <strong style="color:#c4b5fd">${App.t('cal.tip_how_read')}:</strong> ${App.t('cal.tip_params_body')}
      </div>`;
  }

  // ── Main module ────────────────────────────────────────────────────────────
  const CalExit = {

    async load() {
      const el = document.getElementById('calTabExit');
      if (!el) return;
      el.innerHTML = `<div style="color:#475569;font-size:12px;padding:24px 0;text-align:center">${esc(App.t('cal.loading'))}</div>`;

      let data;
      try {
        data = await App.fetchJSON('/api/polymarket/calibration/exit');
      } catch (e) {
        el.innerHTML = `<div style="color:#f43f5e;font-size:12px;padding:24px 0;text-align:center">${esc(App.t('cal.load_error', {error: e.message}))}</div>`;
        return;
      }

      this.render(data);
    },

    render(data) {
      const el = document.getElementById('calTabExit');
      if (!el) return;

      if (!data || !data.total) {
        el.innerHTML = `
          <div style="text-align:center;padding:48px 0;color:#475569">
            <div style="font-size:13px;font-weight:600;color:#94a3b8">No closed trades yet</div>
            <div style="font-size:11px;margin-top:6px">Exit analysis will appear after the first trades close.</div>
          </div>`;
        return;
      }

      const breakdownHtml = _renderBreakdown(data.breakdown, data.total);
      const analysisHtml  = _renderAnalysis(data.analysis);
      const paramsHtml    = _renderParams(data.params);

      const liftRows = Array.isArray(data.lift_matrix_exit) ? data.lift_matrix_exit : [];
      const liftThr  = data.min_lift_threshold != null ? Number(data.min_lift_threshold) : 0.08;
      const liftHtml = _renderLiftMatrix(liftRows, liftThr);

      el.innerHTML = `<div style="padding:14px 0">${liftHtml}${breakdownHtml}${analysisHtml}${paramsHtml}</div>`;
    },
  };

  window.CalExit = CalExit;

})(window.App);
