/* Ora et Labora — Calibrator Analytics sub-tab */
/* $ Attribution Leaderboard + Bayesian Confidence */

(function (App) {
  'use strict';

  const esc = App.esc;

  // ── Phase color map ────────────────────────────────────────────────────────
  const PHASE_COLORS = {
    'Hard Safety':    '#f43f5e',
    'Conviction':     '#6366f1',
    'Wallet Quality': '#a78bfa',
    'Market Quality': '#22d3ee',
    'Price Quality':  '#f59e0b',
    'Risk Exposure':  '#f97316',
  };

  function _phaseColor(phase) {
    return PHASE_COLORS[phase] || '#94a3b8';
  }

  // ── Bayesian status helpers ────────────────────────────────────────────────
  function _statusLabel(status) {
    if (status === 'stable')      return App.t('cal.bayes_stable');
    if (status === 'researching') return App.t('cal.bayes_exploring');
    return App.t('cal.bayes_uncertain');
  }

  function _statusColor(status) {
    if (status === 'stable')      return '#22c55e';
    if (status === 'researching') return '#f59e0b';
    return '#f43f5e';
  }

  // ── Section header HTML ────────────────────────────────────────────────────
  function _sectionHeader(barColor, title, count, description) {
    const badge = count != null
      ? `<span style="font-size:9px;background:${barColor}22;color:${barColor};border:1px solid ${barColor}44;border-radius:10px;padding:1px 7px;font-weight:600;margin-left:6px">${count}</span>`
      : '';
    const descHtml = description
      ? `<div style="font-size:10px;color:#64748b;line-height:1.5;margin-bottom:12px;padding-left:11px">${description}</div>`
      : '';
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:${description ? '6px' : '12px'}">
        <div style="width:3px;height:14px;background:${barColor};border-radius:2px;flex-shrink:0"></div>
        <span style="font-size:11px;font-weight:700;color:#f1f5f9;text-transform:uppercase;letter-spacing:.06em">${esc(title)}</span>
        ${badge}
      </div>
      ${descHtml}`;
  }

  // ── Multi-KPI Lift matrix (2026-04-22 rework) ─────────────────────────────
  // Δ-value formatter: pp for rate KPIs, $ for avg_pnl, raw for profit_factor.
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

  function _liftMatrixRow(row, threshold, isHead) {
    const cols = 'grid-template-columns:minmax(180px,2fr) repeat(6,minmax(0,1fr))';
    if (isHead) {
      const mkHead = t => `<div style="text-align:center;font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:.05em;font-weight:600">${esc(t)}</div>`;
      return `
        <div style="display:grid;${cols};gap:8px;align-items:center;padding:4px 12px 8px">
          <div style="font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:.05em;font-weight:600">${App.t('cal.lift_col_filter')}</div>
          ${mkHead('Δ WR')}${mkHead('Δ PF')}${mkHead('Δ avg_pnl')}${mkHead('Δ sl_rate')}${mkHead('Conf')}${mkHead('Score')}
        </div>`;
    }

    const lift = row.lift || {};
    const score = row.score != null ? Number(row.score) : 0;
    const above = score >= threshold;
    const bg = above ? 'background:rgba(34,197,94,0.04);' : '';

    const cfg = row.config_key || '';
    const delta = row.delta != null ? row.delta : '';
    const dirText = row.direction + (delta !== '' ? ' ' + (delta >= 0 ? '+' : '') + delta : '');

    const mkCell = (kpi) => {
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
        ${mkCell('win_rate')}${mkCell('profit_factor')}${mkCell('avg_pnl')}${mkCell('sl_rate')}
        <div style="text-align:center;font-family:ui-monospace,Menlo,monospace;font-weight:600;color:${_confColor(confVal)};font-size:11px">${esc(confStr)}</div>
        <div style="text-align:center;font-family:ui-monospace,Menlo,monospace;font-weight:700;color:${scoreCol};font-size:11px">${esc(scoreStr)}</div>
      </div>`;
  }

  function _liftMatrixSection(rows, threshold, titleKey) {
    const hasRows = rows && rows.length;
    const thrStr = threshold != null ? Number(threshold).toFixed(2) : '0.08';
    const body = hasRows
      ? rows.map(r => _liftMatrixRow(r, threshold, false)).join('')
      : `<div style="padding:22px 14px;text-align:center;color:#64748b;font-size:11px;line-height:1.6">
           ${App.t('cal.lift_matrix_empty', {threshold: thrStr})}
         </div>`;
    const headerRow = hasRows ? _liftMatrixRow(null, threshold, true) : '';
    return `
      <div style="margin-bottom:24px;background:#0c0f1a;border:1px solid rgba(167,139,250,0.22);border-radius:12px;padding:14px 4px;position:relative">
        <div style="position:absolute;top:-7px;left:14px;background:#a78bfa;color:#0a0a0a;font-size:8px;font-weight:800;padding:2px 7px;border-radius:3px;letter-spacing:.06em">${App.t('cal.new_tag')}</div>
        <div style="display:flex;align-items:center;gap:8px;padding:0 12px 10px">
          <div style="width:3px;height:14px;background:#a78bfa;border-radius:2px"></div>
          <span style="font-size:11px;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:.06em">${App.t(titleKey)}</span>
          <span style="font-size:9px;background:rgba(167,139,250,0.15);color:#c4b5fd;border:1px solid rgba(167,139,250,0.3);border-radius:10px;padding:1px 7px;font-weight:600">multi-KPI</span>
        </div>
        ${headerRow}
        ${body}
        <div style="padding:10px 12px 2px;font-size:10px;color:#94a3b8;line-height:1.5">
          ${App.t('cal.lift_matrix_hint')}
        </div>
      </div>`;
  }

  // ── Attribution row HTML ───────────────────────────────────────────────────
  function _attrRow(item, maxAbs) {
    const savedW = maxAbs > 0 ? Math.round((Math.abs(item.saved || 0) / maxAbs) * 100) : 0;
    const lostW  = maxAbs > 0 ? Math.round((Math.abs(item.lost  || 0) / maxAbs) * 100) : 0;
    const net    = item.net != null ? item.net : 0;
    const netStr = (net >= 0 ? '+$' : '-$') + Math.abs(net).toFixed(2);
    const netColor = net >= 0 ? '#22c55e' : '#f43f5e';
    const phaseColor = _phaseColor(item.phase);
    const dataPoints = item.data_points != null ? item.data_points : '—';
    const rejectCount = item.reject_count != null ? item.reject_count : '—';

    return `
      <div style="background:#0c0f1a;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:12px 14px;margin-bottom:6px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:700;color:#f1f5f9;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.human_name || item.config_key || item.reject_key || '—')}</div>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span style="font-size:9px;color:#475569;font-family:monospace">${esc(item.reject_key || '')}</span>
              ${item.phase ? `<span style="font-size:9px;background:${phaseColor}18;color:${phaseColor};border:1px solid ${phaseColor}33;border-radius:4px;padding:1px 5px;font-weight:600">${esc(item.phase)}</span>` : ''}
              <span style="font-size:9px;color:#475569">${App.t('cal.attr_rejects_points', {rejects: rejectCount, points: dataPoints})}</span>
            </div>
          </div>
          <div style="font-size:14px;font-weight:800;color:${netColor};flex-shrink:0;font-family:monospace">${esc(netStr)}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:9px;color:#22c55e;width:38px;text-align:right;font-family:monospace;flex-shrink:0">+$${Math.abs(item.saved || 0).toFixed(1)}</span>
            <div style="flex:1;height:6px;background:rgba(255,255,255,0.05);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${savedW}%;background:#22c55e;border-radius:3px;transition:width .3s"></div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:9px;color:#f43f5e;width:38px;text-align:right;font-family:monospace;flex-shrink:0">-$${Math.abs(item.lost || 0).toFixed(1)}</span>
            <div style="flex:1;height:6px;background:rgba(255,255,255,0.05);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${lostW}%;background:#f43f5e;border-radius:3px;transition:width .3s"></div>
            </div>
          </div>
        </div>
      </div>`;
  }

  // ── Attribution section HTML ───────────────────────────────────────────────
  function _attrSection(items) {
    const desc = App.t('cal.attr_desc');
    if (!items || !items.length) {
      return `
        <div style="margin-bottom:24px">
          ${_sectionHeader('#22c55e', App.t('cal.attr_title'), 0, desc)}
          <div style="background:#0c0f1a;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:20px;text-align:center;color:#475569;font-size:12px">
            ${esc(App.t('cal.attr_empty'))}
          </div>
        </div>`;
    }

    // Sort by net descending
    const sorted = [...items].sort((a, b) => (b.net || 0) - (a.net || 0));
    const maxAbs = Math.max(...sorted.map(i => Math.max(Math.abs(i.saved || 0), Math.abs(i.lost || 0))), 1);

    // Readiness summary
    const withData = sorted.filter(i => (i.data_points || 0) > 0);
    const totalSaved = sorted.reduce((s, i) => s + Math.abs(i.saved || 0), 0);
    const totalLost = sorted.reduce((s, i) => s + Math.abs(i.lost || 0), 0);
    const summaryHtml = `
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px;padding:8px 12px;background:#0c0f1a;border:1px solid rgba(255,255,255,0.06);border-radius:8px">
        <div style="font-size:10px;color:#94a3b8">
          <span style="color:#22c55e;font-weight:700">+$${totalSaved.toFixed(1)}</span> ${esc(App.t('cal.attr_total_saved'))}
        </div>
        <div style="font-size:10px;color:#94a3b8">
          <span style="color:#f43f5e;font-weight:700">-$${totalLost.toFixed(1)}</span> ${esc(App.t('cal.attr_total_lost'))}
        </div>
        <div style="font-size:10px;color:#94a3b8">
          ${esc(App.t('cal.attr_with_data', {count: withData.length, total: sorted.length}))}
        </div>
      </div>`;

    const positive = sorted.filter(i => (i.net || 0) >= 0);
    const negative = sorted.filter(i => (i.net || 0) < 0);

    let rows = positive.map(i => _attrRow(i, maxAbs)).join('');

    if (positive.length > 0 && negative.length > 0) {
      // Separator between positive and negative
      rows += `<div style="margin:10px 0 8px;border-top:1px dashed rgba(255,255,255,0.08);position:relative">
        <span style="position:absolute;top:-9px;left:50%;transform:translateX(-50%);background:#0d1117;padding:0 10px;font-size:9px;color:#475569;white-space:nowrap">${esc(App.t('cal.attr_below_zero'))}</span>
      </div>`;
    }

    rows += negative.map(i => _attrRow(i, maxAbs)).join('');

    const tipHtml = `
      <div style="margin-top:12px;padding:10px 14px;background:rgba(167,139,250,0.06);border-left:3px solid #a78bfa;border-radius:0 8px 8px 0;font-size:10.5px;color:#cbd5e1;line-height:1.6">
        <strong style="color:#c4b5fd">${App.t('cal.tip_how_computed')}:</strong> ${App.t('cal.tip_attr_body')}
      </div>`;

    return `
      <div style="margin-bottom:24px">
        ${_sectionHeader('#22c55e', App.t('cal.attr_title'), sorted.length, desc)}
        ${summaryHtml}
        ${rows}
        ${tipHtml}
      </div>`;
  }

  // ── Bayesian row HTML ──────────────────────────────────────────────────────
  function _bayesRow(item, muted) {
    const confidence = item.confidence != null ? item.confidence : 0;
    const confPct    = Math.round(confidence * 100);
    const barW       = Math.min(100, Math.max(0, confPct));
    const status     = item.status || 'unknown';
    const statusColor = _statusColor(status);
    const statusLbl   = _statusLabel(status);
    const dataPoints  = item.data_points != null ? item.data_points : 0;
    const alpha       = item.alpha  != null ? item.alpha.toFixed(1)  : '—';
    const beta        = item.beta   != null ? item.beta.toFixed(1)   : '—';

    const updatedAt = item.updated_at
      ? new Date(item.updated_at * 1000).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })
      : null;

    // Muted style for uninformed priors (no data)
    const opacity = muted ? 'opacity:0.45;' : '';
    const nameColor = muted ? '#64748b' : '#f1f5f9';
    const confColor = muted ? '#475569' : statusColor;

    // Threshold markers at 50% and 70%
    const markers = `
      <div style="position:absolute;left:50%;top:0;height:100%;width:1px;background:rgba(255,255,255,0.15)"></div>
      <div style="position:absolute;left:70%;top:0;height:100%;width:1px;background:rgba(34,197,94,0.3)"></div>`;

    return `
      <div style="background:#0c0f1a;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:12px 14px;margin-bottom:6px;${opacity}">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:700;color:${nameColor};margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.human_name || item.config_key || item.reject_key || '—')}</div>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span style="font-size:9px;color:#475569;font-family:monospace">${esc(item.reject_key || '')}</span>
              <span style="font-size:9px;background:${statusColor}18;color:${statusColor};border:1px solid ${statusColor}33;border-radius:4px;padding:1px 5px;font-weight:600">${esc(statusLbl)}</span>
              <span style="font-size:9px;color:#475569">α=${alpha} β=${beta} · ${App.t('cal.bayes_points', {n: dataPoints})}${updatedAt ? ' · ' + updatedAt : ''}</span>
            </div>
          </div>
          <div style="font-size:18px;font-weight:800;color:${confColor};flex-shrink:0;font-family:monospace;line-height:1">${confPct}%</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;height:7px;background:rgba(255,255,255,0.05);border-radius:4px;overflow:hidden;position:relative">
            ${markers}
            <div style="height:100%;width:${barW}%;background:${statusColor};border-radius:4px;transition:width .3s;opacity:0.85;position:relative;z-index:1"></div>
          </div>
        </div>
      </div>`;
  }

  // ── Bayesian section HTML ──────────────────────────────────────────────────
  function _bayesSection(items) {
    const desc = App.t('cal.bayes_desc');
    if (!items || !items.length) {
      return `
        <div style="margin-bottom:24px">
          ${_sectionHeader('#a78bfa', App.t('cal.bayes_title'), 0, desc)}
          <div style="background:#0c0f1a;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:20px;text-align:center;color:#475569;font-size:12px">
            ${esc(App.t('cal.bayes_empty'))}
          </div>
        </div>`;
    }

    // Group by status: stable → researching → uncertain
    const statusOrder = { stable: 0, researching: 1 };
    const sorted = [...items].sort((a, b) => {
      const sa = statusOrder[a.status] ?? 2;
      const sb = statusOrder[b.status] ?? 2;
      if (sa !== sb) return sa - sb;
      return (b.confidence || 0) - (a.confidence || 0);
    });

    const stableCount = items.filter(i => i.status === 'stable').length;
    const researchCount = items.filter(i => i.status === 'researching').length;
    const unknownCount = items.filter(i => i.status !== 'stable' && i.status !== 'researching').length;
    const withData = items.filter(i => (i.data_points || 0) > 0).length;

    // Readiness summary
    const summaryHtml = `
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;padding:8px 12px;background:#0c0f1a;border:1px solid rgba(255,255,255,0.06);border-radius:8px;align-items:center">
        <div style="font-size:10px;display:flex;align-items:center;gap:4px">
          <span style="width:6px;height:6px;border-radius:50%;background:#22c55e;display:inline-block"></span>
          <span style="color:#94a3b8">${esc(App.t('cal.bayes_stable'))}: <strong style="color:#22c55e">${stableCount}</strong></span>
        </div>
        <div style="font-size:10px;display:flex;align-items:center;gap:4px">
          <span style="width:6px;height:6px;border-radius:50%;background:#f59e0b;display:inline-block"></span>
          <span style="color:#94a3b8">${esc(App.t('cal.bayes_exploring'))}: <strong style="color:#f59e0b">${researchCount}</strong></span>
        </div>
        <div style="font-size:10px;display:flex;align-items:center;gap:4px">
          <span style="width:6px;height:6px;border-radius:50%;background:#f43f5e;display:inline-block"></span>
          <span style="color:#94a3b8">${esc(App.t('cal.bayes_uncertain'))}: <strong style="color:#f43f5e">${unknownCount}</strong></span>
        </div>
        <div style="font-size:10px;color:#64748b;margin-left:auto">
          ${esc(App.t('cal.bayes_with_data', {count: withData, total: items.length}))}
        </div>
      </div>`;

    // Threshold legend
    const legendHtml = `
      <div style="display:flex;gap:16px;margin-bottom:10px;padding-left:2px">
        <div style="display:flex;align-items:center;gap:4px;font-size:9px;color:#475569">
          <span style="width:10px;height:1px;background:rgba(255,255,255,0.15);display:inline-block"></span> 50% ${esc(App.t('cal.bayes_threshold_uncertain'))}
        </div>
        <div style="display:flex;align-items:center;gap:4px;font-size:9px;color:#475569">
          <span style="width:10px;height:1px;background:rgba(34,197,94,0.3);display:inline-block"></span> 70% ${esc(App.t('cal.bayes_threshold_stable'))}
        </div>
      </div>`;

    // Render rows — muted for zero data points
    const rows = sorted.map(i => {
      const muted = (i.data_points || 0) === 0;
      return _bayesRow(i, muted);
    }).join('');

    const tipHtml = `
      <div style="margin-top:12px;padding:10px 14px;background:rgba(167,139,250,0.06);border-left:3px solid #a78bfa;border-radius:0 8px 8px 0;font-size:10.5px;color:#cbd5e1;line-height:1.6">
        <strong style="color:#c4b5fd">${App.t('cal.tip_how_read')}:</strong> ${App.t('cal.tip_bayes_body')}
      </div>`;

    return `
      <div style="margin-bottom:24px">
        ${_sectionHeader('#a78bfa', App.t('cal.bayes_title'), sorted.length, desc)}
        ${summaryHtml}
        ${legendHtml}
        ${rows}
        ${tipHtml}
      </div>`;
  }

  // ── Timestamp footer ───────────────────────────────────────────────────────
  function _tsFooter(ts1, ts2) {
    const ts = ts1 || ts2;
    if (!ts) return '';
    const time = new Date(ts * 1000).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<div style="font-size:9px;color:#475569;text-align:right;margin-top:4px">${esc(App.t('cal.updated_at', {time}))}</div>`;
  }

  // ── Main module ────────────────────────────────────────────────────────────
  const CalAnalytics = {

    async load() {
      const el = document.getElementById('calTabAnalytics');
      if (!el) return;

      el.innerHTML = `<div style="color:#475569;font-size:12px;padding:24px 0;text-align:center">${esc(App.t('cal.loading'))}</div>`;

      let attrData, bayesData;
      try {
        [attrData, bayesData] = await Promise.all([
          App.fetchJSON('/api/polymarket/calibration/attribution'),
          App.fetchJSON('/api/polymarket/calibration/bayesian'),
        ]);
      } catch (e) {
        el.innerHTML = `<div style="color:#f43f5e;font-size:12px;padding:24px 0;text-align:center">${esc(App.t('cal.load_error', {error: e.message}))}</div>`;
        return;
      }

      this.render(attrData, bayesData);
    },

    render(attrData, bayesData) {
      const el = document.getElementById('calTabAnalytics');
      if (!el) return;

      const attrItems  = (attrData  && Array.isArray(attrData.attribution))  ? attrData.attribution  : [];
      const bayesItems = (bayesData && Array.isArray(bayesData.bayesian))     ? bayesData.bayesian    : [];
      const attrTs  = attrData  && attrData.ts;
      const bayesTs = bayesData && bayesData.ts;

      const liftRows  = (attrData && Array.isArray(attrData.lift_matrix_entry)) ? attrData.lift_matrix_entry : [];
      const liftThr   = attrData && attrData.min_lift_threshold != null ? Number(attrData.min_lift_threshold) : 0.08;
      const liftHtml  = _liftMatrixSection(liftRows, liftThr, 'cal.lift_matrix_entry_title');

      el.innerHTML = `
        <div style="padding:2px 0">
          ${liftHtml}
          ${_attrSection(attrItems)}
          ${_bayesSection(bayesItems)}
          ${_tsFooter(attrTs, bayesTs)}
        </div>`;
    },
  };

  window.CalAnalytics = CalAnalytics;

})(window.App);
