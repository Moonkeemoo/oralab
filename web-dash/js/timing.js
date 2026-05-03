/* Ora et Labora — Execution Chain tab (timing waterfall + trends + dry/live) */

(function (App) {
  'use strict';

  var $ = App.$;
  var S = App.state;

  // ── State ─────────────────────────────────────────────────────────────────
  S.timingData = null;
  S.timingChain = 'entry';
  S.timingSubTab = 'current';
  S.timingSelectedStage = null;   // clicked stage key
  S.timingDryLiveData = null;     // cached {live, dry}

  var COLORS = { fast: '#3fb950', network: '#f0883e', chain: '#bc8cff', slow: '#f85149' };
  var COLORS_DIM = { fast: 'rgba(63,185,80,0.18)', network: 'rgba(240,136,62,0.18)', chain: 'rgba(188,140,255,0.18)', slow: 'rgba(248,81,73,0.18)' };

  // ── Helpers ───────────────────────────────────────────────────────────────
  function fmt(ms) {
    if (ms == null || ms === 0) return '—';
    return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
  }
  function pctOf(part, total) { return total > 0 ? Math.round(part / total * 100) : 0; }
  function typeColor(t) { return COLORS[t] || COLORS.fast; }
  function typeBg(t) { return COLORS_DIM[t] || COLORS_DIM.fast; }
  function typeLabel(t) { return t === 'fast' ? 'CPU/Fast' : t === 'network' ? 'Network I/O' : t === 'chain' ? 'On-chain TX' : 'Bottleneck'; }

  function miniCard(label, value, color, sub) {
    return '<div class="tc-card"><div class="tc-card-label">' + App.esc(label) + '</div>' +
      '<div class="tc-card-value" style="color:' + color + '">' + value + '</div>' +
      (sub ? '<div class="tc-card-sub">' + sub + '</div>' : '') + '</div>';
  }

  function detailRow(k, v) {
    return '<div class="tc-detail-row"><span class="tc-dim">' + k + '</span><span style="font-weight:600">' + v + '</span></div>';
  }

  // ── Load data ─────────────────────────────────────────────────────────────
  App.loadTimingData = async function () {
    try {
      var chain = S.timingChain;
      var data = await App.fetchJSON('/api/polymarket/timing?chain=' + chain + '&limit=100');
      S.timingData = data;
      S.timingSelectedStage = null;
      S.timingDryLiveData = null;
      App.renderTiming();
    } catch (e) {
      console.error('[timing]', e);
      App.toast(App.t('chain.load_err'), 'warn');
    }
  };

  // ── Render orchestrator ───────────────────────────────────────────────────
  App.renderTiming = function () {
    var data = S.timingData;
    if (!data || !data.count) {
      $('timingCards').innerHTML = '';
      $('timingWaterfall').innerHTML = '<div style="text-align:center;color:var(--t3);padding:60px">' + App.t('chain.no_data') + '</div>';
      $('timingRight').innerHTML = '';
      return;
    }
    document.querySelectorAll('.tc-subtab').forEach(function (b) { b.classList.toggle('on', b.dataset.sub === S.timingSubTab); });
    document.querySelectorAll('.tc-chain-btn').forEach(function (b) { b.classList.toggle('on', b.dataset.chain === S.timingChain); });
    $('timingPanelTitle').textContent = S.timingSubTab === 'drylive' ? App.t('chain.panel_title_drylive', {chain: S.timingChain}) :
      S.timingSubTab === 'trends' ? App.t('chain.panel_title_trends', {chain: S.timingChain}) : App.t('chain.panel_title_waterfall', {chain: S.timingChain === 'entry' ? 'Entry' : 'Exit'});

    if (S.timingSubTab === 'current') _renderCurrent(data);
    else if (S.timingSubTab === 'trends') _renderTrends(data);
    else if (S.timingSubTab === 'drylive') _renderDryLive();
  };

  // ── Render detail panel for a stage ───────────────────────────────────────
  function _renderStageDetail(stageKey, summaryObj, metaObj, extra) {
    var s = summaryObj || {};
    var meta = metaObj || {};
    var html = '<div class="tc-section-title">' + App.esc(s.label || stageKey) + '</div>';
    html += detailRow(App.t('chain.detail_phase'), meta.phase || '—');
    html += detailRow(App.t('chain.detail_type'), typeLabel(s.type || meta.type));
    html += '<div style="height:8px"></div>';
    html += detailRow('Avg', fmt(s.avg));
    html += detailRow('Median', fmt(s.p50));
    html += detailRow('P95', fmt(s.p95));
    html += detailRow('Min', fmt(s.min));
    html += detailRow('Max', fmt(s.max));
    html += detailRow(App.t('chain.records_label'), String(s.count || 0));
    if (extra) html += extra;
    $('timingRight').innerHTML = html;
  }

  // ── TAB 1: Поточний стан ─────────────────────────────────────────────────
  function _renderCurrent(data) {
    var summary = data.summary || {};
    var totals = data.totals || {};
    var records = data.records || [];
    var anomalies = data.anomalies || [];
    var stages = data.stages_order || [];

    var netMs = 0, chainMs = 0, cpuMs = 0;
    stages.forEach(function (k) {
      var s = summary[k]; if (!s) return;
      if (s.type === 'network') netMs += s.avg;
      else if (s.type === 'chain') chainMs += s.avg;
      else if (s.type === 'slow') { /* wait/latency stages excluded from processing breakdown */ }
      else cpuMs += s.avg;
    });
    var totalAvg = totals.avg || 0;
    var processingMs = netMs + chainMs + cpuMs;
    var bnStage = '', bnMs = 0;
    stages.forEach(function (k) { var s = summary[k]; if (s && s.avg > bnMs) { bnMs = s.avg; bnStage = s.label; } });

    $('timingCards').innerHTML =
      miniCard('Avg Total', fmt(totalAvg), totalAvg < 8000 ? '#3fb950' : totalAvg < 18000 ? '#d29922' : '#f85149', App.t('settings.decisions_records', {count: data.count})) +
      miniCard('Час обробки', fmt(processingMs), processingMs < 3000 ? '#3fb950' : processingMs < 8000 ? '#d29922' : '#f85149', pctOf(processingMs, totalAvg) + '%') +
      miniCard('Network', fmt(netMs), '#f0883e', pctOf(netMs, totalAvg) + '%') +
      miniCard('On-chain', fmt(chainMs), '#bc8cff', pctOf(chainMs, totalAvg) + '%') +
      miniCard('CPU', fmt(cpuMs), '#3fb950', pctOf(cpuMs, totalAvg) + '%') +
      miniCard('Bottleneck', fmt(bnMs), '#f85149', bnStage);

    // Waterfall
    var maxP95 = 0;
    stages.forEach(function (k) { var s = summary[k]; if (s && s.p95 > maxP95) maxP95 = s.p95; });
    if (maxP95 === 0) maxP95 = 1;
    var lastPhase = '', wf = '';
    stages.forEach(function (k) {
      var s = summary[k]; if (!s) return;
      var meta = (data.stage_meta || {})[k] || {};
      if (meta.phase !== lastPhase) { lastPhase = meta.phase; wf += '<div class="tc-phase">' + App.esc(lastPhase) + '</div>'; }
      var barW = Math.max(s.avg / maxP95 * 100, 1.5);
      var p95W = Math.max(s.p95 / maxP95 * 100, 1.5);
      var sel = S.timingSelectedStage === k;
      wf += '<div class="tc-wf-row' + (sel ? ' selected' : '') + '" onclick="selectTimingStage(\'' + k + '\')">' +
        '<div class="tc-wf-header"><span class="tc-wf-label">' + App.esc(s.label) + '</span>' +
        '<span><span class="tc-wf-time" style="color:' + typeColor(s.type) + '">' + fmt(s.avg) + '</span>' +
        ' <span class="tc-wf-p95">p95: ' + fmt(s.p95) + '</span></span></div>' +
        '<div class="tc-wf-bar-bg">' +
        '<div class="tc-wf-bar-p95" style="width:' + p95W + '%;background:' + typeBg(s.type) + '"></div>' +
        '<div class="tc-wf-bar" style="width:' + barW + '%;background:' + typeColor(s.type) + '"></div>' +
        '</div></div>';
    });
    $('timingWaterfall').innerHTML = wf;

    // Right panel: detail or anomalies+trades
    if (S.timingSelectedStage && summary[S.timingSelectedStage]) {
      var sk = S.timingSelectedStage;
      _renderStageDetail(sk, summary[sk], (data.stage_meta || {})[sk]);
    } else {
      var rh = '';
      if (anomalies.length) {
        rh += '<div class="tc-section-title" style="color:var(--red)">' + App.t('chain.anomalies_title') + '</div>';
        anomalies.forEach(function (a) {
          rh += '<div class="tc-anomaly"><div class="tc-anomaly-header"><span>' + App.esc(a.trade_id || '—') + '</span>' +
            '<span class="tc-dim">' + new Date(a.ts * 1000).toLocaleTimeString('uk-UA') + '</span></div>' +
            '<div class="tc-dim" style="font-size:11px">' + App.esc(a.market || '') + '</div>' +
            '<div style="color:var(--red);margin-top:4px">' + App.esc(a.stage_label) + ': <b>' + fmt(a.value_ms) + '</b>' +
            ' <span class="tc-dim">(avg: ' + fmt(a.avg_ms) + ')</span></div></div>';
        });
      }
      // Count placed vs rejected
      var placedCount = 0, rejectedCount = 0;
      records.forEach(function (r) { if ((r.result || '').indexOf('rejected') === 0) rejectedCount++; else placedCount++; });
      rh += '<div class="tc-section-title">' + App.t('chain.recent_signals') + ' <span class="tc-dim" style="font-weight:400;font-size:10px">' +
        App.t('chain.placed_rejected', {placed: placedCount, rejected: rejectedCount}) + '</span></div>';
      records.slice(-15).reverse().forEach(function (rec) {
        var total = rec.total_ms || 0;
        var isRejected = (rec.result || '').indexOf('rejected') === 0;
        var rejectReason = isRejected ? (rec.result || '').replace('rejected:', '') : '';
        var cls = isRejected ? 'color:var(--t3)' : (total < 8000 ? 'color:#3fb950' : total < 18000 ? 'color:#d29922' : 'color:#f85149');
        var modeTag = rec.mode === 'live' ? '<span class="b b-live" style="font-size:9px">LIVE</span>' : '<span class="b" style="font-size:9px">DRY</span>';
        var resultTag = isRejected ? ' <span style="font-size:9px;color:var(--red);border:1px solid var(--red-brd);padding:1px 5px;border-radius:3px">✕ ' + App.esc(rejectReason || 'rejected') + '</span>' :
          ' <span style="font-size:9px;color:var(--grn);border:1px solid var(--grn-brd);padding:1px 5px;border-radius:3px">✓</span>';
        rh += '<div class="tc-trade' + (isRejected ? ' rejected' : '') + '" onclick="toggleTimingTrade(this)"><div class="tc-trade-header"><span>' + modeTag + resultTag + ' ' +
          App.esc(rec.trade_id || rec.whale || '—') + '</span><span style="font-weight:700;' + cls + '">' + fmt(total) + '</span></div>' +
          '<div class="tc-dim" style="font-size:10px">' + new Date(rec.ts * 1000).toLocaleTimeString('uk-UA') +
          ' · ' + App.esc((rec.market || '').substring(0, 40)) + '</div><div class="tc-trade-detail" style="display:none">';
        stages.forEach(function (k) {
          var val = (rec.stages || {})[k]; if (!val || val <= 0) return;
          var meta = (data.stage_meta || {})[k] || {};
          var isHot = summary[k] && val > (summary[k].p95 || 9999);
          rh += '<div class="tc-trade-stage' + (isHot ? ' hot' : '') + '"><span>' + (isHot ? '🔴 ' : '') +
            App.esc(meta.label || k) + '</span><span style="color:' + (isHot ? 'var(--red)' : typeColor(meta.type || 'fast')) +
            ';font-weight:600">' + fmt(val) + '</span></div>';
        });
        rh += '</div></div>';
      });
      $('timingRight').innerHTML = rh;
    }
  }

  // ── TAB 2: Тренди ────────────────────────────────────────────────────────
  function _renderTrends(data) {
    var summary = data.summary || {};
    var trend = data.trend || [];
    var stages = data.stages_order || [];

    // L23: adaptive bucket sizing — picks smallest bucket that fits data span.
    // Server returns bucket_sec in data.trend_bucket_sec (10s..300s).
    var bSec = data.trend_bucket_sec || 300;
    var spanSec = trend.length * bSec;
    var spanLabel = spanSec < 60
      ? (spanSec + ' ' + App.t('chain.sec'))
      : (spanSec < 3600 ? Math.round(spanSec / 60) + ' ' + App.t('chain.min') : (spanSec / 3600).toFixed(1) + ' ' + App.t('chain.hour'));
    var bLabel = bSec < 60 ? App.t('chain.sec_bucket', {n: bSec}) : App.t('chain.min_bucket', {n: Math.round(bSec / 60)});
    var html = '<div style="padding:12px 14px"><div class="tc-section-title">' + App.t('chain.trend_latency_title') + '</div>' +
      '<div class="tc-dim" style="margin-bottom:12px">' + App.t('chain.trend_stages_subtitle', {span: spanLabel, bucket: bLabel}) + '</div></div>';

    html += '<div class="tc-trend-grid" style="padding:0 14px 14px">';
    stages.forEach(function (k) {
      var s = summary[k]; if (!s) return;
      var meta = (data.stage_meta || {})[k] || {};
      var color = typeColor(s.type);
      var vals = trend.map(function (t) { return t.stages && t.stages[k] ? t.stages[k] : null; });
      var validVals = vals.filter(function (v) { return v !== null; });
      if (!validVals.length) return;
      var maxVal = Math.max.apply(null, validVals), minVal = Math.min.apply(null, validVals);
      var lastVal = validVals[validVals.length - 1] || 0;
      var prevVal = validVals.length > 2 ? validVals[Math.max(0, validVals.length - 6)] : (validVals.length > 1 ? validVals[0] : lastVal);
      var trendPct = prevVal > 0 ? Math.round((lastVal - prevVal) / prevVal * 100) : 0;
      var trendUp = trendPct > 0;
      var sel = S.timingSelectedStage === k;

      // SVG sparkline
      var svgW = 140, svgH = 32, points = [];
      vals.forEach(function (v, i) {
        if (v === null) return;
        var x = i / Math.max(vals.length - 1, 1) * svgW;
        var y = maxVal > minVal ? svgH - (v - minVal) / (maxVal - minVal) * (svgH - 4) - 2 : svgH / 2;
        points.push(x.toFixed(1) + ',' + y.toFixed(1));
      });
      var svgLine = points.length > 1 ? '<polyline points="' + points.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="1.5"/>' : '';
      var areaP = points.join(' ');
      if (points.length > 1) areaP += ' ' + svgW + ',' + svgH + ' 0,' + svgH;
      var svgArea = points.length > 1 ? '<polygon points="' + areaP + '" fill="' + color + '" opacity="0.12"/>' : '';

      html += '<div class="tc-trend-card' + (sel ? ' selected' : '') + '" onclick="selectTimingStage(\'' + k + '\')" style="cursor:pointer">' +
        '<div class="tc-trend-card-header"><span style="color:' + color + ';font-size:10px">' + App.esc(meta.phase || '') + '</span>' +
        '<span style="color:' + (trendUp ? 'var(--red)' : 'var(--grn)') + ';font-size:10px;font-weight:600">' +
        (trendUp ? '↑' : '↓') + ' ' + Math.abs(trendPct) + '%</span></div>' +
        '<div style="font-size:11px;font-weight:600;margin-bottom:4px">' + App.esc(s.label) + '</div>' +
        '<svg width="' + svgW + '" height="' + svgH + '" style="display:block;margin-bottom:4px">' + svgArea + svgLine + '</svg>' +
        '<div class="tc-trend-card-footer"><span>avg: <b>' + fmt(s.avg) + '</b></span><span>p95: <b style="color:var(--amber)">' + fmt(s.p95) + '</b></span></div></div>';
    });
    html += '</div>';

    // Total trend chart
    var totalVals = trend.map(function (t) { return t.total; }).filter(function (v) { return v !== null; });
    if (totalVals.length > 1) {
      var tMax = Math.max.apply(null, totalVals), tMin = Math.min.apply(null, totalVals);
      var svgTW = 800, svgTH = 80, tPoints = [];
      trend.forEach(function (t, i) {
        if (t.total === null) return;
        var x = i / (trend.length - 1) * svgTW;
        var y = tMax > tMin ? svgTH - (t.total - tMin) / (tMax - tMin) * (svgTH - 8) - 4 : svgTH / 2;
        tPoints.push(x.toFixed(1) + ',' + y.toFixed(1));
      });
      html += '<div class="tc-total-trend" style="margin:0 14px 14px"><div class="tc-section-title">' + App.t('chain.total_chain_time', {chain: S.timingChain}) + '</div>' +
        '<svg width="100%" viewBox="0 0 ' + svgTW + ' ' + svgTH + '" preserveAspectRatio="none" style="display:block">' +
        '<polygon points="' + tPoints.join(' ') + ' ' + svgTW + ',' + svgTH + ' 0,' + svgTH + '" fill="var(--ind)" opacity="0.15"/>' +
        '<polyline points="' + tPoints.join(' ') + '" fill="none" stroke="var(--ind)" stroke-width="2"/></svg>' +
        '<div class="tc-dim" style="display:flex;justify-content:space-between;margin-top:4px"><span>min: ' + fmt(tMin) + '</span><span>max: ' + fmt(tMax) + '</span></div></div>';
    }

    $('timingCards').innerHTML = '';
    $('timingWaterfall').innerHTML = html;

    // Right panel: selected stage detail or hint
    if (S.timingSelectedStage && summary[S.timingSelectedStage]) {
      var sk = S.timingSelectedStage, ss = summary[sk], meta = (data.stage_meta || {})[sk] || {};
      var vals = trend.map(function (t) { return t.stages && t.stages[sk] ? t.stages[sk] : null; });
      var validVals = vals.filter(function (v) { return v !== null; });
      var lastVal = validVals.length ? validVals[validVals.length - 1] : 0;
      var prevVal = validVals.length > 2 ? validVals[Math.max(0, validVals.length - 6)] : (validVals.length > 1 ? validVals[0] : lastVal);
      var trendPct = prevVal > 0 ? Math.round((lastVal - prevVal) / prevVal * 100) : 0;
      var extra = '<div style="height:12px"></div><div class="tc-section-title">' + App.t('chain.trend_title') + '</div>' +
        detailRow(App.t('chain.trend_current'), fmt(lastVal)) +
        detailRow(App.t('chain.trend_5_ago'), fmt(prevVal)) +
        detailRow(App.t('chain.trend_change'), (trendPct > 0 ? '+' : '') + trendPct + '%') +
        '<div style="margin-top:8px;font-size:11px;color:' + (trendPct > 5 ? 'var(--red)' : 'var(--grn)') + '">' +
        (trendPct > 5 ? App.t('chain.trend_degraded') : App.t('chain.trend_stable')) + '</div>';
      _renderStageDetail(sk, ss, meta, extra);
    } else {
      $('timingRight').innerHTML = '<div style="padding:20px;text-align:center;color:var(--t3)">' + App.t('chain.click_stage_hint') + '</div>';
    }
  }

  // ── TAB 3: Dry vs Live ───────────────────────────────────────────────────
  function _renderDryLive() {
    if (S.timingDryLiveData) {
      _renderDryLiveInner(S.timingDryLiveData.live, S.timingDryLiveData.dry);
      return;
    }
    $('timingWaterfall').innerHTML = '<div style="text-align:center;color:var(--t3);padding:40px">' + App.t('chain.loading') + '</div>';
    Promise.all([
      App.fetchJSON('/api/polymarket/timing?chain=' + S.timingChain + '&mode=live&limit=100'),
      App.fetchJSON('/api/polymarket/timing?chain=' + S.timingChain + '&mode=dry_run&limit=100'),
    ]).then(function (res) {
      S.timingDryLiveData = { live: res[0] || {}, dry: res[1] || {} };
      _renderDryLiveInner(S.timingDryLiveData.live, S.timingDryLiveData.dry);
    }).catch(function (e) { console.error('[drylive]', e); });
  }

  function _renderDryLiveInner(liveData, dryData) {
    var liveSummary = liveData.summary || {};
    var drySummary = dryData.summary || {};
    var liveTotals = liveData.totals || {};
    var dryTotals = dryData.totals || {};
    var stages = liveData.stages_order || dryData.stages_order || [];

    var liveTotal = liveTotals.avg || 0, dryTotal = dryTotals.avg || 0, diff = liveTotal - dryTotal;
    var chainOverhead = 0;
    stages.forEach(function (k) { var s = liveSummary[k]; if (s && s.type === 'chain') chainOverhead += s.avg; });

    $('timingCards').innerHTML =
      miniCard('Live avg', fmt(liveTotal), '#bc8cff', (liveData.count || 0) + ' trades') +
      miniCard('Dry avg', fmt(dryTotal), '#d29922', (dryData.count || 0) + ' trades') +
      miniCard('On-chain overhead', (diff > 0 ? '+' : '') + fmt(diff), diff > 0 ? '#f85149' : '#3fb950',
        dryTotal > 0 ? App.t('chain.pct_slower', {pct: pctOf(diff, dryTotal)}) : '') +
      miniCard(App.t('chain.on_chain_share'), pctOf(chainOverhead, liveTotal) + '%', '#bc8cff', App.t('chain.pct_of_live')) +
      miniCard(App.t('chain.records_label'), (liveData.count || 0) + ' / ' + (dryData.count || 0), 'var(--t1)', 'live / dry');

    // Build waterfall with dual bars
    var maxMs = 0;
    stages.forEach(function (k) {
      var l = liveSummary[k], d = drySummary[k];
      var lv = l ? l.avg : 0, dv = d ? d.avg : 0;
      if (lv > maxMs) maxMs = lv;
      if (dv > maxMs) maxMs = dv;
    });
    if (maxMs === 0) maxMs = 1;

    var lastPhase = '', wf = '';
    stages.forEach(function (k) {
      var live = liveSummary[k], dry = drySummary[k];
      if (!live && !dry) return;
      var liveAvg = live ? live.avg : 0, dryAvg = dry ? dry.avg : 0;
      var d = liveAvg - dryAvg;
      var meta = ((liveData.stage_meta || dryData.stage_meta) || {})[k] || {};
      if (meta.phase !== lastPhase) { lastPhase = meta.phase; wf += '<div class="tc-phase">' + App.esc(lastPhase) + '</div>'; }
      var sel = S.timingSelectedStage === k;
      var liveW = Math.max(liveAvg / maxMs * 100, 0.5);
      var dryW = Math.max(dryAvg / maxMs * 100, 0.5);
      var dColor = d > 100 ? 'var(--red)' : d < -100 ? 'var(--grn)' : 'var(--t3)';

      wf += '<div class="tc-wf-row' + (sel ? ' selected' : '') + '" onclick="selectTimingStage(\'' + k + '\')">' +
        '<div class="tc-wf-header"><span class="tc-wf-label">' + App.esc(meta.label || k) + '</span>' +
        '<span><span style="color:#bc8cff;font-weight:600">' + fmt(liveAvg) + '</span>' +
        ' <span style="color:#d29922;font-weight:600;margin:0 6px">' + fmt(dryAvg) + '</span>' +
        '<span style="color:' + dColor + ';font-weight:600">' + (d > 0 ? '+' : '') + fmt(d) + '</span></span></div>' +
        '<div class="tc-dl-bars">' +
        '<div class="tc-dl-bar" style="width:' + liveW + '%;background:#bc8cff"></div>' +
        '<div class="tc-dl-bar dry" style="width:' + dryW + '%;background:#d29922"></div>' +
        '</div></div>';
    });

    // Total row
    var dColor = diff > 0 ? 'var(--red)' : 'var(--grn)';
    wf += '<div class="tc-wf-row total" style="border-top:2px solid var(--ind);margin-top:4px;padding-top:10px">' +
      '<div class="tc-wf-header"><span class="tc-wf-label" style="font-weight:700">TOTAL</span>' +
      '<span><span style="color:#bc8cff;font-weight:700">' + fmt(liveTotal) + '</span>' +
      ' <span style="color:#d29922;font-weight:700;margin:0 6px">' + fmt(dryTotal) + '</span>' +
      '<span style="color:' + dColor + ';font-weight:700">' + (diff > 0 ? '+' : '') + fmt(diff) + '</span></span></div></div>';

    // Insight
    wf += '<div class="tc-insight" style="margin:12px 14px"><div style="font-weight:600;margin-bottom:4px">' + App.t('chain.insight_title') + '</div>' +
      '<div class="tc-dim">' + App.t('chain.insight_text', {diff: fmt(diff), pct: pctOf(chainOverhead, liveTotal)}) + '</div></div>';

    $('timingWaterfall').innerHTML = wf;

    // Right panel: selected stage detail or legend
    if (S.timingSelectedStage) {
      var sk = S.timingSelectedStage;
      var live = liveSummary[sk], dry = drySummary[sk], meta = ((liveData.stage_meta || dryData.stage_meta) || {})[sk] || {};
      var html = '<div class="tc-section-title">' + App.esc((live || dry || {}).label || sk) + '</div>';
      html += detailRow(App.t('chain.detail_type'), typeLabel(meta.type || 'fast'));
      html += '<div style="height:12px"></div>';
      html += '<div class="tc-section-title" style="color:#bc8cff">Live</div>';
      if (live) {
        html += detailRow('Avg', fmt(live.avg));
        html += detailRow('P95', fmt(live.p95));
        html += detailRow('Min / Max', fmt(live.min) + ' / ' + fmt(live.max));
        html += detailRow(App.t('chain.records_label'), String(live.count));
      } else { html += '<div class="tc-dim" style="font-size:11px">' + App.t('chain.no_data_small') + '</div>'; }

      html += '<div style="height:12px"></div>';
      html += '<div class="tc-section-title" style="color:#d29922">Dry</div>';
      if (dry) {
        html += detailRow('Avg', fmt(dry.avg));
        html += detailRow('P95', fmt(dry.p95));
        html += detailRow('Min / Max', fmt(dry.min) + ' / ' + fmt(dry.max));
        html += detailRow(App.t('chain.records_label'), String(dry.count));
      } else { html += '<div class="tc-dim" style="font-size:11px">' + App.t('chain.no_data_small') + '</div>'; }
      var liveAvg = live ? live.avg : 0, dryAvg = dry ? dry.avg : 0, d = liveAvg - dryAvg;
      if (d > 50) {
        html += '<div style="height:12px"></div><div style="font-size:11px;color:var(--red)">⛓ On-chain overhead: <b>+' + fmt(d) + '</b></div>';
      }
      $('timingRight').innerHTML = html;
    } else {
      $('timingRight').innerHTML = '<div style="padding:20px">' +
        '<div class="tc-section-title">' + App.t('chain.legend_title') + '</div>' +
        '<div class="tc-dim" style="margin-bottom:8px"><span style="color:#bc8cff">■</span> ' + App.t('chain.legend_live') + '</div>' +
        '<div class="tc-dim" style="margin-bottom:8px"><span style="color:#d29922">■</span> ' + App.t('chain.legend_dry') + '</div>' +
        '<div class="tc-dim" style="margin-bottom:16px">' + App.t('chain.legend_diff') + '</div>' +
        '<div class="tc-dim">' + App.t('chain.legend_hint') + '</div></div>';
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────────
  window.switchTimingSubTab = function (sub) {
    S.timingSubTab = sub;
    S.timingSelectedStage = null;
    S.timingDryLiveData = null;
    App.renderTiming();
  };

  window.switchTimingChain = function (chain) {
    S.timingChain = chain;
    App.loadTimingData();
  };

  window.selectTimingStage = function (key) {
    S.timingSelectedStage = S.timingSelectedStage === key ? null : key;
    App.renderTiming();
  };

  window.toggleTimingTrade = function (el) {
    var detail = el.querySelector('.tc-trade-detail');
    if (detail) detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
  };

  window.clearTimingData = function () {
    if (!confirm(App.t('chain.clear_confirm'))) return;
    App.fetchJSON('/api/polymarket/timing/clear', { method: 'POST' })
      .then(function () {
        App.toast(App.t('chain.clear_ok'), 'ok');
        S.timingData = null;
        S.timingDryLiveData = null;
        App.renderTiming();
      })
      .catch(function (e) { App.toast(App.t('chain.clear_err', {error: e.message}), 'err'); });
  };

})(window.App);
