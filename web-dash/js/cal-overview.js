/* Ora et Labora — Calibrator Overview sub-tab */
/* 3-Panel layout: Entry Pipeline | Exit Engine | Performance */

(function (App) {
  'use strict';

  const esc = App.esc;

  // ── Multi-KPI labels + formatters (2026-04-22 rework) ─────────────────────
  const KPI_SHORT = {
    win_rate: 'WR',
    profit_factor: 'PF',
    avg_pnl: 'avg_pnl',
    pass_rate: 'pass_rate',
    sl_rate: 'sl_rate',
    tp_hit_rate: 'tp_rate',
    exit_efficiency: 'eff',
    left_on_table: 'LOT',
  };

  // KPI → native-unit formatter for Δ display.
  // rate-style KPIs show pp; profit_factor shows raw Δ; avg_pnl shows $.
  function _formatLift(kpiName, delta) {
    if (delta == null || isNaN(delta)) return '—';
    const ratePct = ['win_rate', 'pass_rate', 'sl_rate', 'tp_hit_rate',
                     'exit_efficiency', 'left_on_table'];
    if (ratePct.includes(kpiName)) {
      const s = delta > 0 ? '+' : '';
      return s + (delta * 100).toFixed(0) + 'pp';
    }
    if (kpiName === 'avg_pnl') {
      return (delta >= 0 ? '+$' : '-$') + Math.abs(delta).toFixed(2);
    }
    if (kpiName === 'profit_factor') {
      return (delta >= 0 ? '+' : '') + delta.toFixed(2);
    }
    return (delta >= 0 ? '+' : '') + delta.toFixed(3);
  }

  // 'g' (good, green), 'r' (bad, red), 'm' (muted) — honors lower_better KPIs.
  function _liftColorClass(kpiName, delta) {
    if (delta == null || delta === 0) return 'm';
    const lowerBetter = (kpiName === 'sl_rate' || kpiName === 'left_on_table');
    const good = lowerBetter ? delta < 0 : delta > 0;
    return good ? 'g' : 'r';
  }

  // ── Entry pipeline color helpers ───────────────────────────────────────────
  function _kpiColor(metric, value) {
    const thresholds = {
      win_rate:       { good: 0.55, warn: 0.50 },
      profit_factor:  { good: 1.5,  warn: 1.0  },
      avg_pnl:        { good: 0.2,  warn: 0.0  },
      pass_rate:      { good: 0.08, warn: 0.01 },
    };
    const t = thresholds[metric];
    if (!t) return '#94a3b8';
    if (value >= t.good) return '#22c55e';
    if (value >= t.warn) return '#f59e0b';
    return '#f43f5e';
  }

  function _confidenceColor(cs) {
    if (cs === 'stable')   return '#22c55e';
    if (cs === 'growing')  return '#3b82f6';
    if (cs === 'weak')     return '#f59e0b';
    return '#94a3b8';
  }

  // ── Exit engine color helpers ──────────────────────────────────────────────
  // Thresholds come from calibrator (data.exit_targets). We store latest
  // targets here so helper stays sync with _setKpi signature everywhere.
  // Fallbacks match calibrator/exit_thermostat.py _TARGETS defaults.
  let _exitTargets = {
    exit_efficiency: { min: 0.60, ideal: 0.75 },
    tp_hit_rate:     { min: 0.20, ideal: 0.35 },
    sl_rate:         { max: 0.30 },
    left_on_table:   { max: 0.30 },
  };

  function _exitKpiColor(metric, value) {
    const t = _exitTargets[metric];
    if (!t) return '#94a3b8';
    // Reversed metrics: lower is better. Green <(max − soft-margin), amber ≤max, red >max.
    if (metric === 'left_on_table' || metric === 'sl_rate') {
      const soft = t.max - (metric === 'left_on_table' ? 0.15 : 0.10);
      if (value < soft)    return '#22c55e';
      if (value <= t.max)  return '#f59e0b';
      return '#f43f5e';
    }
    if (value >= t.ideal) return '#22c55e';
    if (value >= t.min)   return '#f59e0b';
    return '#f43f5e';
  }

  // ── Performance color helpers ──────────────────────────────────────────────
  function _perfKpiColor(metric, value) {
    const thresholds = {
      win_rate:      { good: 0.55, warn: 0.50 },
      profit_factor: { good: 1.5,  warn: 1.0  },
      avg_pnl:       { good: 0.0,  warn: -0.5 },
      total_pnl:     { good: 0.0,  warn: -5.0 },
    };
    const t = thresholds[metric];
    if (!t) return '#94a3b8';
    if (value >= t.good) return '#22c55e';
    if (value >= t.warn) return '#f59e0b';
    return '#f43f5e';
  }

  // ── Sparkline renderer (SVG bar chart) ────────────────────────────────────
  function _sparklineSVG(values, color) {
    if (!values || !values.length) return '';
    const clean = values.filter(v => v != null);
    if (!clean.length) return '';
    const min = Math.min(...clean);
    const max = Math.max(...clean);
    const range = max - min || 1;
    const bars = values.slice(-12);
    const n = bars.length;
    const w = 4;
    const gap = 2;
    const totalW = n * (w + gap) - gap;
    const h = 28;

    const rects = bars.map((v, i) => {
      if (v == null) return '';
      const norm = (v - min) / range;
      const barH = Math.max(3, Math.round(norm * (h - 4)));
      const x = i * (w + gap);
      const y = h - barH;
      const opacity = 0.35 + (i / (n - 1 || 1)) * 0.65;
      return `<rect x="${x}" y="${y}" width="${w}" height="${barH}" rx="1" fill="${color}" opacity="${opacity.toFixed(2)}"/>`;
    }).join('');

    return `<svg width="${totalW}" height="${h}" viewBox="0 0 ${totalW} ${h}" style="display:block">${rects}</svg>`;
  }

  // ── Legacy KPI card (kept for backward compat, not used in new 3-panel) ────
  function _kpiCard(label, metric, value, target, sparkValues, extraLabel) {
    if (value == null) value = 0;
    const color = _kpiColor(metric, value);
    const isPercent = ['win_rate', 'pass_rate'].includes(metric);
    const isMultiple = metric === 'profit_factor';
    let displayVal;
    if (isPercent) {
      displayVal = (value * 100).toFixed(1) + '%';
    } else if (isMultiple) {
      displayVal = value.toFixed(2) + '×';
    } else {
      displayVal = (value >= 0 ? '+' : '') + value.toFixed(2);
    }

    let targetHtml = '';
    if (target != null) {
      const diff = value - target;
      const diffStr = isPercent
        ? ((diff > 0 ? '+' : '') + (diff * 100).toFixed(1) + 'pp')
        : ((diff > 0 ? '+' : '') + diff.toFixed(2));
      const diffColor = diff >= 0 ? '#22c55e' : '#f43f5e';
      const targetDisplay = isPercent ? (target * 100).toFixed(0) + '%'
        : metric === 'profit_factor' ? target.toFixed(1) + 'x'
        : target.toFixed(2);
      targetHtml = `<div style="font-size:10px;color:${diffColor};margin-top:3px">${diffStr} ${App.t('cal.kpi_from_target')} <span style="color:#475569">(${targetDisplay})</span></div>`;
    }

    const sparkHtml = sparkValues
      ? `<div style="margin-top:6px">${_sparklineSVG(sparkValues, color)}</div>`
      : '';

    const extraHtml = extraLabel
      ? `<div style="font-size:9px;color:#94a3b8;margin-top:2px">${esc(extraLabel)}</div>`
      : '';

    return `
      <div style="background:#0c0f1a;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px;position:relative;min-width:0">
        <div style="font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#475569;margin-bottom:6px">${esc(label)}</div>
        <div style="font-size:26px;font-weight:800;color:${color};line-height:1.1">${esc(displayVal)}</div>
        ${targetHtml}
        ${extraHtml}
        ${sparkHtml}
      </div>`;
  }

  // ── Panel KPI card (simplified, for 3-panel layout) ───────────────────────
  function _panelKpiCard(label, value, color, tipKey, extra) {
    const tip = tipKey ? App.t(tipKey) : '';
    return `
      <div style="background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.04);border-radius:8px;padding:9px 10px" ${tip ? `title="${esc(tip)}"` : ''}>
        <div style="font-size:7.5px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#475569;margin-bottom:3px">${esc(label)}</div>
        <div style="font-size:20px;font-weight:800;line-height:1.1;color:${color}">${esc(value)}</div>
        ${extra ? `<div style="font-size:7.5px;color:#64748b;margin-top:2px">${esc(extra)}</div>` : ''}
      </div>`;
  }

  // ── Performance note block ────────────────────────────────────────────────
  function _perfNote(perf) {
    const pf = (perf.profit_factor || 0).toFixed(2);
    const text = App.t('cal.perf_note', {pf: pf});
    const dotColor = (perf.profit_factor || 0) >= 1.5 ? '#22c55e' : '#f59e0b';
    return `
      <div style="background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.04);border-radius:8px;padding:10px 12px">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:8px;height:8px;border-radius:50%;background:${dotColor};flex-shrink:0"></div>
          <div style="font-size:10px;color:#94a3b8;line-height:1.4">${esc(text)}</div>
        </div>
      </div>`;
  }

  // ── Recommendations status block (when no recs available) ─────────────────
  function _recsStatusBlock(kpi, data) {
    const mode = data.mode || 'manual';
    const totalTrades = kpi.total_trades || 0;
    const minTrades = data.min_trades || 20;
    const botHasRun = data.bot_has_run || false;

    let items = [];

    // Condition 1: mode
    if (mode === 'manual') {
      items.push({
        done: false,
        text: App.t('cal.status_mode_manual'),
      });
    } else {
      items.push({
        done: true,
        text: App.t('cal.status_mode_ok', {mode: mode}),
      });
    }

    // Condition 2: min trades
    if (totalTrades < minTrades) {
      items.push({
        done: false,
        text: App.t('cal.status_trades_needed', {current: totalTrades, min: minTrades, remaining: minTrades - totalTrades}),
        progress: totalTrades / minTrades,
      });
    } else {
      items.push({
        done: true,
        text: App.t('cal.status_trades_ok', {count: totalTrades}),
      });
    }

    // Condition 3: Multi-KPI objective — any lever at or above MIN_LIFT_THRESHOLD?
    const lm = data.lift_matrix || {};
    const threshold = Number(data.min_lift_threshold || 0.08);
    const scores = Object.values(lm).map(lev => Number(lev && lev.score || 0));
    const topScore = scores.length ? Math.max(...scores) : 0;
    if (topScore >= threshold) {
      items.push({
        done: true,
        text: App.t('cal.status_objective_ready', {score: topScore.toFixed(2)}),
      });
    } else if (scores.length > 0) {
      items.push({
        done: false,
        text: App.t('cal.status_objective_below', {score: topScore.toFixed(2), threshold: threshold.toFixed(2)}),
      });
    } else {
      items.push({
        done: false,
        text: App.t('cal.status_objective_nodata'),
      });
    }

    // Condition 4: calibrator bot
    if (!botHasRun) {
      items.push({
        done: false,
        text: App.t('cal.status_bot_not_run'),
      });
    } else {
      items.push({
        done: true,
        text: App.t('cal.status_bot_ok'),
      });
    }

    const doneCount = items.filter(i => i.done).length;
    const allDone = doneCount === items.length;

    const rows = items.map(item => {
      const icon = item.done
        ? '<span style="color:#22c55e;font-size:13px">✓</span>'
        : '<span style="color:#475569;font-size:13px">○</span>';
      const color = item.done ? '#64748b' : '#94a3b8';

      let progressHtml = '';
      if (item.progress != null && !item.done) {
        const pct = Math.round(item.progress * 100);
        progressHtml = `
          <div style="margin-top:4px;height:4px;background:#1e293b;border-radius:2px;overflow:hidden;max-width:180px">
            <div style="height:100%;width:${pct}%;background:#f59e0b;border-radius:2px;transition:width .3s"></div>
          </div>`;
      }

      return `
        <div style="display:flex;align-items:flex-start;gap:8px;padding:4px 0">
          <div style="flex-shrink:0;width:16px;text-align:center;margin-top:1px">${icon}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:11px;color:${color};line-height:1.4">${esc(item.text)}</div>
            ${progressHtml}
          </div>
        </div>`;
    }).join('');

    const headerText = allDone
      ? App.t('cal.status_waiting_next_cycle')
      : App.t('cal.status_header', {done: doneCount, total: items.length});

    // When all conditions met: show next cycle ETA
    let nextCycleHtml = '';
    if (allDone) {
      const botTs = data.ts || 0;
      const interval = data.cycle_interval_s || 7140;
      if (botTs > 0) {
        const nextTs = (botTs + interval) * 1000;
        const now = Date.now();
        const diffMin = Math.max(0, Math.round((nextTs - now) / 60000));
        const nextTime = new Date(nextTs).toLocaleTimeString('uk-UA', {hour:'2-digit', minute:'2-digit'});
        const etaText = diffMin > 0
          ? App.t('cal.status_next_cycle_eta', {time: nextTime, min: diffMin})
          : App.t('cal.status_next_cycle_overdue');
        nextCycleHtml = `
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.04)">
            <div style="font-size:10px;color:#64748b">${esc(etaText)}</div>
          </div>`;
      }
    }

    return `
      <div style="background:#0c0f1a;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:14px 16px;margin-bottom:16px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;margin-bottom:10px">${esc(headerText)}</div>
        ${rows}
        ${nextCycleHtml}
      </div>`;
  }

  // ── Multi-KPI Objective strip (deficit-weighted KPI bar) ──────────────────
  // Renders the 8-column bar under the 3-panel row. Width = share of total
  // weight; color = how dominant the KPI is in this cycle's objective.
  function _buildObjectiveStrip(data) {
    const weights = data.weights || {};
    const deficits = data.deficits || {};
    const importance = data.importance || {};
    const traceId = data.trace_id || '';

    const entries = Object.keys(weights).map(k => ({
      kpi: k,
      w: Number(weights[k] || 0),
      deficit: Number(deficits[k] || 0),
      imp: Number(importance[k] || 0),
    }));
    if (!entries.length) return '';

    entries.sort((a, b) => b.w - a.w);
    const totalW = entries.reduce((s, e) => s + e.w, 0);
    if (totalW <= 0) return '';
    const maxW = entries[0].w || 1;

    const cells = entries.map(e => {
      const pct = (e.w / totalW) * 100;
      const barW = Math.max(2, (e.w / maxW) * 100);
      const color = pct >= 10 ? '#f43f5e' : pct >= 3 ? '#f59e0b' : '#64748b';
      const label = KPI_SHORT[e.kpi] || e.kpi;
      const tip = `${e.kpi} · weight ${e.w.toFixed(2)} (${pct.toFixed(0)}%) · deficit ${e.deficit.toFixed(2)} · importance ${e.imp.toFixed(1)}`;
      return `
        <div class="cal-weight-cell" style="background:rgba(0,0,0,0.35);border-radius:7px;padding:9px 8px" title="${esc(tip)}">
          <div style="font-size:8.5px;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;font-weight:600;margin-bottom:4px">${esc(label)}</div>
          <div style="height:5px;border-radius:3px;background:rgba(255,255,255,0.06);margin-bottom:6px;overflow:hidden">
            <div style="height:100%;width:${barW.toFixed(0)}%;background:${color};border-radius:3px"></div>
          </div>
          <div style="font-size:13px;font-weight:700;color:${color};font-family:ui-monospace,Menlo,monospace;line-height:1">${pct.toFixed(0)}%</div>
          <div style="font-size:9px;color:#64748b;margin-top:2px">w ${e.w.toFixed(2)}</div>
        </div>`;
    }).join('');

    const topKpis = entries.filter(e => e.w > 0).slice(0, 3)
      .map(e => KPI_SHORT[e.kpi] || e.kpi);
    const focusStr = topKpis.length
      ? App.t('cal.obj_focus') + ': ' + topKpis.join(' + ')
      : '';

    const traceShort = traceId ? esc(String(traceId).slice(0, 12)) : '';

    return `
      <div style="background:linear-gradient(90deg,rgba(167,139,250,0.07) 0%,rgba(34,211,238,0.04) 100%);border:1px solid rgba(167,139,250,0.18);border-radius:12px;padding:14px 16px;margin-bottom:14px;position:relative">
        <div style="position:absolute;top:-7px;left:14px;background:#a78bfa;color:#0a0a0a;font-size:8px;font-weight:800;padding:2px 7px;border-radius:3px;letter-spacing:.06em">${App.t('cal.new_tag')}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:12px;flex-wrap:wrap">
          <div>
            <span style="font-size:11px;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:.08em">${App.t('cal.obj_title')}</span>
            <span style="font-size:11px;color:#94a3b8;margin-left:8px">${entries.length} KPI · Σ w = ${totalW.toFixed(2)}${focusStr ? ' · ' + esc(focusStr) : ''}</span>
          </div>
          ${traceShort ? `<span style="font-family:ui-monospace,Menlo,monospace;font-size:10px;color:#475569">trace ${traceShort}</span>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:repeat(${entries.length},minmax(0,1fr));gap:8px">${cells}</div>
        <div style="margin-top:12px;padding:10px 14px;background:rgba(167,139,250,0.06);border-left:3px solid #a78bfa;border-radius:0 8px 8px 0;font-size:10.5px;color:#cbd5e1;line-height:1.6">
          <strong style="color:#c4b5fd">${App.t('cal.tip_how_read')}:</strong> ${App.t('cal.tip_objective_body')}
        </div>
      </div>`;
  }

  // ── Filtered-out block (candidates below MIN_LIFT_THRESHOLD) ──────────────
  function _buildFilteredOut(data, shownKeys) {
    const lm = data.lift_matrix || {};
    const weights = data.weights || {};
    const threshold = Number(data.min_lift_threshold || 0.08);
    const shown = new Set(shownKeys || []);

    // Compute score per lever = Σ(weight · lift_norm) · confidence, as in
    // multi_kpi.score(). Server may emit both widen+narrow variants for exit
    // levers keyed as `CONFIG_KEY:direction` — dedup to max-score variant per
    // config_key so the filtered-out list shows one row per lever.
    const bestByCfg = {};
    Object.keys(lm).forEach(key => {
      const lev = lm[key] || {};
      const cfg = lev.config_key || key;
      if (shown.has(cfg)) return;
      const sc = Number(lev.score || 0);
      if (sc >= threshold) return;
      const prev = bestByCfg[cfg];
      if (!prev || sc > prev.score) {
        bestByCfg[cfg] = { key, name: lev.human_name || cfg,
                           dir: lev.direction || '', score: sc,
                           aims: lev.aims || [] };
      }
    });
    const below = Object.values(bestByCfg);
    if (!below.length) return '';

    below.sort((a, b) => b.score - a.score);

    const rows = below.slice(0, 8).map((b, i) => {
      const aimsHtml = b.aims.length
        ? `<span style="color:#64748b;font-size:10px"> (aims: ${esc(b.aims.map(k => KPI_SHORT[k] || k).join(' · '))})</span>`
        : '';
      return `
        <div style="display:flex;justify-content:space-between;padding:6px 2px;border-bottom:1px solid rgba(255,255,255,0.03)">
          <span>${i + 1}. ${esc(b.name)} ${esc(b.dir)}${aimsHtml}</span>
          <span style="font-family:ui-monospace,Menlo,monospace;color:#94a3b8">${b.score >= 0 ? '+' : ''}${b.score.toFixed(2)}</span>
        </div>`;
    }).join('');

    return `
      <details style="margin-top:10px;padding:10px 12px;background:#111520;border:1px dashed rgba(255,255,255,0.06);border-radius:8px;font-size:11px">
        <summary style="cursor:pointer;color:#94a3b8;font-size:11px;font-weight:600">${App.t('cal.filtered_out_summary', {count: below.length, threshold: threshold.toFixed(2)})}</summary>
        <div style="margin-top:10px">${rows}</div>
      </details>`;
  }

  // ── Recommendation card HTML (multi-KPI layout, 2026-04-22) ───────────────
  // Layout: dir+aim+score+conf badges · name · change-line · reason · Δ-strip.
  function _recCard(rec, idx) {
    const isExit = rec.phase === 'exit';
    const dir = rec.direction || 'hold';

    // Border + dir-badge colors by (phase, direction).
    let borderColor, dirBg, dirColor, dirLabel;
    if (isExit) {
      if (dir === 'widen')  { borderColor = '#3b82f6'; dirBg = 'rgba(59,130,246,0.15)';  dirColor = '#60a5fa'; dirLabel = 'exit · widen'; }
      else if (dir === 'narrow') { borderColor = '#f59e0b'; dirBg = 'rgba(245,158,11,0.15)';  dirColor = '#f59e0b'; dirLabel = 'exit · narrow'; }
      else                  { borderColor = '#64748b'; dirBg = 'rgba(148,163,184,0.12)'; dirColor = '#94a3b8'; dirLabel = 'exit · hold'; }
    } else {
      if (dir === 'tighten')     { borderColor = '#f59e0b'; dirBg = 'rgba(245,158,11,0.15)'; dirColor = '#f59e0b'; dirLabel = 'entry · tighten'; }
      else if (dir === 'relax')  { borderColor = '#22d3ee'; dirBg = 'rgba(34,211,238,0.15)'; dirColor = '#22d3ee'; dirLabel = 'entry · relax'; }
      else                       { borderColor = '#64748b'; dirBg = 'rgba(148,163,184,0.12)'; dirColor = '#94a3b8'; dirLabel = 'entry · hold'; }
    }

    const cs = rec.confidence_status || 'unknown';
    const conf = rec.confidence != null ? rec.confidence.toFixed(2) : '—';
    const scoreNum = rec.score != null ? rec.score : null;
    const scoreStr = scoreNum != null
      ? (scoreNum >= 0 ? '+' : '') + scoreNum.toFixed(2)
      : '—';

    const aims = Array.isArray(rec.aims) ? rec.aims.slice(0, 4) : [];
    const aimsLine = aims.length
      ? App.t('cal.rec_aims') + ': ' + aims.map(k => KPI_SHORT[k] || k).join(' · ')
      : '';

    const curVal = rec.current_value != null ? String(rec.current_value) : '—';
    const recVal = rec.recommended_value != null ? String(rec.recommended_value) : '—';
    const deltaStr = rec.delta != null && rec.delta !== 0
      ? ' (' + (rec.delta > 0 ? '+' : '') + rec.delta + ')'
      : '';

    // Δ-strip: columns depend on phase — entry levers affect entry KPIs,
    // exit levers affect exit KPIs. Showing zeros for the wrong axis hides
    // the actual impact.
    const LIFT_COLS = rec.phase === 'exit'
      ? ['sl_rate', 'tp_hit_rate', 'exit_efficiency', 'left_on_table']
      : ['win_rate', 'profit_factor', 'avg_pnl', 'sl_rate'];
    const lift = rec.lift || {};
    const liftCells = LIFT_COLS.map(k => {
      const d = lift[k] != null ? Number(lift[k]) : null;
      const cls = _liftColorClass(k, d);
      const color = cls === 'g' ? '#4ade80' : cls === 'r' ? '#f43f5e' : '#64748b';
      const label = 'Δ ' + (KPI_SHORT[k] || k);
      return `
        <div style="text-align:center">
          <div style="font-size:8px;color:#475569;text-transform:uppercase;letter-spacing:.05em;font-weight:600">${esc(label)}</div>
          <div style="font-size:11px;font-weight:700;color:${color};font-family:ui-monospace,Menlo,monospace;margin-top:2px">${esc(_formatLift(k, d))}</div>
        </div>`;
    }).join('');

    const cfgKey = rec.config_key || '';

    return `
      <div style="background:#111520;border:1px solid rgba(255,255,255,0.06);border-left:3px solid ${borderColor};border-radius:10px;padding:12px 14px;margin-bottom:8px" data-rec-idx="${idx}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div style="flex:1;min-width:0">
            <div style="display:flex;gap:6px;margin-bottom:4px;align-items:center;flex-wrap:wrap">
              <span style="font-size:9px;padding:2px 7px;border-radius:4px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;background:${dirBg};color:${dirColor}">${esc(dirLabel)}</span>
              ${aimsLine ? `<span style="font-size:9px;padding:2px 7px;border-radius:4px;font-weight:700;background:rgba(167,139,250,0.15);color:#a78bfa;border:1px solid rgba(167,139,250,0.25)">${esc(aimsLine)}</span>` : ''}
              ${scoreNum != null ? `<span style="font-size:9px;padding:2px 7px;border-radius:4px;font-weight:700;background:rgba(34,197,94,0.15);color:#4ade80">score ${esc(scoreStr)}</span>` : ''}
              <span style="font-size:9px;padding:2px 7px;border-radius:4px;font-weight:600;background:rgba(255,255,255,0.06);color:#94a3b8">conf ${esc(conf)} (${esc(cs)})</span>
            </div>
            <div style="font-size:13px;font-weight:700;margin-top:2px;color:#e2e8f0">${esc(rec.human_name || cfgKey || rec.reject_key || '—')}</div>
            <div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#94a3b8;margin-top:2px">${esc(cfgKey)}: ${esc(curVal)} → <strong style="color:#22d3ee">${esc(recVal)}</strong>${esc(deltaStr)}</div>
            ${rec.reason ? `<div style="font-size:11px;color:#94a3b8;margin-top:6px">${esc(rec.reason)}</div>` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button onclick="CalOverview._skipRec('${esc(cfgKey)}', this)" style="padding:5px 11px;font-size:10px;font-weight:600;background:transparent;color:#94a3b8;border:1px solid rgba(255,255,255,0.11);border-radius:5px;cursor:pointer">${App.t('cal.rec_skip')}</button>
            <button onclick="CalOverview._applyRec('${esc(cfgKey)}', this)" style="padding:5px 13px;font-size:10px;font-weight:700;background:#166534;color:#bbf7d0;border:none;border-radius:5px;cursor:pointer">${App.t('cal.rec_apply')}</button>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:9px;padding-top:9px;border-top:1px dashed rgba(255,255,255,0.06)">${liftCells}</div>
      </div>`;
  }

  // ── History rows builder (shared by entry & exit) ──────────────────────────
  function _historyRows(items, nameColor) {
    return items.slice().reverse().map(h => {
      const deltaColor = (h.delta || 0) > 0 ? '#22c55e' : (h.delta || 0) < 0 ? '#f43f5e' : '#94a3b8';
      const ts = h.applied_at ? new Date(h.applied_at * 1000).toLocaleString('uk-UA', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
      const name = h.human_name || h.config_key || '—';
      return `
        <tr>
          <td style="padding:7px 10px;font-size:10px;color:${nameColor}">${esc(name)}</td>
          <td style="padding:7px 10px;font-size:10px;color:#94a3b8;text-align:center;font-family:monospace">${esc(String(h.previous_value ?? ''))}</td>
          <td style="padding:7px 10px;font-size:10px;color:${deltaColor};text-align:center;font-weight:600;font-family:monospace">${esc(String(h.new_value ?? ''))}</td>
          <td style="padding:7px 10px;font-size:9px;color:#64748b;text-align:right">${esc(ts)}</td>
        </tr>`;
    }).join('');
  }

  function _historyTableBlock(title, accentColor, items, nameColor) {
    if (!items || !items.length) return '';
    const rows = _historyRows(items, nameColor);
    return `
      <div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <div style="width:3px;height:14px;background:${accentColor};border-radius:2px"></div>
          <span style="font-size:11px;font-weight:700;color:#f1f5f9;text-transform:uppercase;letter-spacing:.06em">${esc(title)}</span>
          <span style="font-size:9px;background:${accentColor}22;color:${accentColor};border:1px solid ${accentColor}33;border-radius:10px;padding:1px 7px;font-weight:600">${items.length}</span>
        </div>
        <div style="border:1px solid rgba(255,255,255,0.06);border-radius:8px;overflow:hidden">
          <table style="width:100%;border-collapse:collapse;table-layout:fixed">
            <colgroup>
              <col style="width:35%">
              <col style="width:22%">
              <col style="width:22%">
              <col style="width:21%">
            </colgroup>
            <thead>
              <tr style="border-bottom:1px solid rgba(255,255,255,0.06)">
                <th style="padding:7px 10px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:left">${App.t('cal.history_filter')}</th>
                <th style="padding:7px 10px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:center">${App.t('cal.history_before')}</th>
                <th style="padding:7px 10px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:center">${App.t('cal.history_after')}</th>
                <th style="padding:7px 10px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:right">${App.t('cal.history_when')}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  // ── History split: entry + exit tables ────────────────────────────────────
  function _historySection(history, exitKeys) {
    const exitSet = new Set(exitKeys || []);
    const entryHistory = (history || []).filter(h => !exitSet.has(h.config_key));
    const exitHistory  = (history || []).filter(h => exitSet.has(h.config_key));

    const entryHtml = _historyTableBlock(
      App.t('cal.history_entry_title'), '#3b82f6', entryHistory, '#93c5fd'
    );

    // Exit block always visible; empty-state when no data yet
    const exitHtml = exitHistory.length
      ? _historyTableBlock(App.t('cal.history_exit_title'), '#f59e0b', exitHistory, '#fbbf24')
      : `<div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <div style="width:3px;height:14px;background:#f59e0b;border-radius:2px"></div>
            <span style="font-size:11px;font-weight:700;color:#f1f5f9;text-transform:uppercase;letter-spacing:.06em">${esc(App.t('cal.history_exit_title'))}</span>
          </div>
          <div style="border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:18px 16px;text-align:center">
            <span style="font-size:11px;color:#475569">${esc(App.t('cal.history_exit_empty'))}</span>
          </div>
        </div>`;

    return `<div style="margin-top:16px;display:flex;flex-direction:column;gap:16px">${entryHtml}${exitHtml}</div>`;
  }

  // ── Panel builder helpers ──────────────────────────────────────────────────

  function _buildEntryPanel(kpi) {
    const passRateVal = kpi.pass_rate || 0;
    const passRateColor = _kpiColor('pass_rate', passRateVal);

    // Rejection top is text, show dimmed
    const rejTop = kpi.rejection_top || '—';

    const cfNet = kpi.cf_net || 0;
    const cfNetStr = (cfNet >= 0 ? '+$' : '-$') + Math.abs(cfNet).toFixed(2);
    const cfNetColor = cfNet >= 0 ? '#22c55e' : '#f43f5e';

    const cfLost = kpi.cf_lost || 0;
    const cfLostStr = '$' + cfLost.toFixed(2);
    const cfLostColor = cfLost > 0 ? '#f59e0b' : '#64748b';

    const kpiGrid = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
        ${_panelKpiCard(
          App.t('cal.kpi_pass_rate'),
          (passRateVal * 100).toFixed(1) + '%',
          passRateColor,
          'cal.tip_pass_rate',
          kpi.total_signals ? kpi.total_signals + ' signals' : null
        )}
        <div style="background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.04);border-radius:8px;padding:9px 10px" title="${esc(App.t('cal.tip_rejection_top'))}">
          <div style="font-size:7.5px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#475569;margin-bottom:3px">${esc(App.t('cal.kpi_rejection_top'))}</div>
          <div style="font-size:12px;font-weight:700;line-height:1.2;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(rejTop)}</div>
          <div style="font-size:7.5px;color:#64748b;margin-top:2px">top filter</div>
        </div>
        ${_panelKpiCard(
          App.t('cal.kpi_cf_net'),
          cfNetStr,
          cfNetColor,
          'cal.tip_cf_net',
          'counterfactual'
        )}
        ${_panelKpiCard(
          App.t('cal.kpi_cf_lost'),
          cfLostStr,
          cfLostColor,
          'cal.tip_cf_lost',
          'potential missed'
        )}
      </div>`;

    return `
      <div style="background:linear-gradient(135deg,rgba(59,130,246,0.07) 0%,#0a0f1e 100%);border:1px solid rgba(59,130,246,0.12);border-radius:12px;padding:14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <div style="width:3px;height:14px;background:#3b82f6;border-radius:2px"></div>
          <span style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.08em">${App.t('cal.panel_entry')}</span>
          <span style="font-size:8px;background:#3b82f618;color:#60a5fa;border:1px solid #3b82f633;border-radius:10px;padding:1px 6px">${App.t('cal.panel_entry_badge')}</span>
        </div>
        ${kpiGrid}
      </div>`;
  }

  function _buildExitPanel(exitKpi) {
    const totalExits = exitKpi.total_exits || 0;
    const tpCount = Math.round((exitKpi.tp_hit_rate || 0) * totalExits);

    const exitEff = exitKpi.exit_efficiency || 0;
    const tpHit = exitKpi.tp_hit_rate || 0;
    const leftOn = exitKpi.left_on_table || 0;
    const slRate = exitKpi.sl_rate || 0;

    const kpiGrid = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
        ${_panelKpiCard(
          App.t('cal.kpi_exit_efficiency'),
          (exitEff * 100).toFixed(0) + '%',
          _exitKpiColor('exit_efficiency', exitEff),
          'cal.tip_exit_efficiency',
          'avg peak capture'
        )}
        ${_panelKpiCard(
          App.t('cal.kpi_tp_hit_rate'),
          (tpHit * 100).toFixed(0) + '%',
          _exitKpiColor('tp_hit_rate', tpHit),
          'cal.tip_tp_hit_rate',
          tpCount + '/' + totalExits + ' exits'
        )}
        ${_panelKpiCard(
          App.t('cal.kpi_left_on_table'),
          (leftOn * 100).toFixed(0) + '%',
          _exitKpiColor('left_on_table', leftOn),
          'cal.tip_left_on_table',
          'avg unrealized peak'
        )}
        ${_panelKpiCard(
          App.t('cal.kpi_sl_rate'),
          (slRate * 100).toFixed(0) + '%',
          _exitKpiColor('sl_rate', slRate),
          'cal.tip_sl_rate',
          'stop-loss rate'
        )}
      </div>`;

    return `
      <div style="background:linear-gradient(135deg,rgba(245,158,11,0.07) 0%,#1a150a 100%);border:1px solid rgba(245,158,11,0.12);border-radius:12px;padding:14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <div style="width:3px;height:14px;background:#f59e0b;border-radius:2px"></div>
          <span style="font-size:10px;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:.08em">${App.t('cal.panel_exit')}</span>
          <span style="font-size:8px;background:#f59e0b18;color:#fbbf24;border:1px solid #f59e0b33;border-radius:10px;padding:1px 6px">${App.t('cal.panel_exit_badge')}</span>
        </div>
        ${kpiGrid}
      </div>`;
  }

  function _buildPerfPanel(perf) {
    const wr = perf.win_rate || 0;
    const pf = perf.profit_factor || 0;
    const avgPnl = perf.avg_pnl || 0;
    const totalPnl = perf.total_pnl || 0;
    const totalTrades = perf.total_trades || 0;
    const winCount = Math.round(wr * totalTrades);
    const lossCount = totalTrades - winCount;

    const avgPnlStr = (avgPnl >= 0 ? '+$' : '-$') + Math.abs(avgPnl).toFixed(2);
    const totalPnlStr = (totalPnl >= 0 ? '+$' : '-$') + Math.abs(totalPnl).toFixed(2);

    const kpiGrid = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
        ${_panelKpiCard(
          App.t('cal.kpi_win_rate'),
          (wr * 100).toFixed(0) + '%',
          _perfKpiColor('win_rate', wr),
          'cal.tip_win_rate',
          winCount + 'W / ' + lossCount + 'L'
        )}
        ${_panelKpiCard(
          App.t('cal.kpi_profit_factor'),
          pf.toFixed(2) + '×',
          _perfKpiColor('profit_factor', pf),
          'cal.tip_profit_factor',
          null
        )}
        ${_panelKpiCard(
          App.t('cal.kpi_avg_pnl'),
          avgPnlStr,
          _perfKpiColor('avg_pnl', avgPnl),
          'cal.tip_avg_pnl',
          null
        )}
        ${_panelKpiCard(
          App.t('cal.kpi_total_pnl'),
          totalPnlStr,
          _perfKpiColor('total_pnl', totalPnl),
          'cal.tip_total_pnl',
          null
        )}
      </div>`;

    const note = _perfNote(perf);

    return `
      <div style="background:linear-gradient(135deg,rgba(34,197,94,0.07) 0%,#0a1a12 100%);border:1px solid rgba(34,197,94,0.12);border-radius:12px;padding:14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <div style="width:3px;height:14px;background:#22c55e;border-radius:2px"></div>
          <span style="font-size:10px;font-weight:700;color:#22c55e;text-transform:uppercase;letter-spacing:.08em">${App.t('cal.panel_performance')}</span>
          <span style="font-size:8px;background:#22c55e18;color:#4ade80;border:1px solid #22c55e33;border-radius:10px;padding:1px 6px">${App.t('cal.panel_perf_badge')}</span>
        </div>
        ${kpiGrid}
        ${note}
      </div>`;
  }

  // ── Main module ────────────────────────────────────────────────────────────
  const CalOverview = {

    async load() {
      const el = document.getElementById('calTabOverview');
      if (!el) return;

      // Show loading skeleton
      el.innerHTML = `<div style="color:#475569;font-size:12px;padding:24px 0;text-align:center">${App.t('cal.loading')}</div>`;

      let data;
      try {
        data = await App.fetchJSON('/api/polymarket/calibration/overview');
      } catch (e) {
        el.innerHTML = `<div style="color:#f43f5e;font-size:12px;padding:24px 0;text-align:center">${esc(App.t('cal.load_error', {error: e.message}))}</div>`;
        return;
      }

      this.render(data);

      if (window.CalShell && typeof CalShell.updateStatusBar === 'function') {
        CalShell.updateStatusBar(data);
      }
    },

    render(data) {
      const el = document.getElementById('calTabOverview');
      if (!el) return;

      if (!data || (!data.kpi && !(data.recommendations || []).length && !(data.history || []).length)) {
        el.innerHTML = `
          <div style="text-align:center;padding:48px 0;color:#475569">
            <div style="font-size:32px;margin-bottom:12px">📊</div>
            <div style="font-size:13px;font-weight:600;color:#94a3b8">${App.t('cal.not_started')}</div>
            <div style="font-size:11px;color:#475569;margin-top:6px">${App.t('cal.not_started_hint')}</div>
          </div>`;
        return;
      }

      const kpi     = data.kpi          || {};
      const exitKpi = data.exit_kpi     || {};
      const perf    = data.performance  || {};
      const recs    = data.recommendations || [];
      const history = data.history      || [];
      const mode    = data.mode         || 'manual';

      // Refresh exit targets from server so _exitKpiColor stays in sync with calibrator.
      if (data.exit_targets) Object.assign(_exitTargets, data.exit_targets);

      // ── Three panels ───────────────────────────────────────────────────────
      const entryPanel = _buildEntryPanel(kpi);
      const exitPanel  = _buildExitPanel(exitKpi);
      const perfPanel  = _buildPerfPanel(perf);

      const panels = `<div class="cal-overview-panels">${entryPanel}${exitPanel}${perfPanel}</div>`;

      // ── Multi-KPI objective strip (deficit-weighted bar, shown above recs) ─
      const objectiveStrip = _buildObjectiveStrip(data);

      // ── Recommendations ────────────────────────────────────────────────────
      let recsHtml = '';
      const shownKeys = [];
      if ((mode === 'watch' || mode === 'auto') && recs.length > 0) {
        const stableCount = recs.filter(r => r.confidence_status === 'stable').length;
        recs.forEach(r => { if (r.config_key) shownKeys.push(r.config_key); });
        const recCards = recs.map((r, i) => _recCard(r, i)).join('');

        const batchBtn = stableCount > 0
          ? `<div style="margin-top:10px;text-align:right">
               <button
                 id="calApplyStable"
                 onclick="CalOverview._applyStable(this)"
                 style="padding:7px 16px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;background:#166534;color:#bbf7d0;border:none">
                 ${App.t('cal.apply_stable')} (${stableCount})
               </button>
             </div>`
          : '';

        recsHtml = `
          <div style="margin-bottom:16px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
              <div style="width:3px;height:14px;background:#f59e0b;border-radius:2px"></div>
              <span style="font-size:11px;font-weight:700;color:#f1f5f9;text-transform:uppercase;letter-spacing:.06em">${App.t('cal.recs_title')}</span>
              <span style="font-size:9px;background:#f59e0b22;color:#fbbf24;border:1px solid #f59e0b33;border-radius:10px;padding:1px 7px;font-weight:600">${recs.length}</span>
            </div>
            ${recCards}
            <div style="margin-top:10px;padding:10px 14px;background:rgba(167,139,250,0.06);border-left:3px solid #a78bfa;border-radius:0 8px 8px 0;font-size:10.5px;color:#cbd5e1;line-height:1.6">
              <strong style="color:#c4b5fd">${App.t('cal.tip_how_computed')}:</strong> ${App.t('cal.tip_recs_body')}
            </div>
            ${batchBtn}
          </div>`;
      } else if ((mode === 'watch' || mode === 'auto') && recs.length === 0) {
        recsHtml = _recsStatusBlock(kpi, data);
      } else if (mode === 'manual') {
        recsHtml = _recsStatusBlock(kpi, data);
      }

      // ── Filtered-out block (levers below MIN_LIFT_THRESHOLD) ───────────────
      const filteredOut = _buildFilteredOut(data, shownKeys);

      // ── History tables (split entry/exit) ──────────────────────────────────
      const exitKeys = data.exit_keys || [];
      const historyHtml = _historySection(history, exitKeys);

      // ── Assemble ───────────────────────────────────────────────────────────
      el.innerHTML = `<div style="padding:2px 0">${panels}${objectiveStrip}${recsHtml}${filteredOut}${historyHtml}</div>`;

      // Store current recs for action handlers
      this._recs = recs;
      this._data = data;
    },

    // ── Action handlers ──────────────────────────────────────────────────────

    async _applyRec(configKey, btn) {
      if (!configKey) { App.toast(App.t('cal.no_trace_id'), 'err'); return; }
      await App.withLoading(btn, async () => {
        const resp = await App.fetchJSON('/api/polymarket/calibration/apply', {
          method: 'POST',
          body: JSON.stringify({ config_key: configKey }),
        });
        if (resp && resp.success) {
          App.toast(App.t('cal.applied_ok'), 'ok');
          this._reloadAfterAction();
        } else {
          const msg = (resp && resp.error) || App.t('cal.apply_error');
          App.toast(msg, 'err');
          throw new Error(msg);
        }
      });
    },

    async _skipRec(configKey, btn) {
      if (!configKey) { App.toast(App.t('cal.no_trace_id'), 'err'); return; }
      await App.withLoading(btn, async () => {
        const resp = await App.fetchJSON('/api/polymarket/calibration/skip', {
          method: 'POST',
          body: JSON.stringify({ config_key: configKey }),
        });
        if (resp && resp.success) {
          App.toast(App.t('cal.skipped_ok'), 'info');
          this._reloadAfterAction();
        } else {
          const msg = (resp && resp.error) || App.t('cal.error');
          App.toast(msg, 'err');
          throw new Error(msg);
        }
      });
    },

    async _applyStable(btn) {
      const recs = (this._recs || []).filter(r => r.confidence_status === 'stable');
      if (!recs.length) { App.toast(App.t('cal.no_stable_recs'), 'warn'); return; }
      await App.withLoading(btn, async () => {
        let applied = 0;
        for (const rec of recs) {
          try {
            const resp = await App.fetchJSON('/api/polymarket/calibration/apply', {
              method: 'POST',
              body: JSON.stringify({ config_key: rec.config_key }),
            });
            if (resp && resp.success) applied++;
          } catch (e) {
            console.warn('[cal-overview] applyStable failed for', rec.config_key, e);
          }
        }
        App.toast(App.t('cal.applied_n_of_m', {applied, total: recs.length}), applied > 0 ? 'ok' : 'warn');
        this._reloadAfterAction();
      });
    },

    _reloadAfterAction() {
      if (window.CalShell) {
        const S = App.state;
        S.calLoaded = S.calLoaded || {};
        S.calLoaded.overview = false;
        CalShell.switchTab('overview');
      } else {
        this.load();
      }
    },
  };

  window.CalOverview = CalOverview;

})(window.App);
