(function (App) {
  'use strict';

  const $ = App.$;
  const S = App.state;
  const esc = App.esc;

  let _plOpenId = null;  // currently expanded editor node
  let _plOpenPhases = new Set(['⓪ Hard Safety']);  // phases expanded by default

  // ─── filter helpers ───────────────────────────────────────────────────────────
  function _fmtVal(v) {
    const n = Number(v);
    if (n % 1 === 0) return String(n);
    return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }

  function _fmtFilterVal(entry, value) {
    if (value == null) return '—';
    const t = entry.type;
    const unit = entry.unit || '';
    if (t === 'conviction_gate' && typeof value === 'object') {
      // Multi-threshold display: "PROBE ≥ 0.30 · CONFIRM ≥ 0.04 · CONV ≥ 0 · ABS 0.60"
      const sk = entry.sub_keys || {};
      const parts = [];
      for (const [name, def] of Object.entries(sk)) {
        const v = value[name] != null ? value[name] : def.default;
        if (name === 'formula_base') {
          parts.push(`ABS ≥ $${Number(v).toFixed(0)}`);
        } else {
          parts.push(`${def.label} ≥ ${_fmtVal(v)}`);
        }
      }
      parts.push('CONV ≥ 0');
      return parts.join(' · ');
    }
    if (t === 'gtc_fallback' && typeof value === 'object') {
      const sk = entry.sub_keys || {};
      const en = value['enabled'] != null ? value['enabled'] : (sk.enabled ? sk.enabled.default : true);
      const ttl = value['ttl'] != null ? value['ttl'] : (sk.ttl ? sk.ttl.default : 60);
      return (en ? '✅ ON' : '⛔ OFF') + ' · TTL ' + ttl + 's';
    }
    if (t === 'gtc_fallback' && typeof value !== 'object') {
      return String(value);
    }
    if (t === 'float') {
      const n = Number(value);
      if (unit === '%') return (n * 100).toFixed(0) + '%';
      if (unit === '¢') return (n * 100).toFixed(0) + '¢';
      if (unit === '$') return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
      return n % 1 === 0 ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
    }
    if (t === 'int') return String(Math.round(value)) + (unit ? ' ' + unit : '');
    if (t === 'bool') return value ? '✅ Enabled' : '⛔ Disabled';
    return String(value);
  }

  function _getSelectedBot() {
    const sel = $('filterBotSel');
    const name = sel ? sel.value : (S.selectedBotName || null);
    return S.filters.find(b => b.name === name) || S.filters[0] || null;
  }

  function _getFilterDisplayVal(entry) {
    const key = entry.env_key || entry.key;
    if ((entry.type === 'conviction_gate' || entry.type === 'gtc_fallback') && entry.sub_keys) {
      // Build merged object from current_value + saved overrides + pending edits
      const base = (typeof entry.current_value === 'object' && entry.current_value) || {};
      const result = {};
      for (const [name, def] of Object.entries(entry.sub_keys)) {
        const sk = def.key;
        const pending = S.filterEdits[sk];
        const saved   = S.filterSavedConfig[sk];
        result[name] = pending !== undefined ? pending : saved !== undefined ? saved : (base[name] != null ? base[name] : def.default);
      }
      return result;
    }
    const pending = S.filterEdits[key];
    const saved   = S.filterSavedConfig[key];
    return pending !== undefined ? pending : saved !== undefined ? saved : entry.current_value != null ? entry.current_value : entry.default;
  }

  function _updatePendingCount() {
    const n = Object.keys(S.filterEdits).length;
    const saveBtn = $('filterSaveBtn');
    if (saveBtn) {
      saveBtn.textContent = n ? `Save (${n})` : 'Save';
      saveBtn.style.color = n ? '#fbbf24' : '';
      saveBtn.style.display = n ? '' : 'none';
    }
  }

  // Cached live stats (fetched async, refreshed every 5s on slider input)
  let _convStatsCache = null;
  let _convStatsLastFetch = 0;
  let _convStatsPending = false;

  function _convScore(size, capital, base, pfloor, pceil, megaThr, anchor, alpha) {
    // Mirror of core/scoring/conviction.py:calculate_conviction()
    function adaptiveFloor(cap) {
      if (cap <= anchor) return pfloor;
      return pfloor * Math.pow(anchor / cap, alpha);
    }
    function absSig(s) {
      if (s < base) return 0;
      if (s >= 100000) return 1;
      return Math.log(s / base) / Math.log(100000 / base);
    }
    function pctSig(p, cap) {
      const f = adaptiveFloor(cap);
      if (p < f) return 0;
      if (p >= pceil) return 1;
      return Math.log(p / f) / Math.log(pceil / f);
    }
    if (capital < 1000) return absSig(size) * 0.7;
    const mega = capital >= megaThr;
    const pct = Math.min(size / capital, 0.25);
    let a = absSig(size);
    const p = pctSig(pct, capital);
    if (a <= 0 && p <= 0) return 0;
    if (p <= 0) return a * 0.6;
    if (a <= 0) return p * 0.3;
    if (mega && a < 0.3) a = Math.max(a, 0.2);
    return Math.pow(a, 0.6) * Math.pow(p, 0.4);
  }

  function _convMinTradeSize(threshold, capital, base, pfloor, pceil, megaThr, anchor, alpha) {
    // Binary search: find smallest size where score >= threshold
    let lo = 10, hi = 100000;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (_convScore(mid, capital, base, pfloor, pceil, megaThr, anchor, alpha) < threshold) lo = mid;
      else hi = mid;
    }
    return Math.round((lo + hi) / 2);
  }

  function _fmtConvUSD(v) {
    if (v >= 10000) return '$' + Math.round(v/1000) + 'K';
    if (v >= 1000) return '$' + (v/1000).toFixed(1) + 'K';
    return '$' + Math.round(v);
  }

  function _fetchConvStats() {
    // Throttle: don't refetch more than once per 5 seconds
    const now = Date.now();
    if (_convStatsPending || now - _convStatsLastFetch < 5000) return;
    _convStatsPending = true;
    fetch('/api/polymarket/conviction_stats')
      .then(r => r.json())
      .then(d => {
        if (d && d.ok) {
          _convStatsCache = d;
          _convStatsLastFetch = Date.now();
          _updateConvGateCalc(); // re-render with fresh data
        }
      })
      .catch(() => {})
      .finally(() => { _convStatsPending = false; });
  }

  function _updateConvGateCalc() {
    const el = $('convGateCalc');
    if (!el) return;
    const q = (k) => document.querySelector('.pl-ed-sl[data-filter-key="' + k + '"], .pl-ed-subnum[data-filter-key="' + k + '"]');
    const probe = q('conviction_gate_probe') ? parseFloat(q('conviction_gate_probe').value) : 0.06;
    const confirm_ = q('conviction_gate_confirm') ? parseFloat(q('conviction_gate_confirm').value) : 0.03;
    const base = q('conviction_formula_base') ? parseFloat(q('conviction_formula_base').value) : 400;
    const pfloor = q('conviction_pct_floor') ? parseFloat(q('conviction_pct_floor').value) : 0.005;
    const pceil = q('conviction_pct_ceiling') ? parseFloat(q('conviction_pct_ceiling').value) : 0.20;
    const megaThr = q('conviction_mega_threshold') ? parseFloat(q('conviction_mega_threshold').value) : 500000;
    const anchor = q('conviction_anchor_capital') ? parseFloat(q('conviction_anchor_capital').value) : 200000;
    const alpha = q('conviction_pct_floor_alpha') ? parseFloat(q('conviction_pct_floor_alpha').value) : 0.5;

    // ── Matrix: 4 portfolios × 3 intents ──
    const portfolios = [
      { label: '$40K (малий)', cap: 40000 },
      { label: '$200K', cap: 200000 },
      { label: '$1M', cap: 1000000 },
      { label: '$5M+ (mega)', cap: 5000000 },
    ];
    let matrixRows = portfolios.map(pf => {
      const probeMin = _convMinTradeSize(probe, pf.cap, base, pfloor, pceil, megaThr, anchor, alpha);
      const confMin = _convMinTradeSize(confirm_, pf.cap, base, pfloor, pceil, megaThr, anchor, alpha);
      const convMin = base;
      const probeCls = probeMin <= base * 1.5 ? 'cal-green-text' : probeMin <= base * 2.5 ? 'cal-amber-text' : 'cal-red-text';
      return `<tr>
        <td style="padding:4px 8px;color:var(--t2);text-align:left">${pf.label}</td>
        <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;color:var(--${probeCls.replace('cal-','').replace('-text','')}-text,var(--t1))" class="${probeCls}">${_fmtConvUSD(probeMin)}</td>
        <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums" class="cal-green-text">${_fmtConvUSD(confMin)}</td>
        <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;color:var(--t2)">${_fmtConvUSD(convMin)}</td>
      </tr>`;
    }).join('');

    // ── Live stats ──
    _fetchConvStats(); // triggers async update if stale
    const st = _convStatsCache;
    let statsHTML;
    if (!st) {
      statsHTML = `<div style="color:var(--t3);font-style:italic">Loading last 24h…</div>`;
    } else {
      const probeC = st.probe_pct >= 30 ? 'cal-green-text' : st.probe_pct >= 10 ? 'cal-amber-text' : 'cal-red-text';
      const confC = st.confirm_pct >= 50 ? 'cal-green-text' : st.confirm_pct >= 20 ? 'cal-amber-text' : 'cal-red-text';
      const tightestTxt = st.tightest_rejected
        ? `$${st.tightest_rejected.size_usd.toLocaleString()} → ${st.tightest_rejected.score.toFixed(3)}`
        : '—';
      statsHTML = `
        <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-variant-numeric:tabular-nums">
          <span style="color:var(--t3)">Trades seen</span><span style="text-align:right;color:var(--t1)">${st.total}</span>
          <span style="color:var(--t3)">PROBE pass</span><span style="text-align:right" class="${probeC}">${st.probe_pct}% (${st.probe_pass})</span>
          <span style="color:var(--t3)">CONFIRM pass</span><span style="text-align:right" class="${confC}">${st.confirm_pct}% (${st.confirm_pass})</span>
          <span style="color:var(--t3)">Avg rejected</span><span style="text-align:right;color:var(--t2)">${st.avg_rejected}</span>
          <span style="color:var(--t3)">Tightest reject</span><span style="text-align:right;color:var(--t2);font-size:10px">${tightestTxt}</span>
        </div>`;
    }

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <div style="margin-bottom:6px;font-weight:600;color:var(--t1);font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Min trade by whale capital</div>
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead>
              <tr style="color:var(--t3);border-bottom:1px solid var(--bord)">
                <th style="padding:4px 8px;text-align:left;font-weight:500">Portfolio</th>
                <th style="padding:4px 8px;text-align:right;font-weight:500">PROBE</th>
                <th style="padding:4px 8px;text-align:right;font-weight:500">CONFIRM</th>
                <th style="padding:4px 8px;text-align:right;font-weight:500">CONV</th>
              </tr>
            </thead>
            <tbody>${matrixRows}</tbody>
          </table>
        </div>
        <div>
          <div style="margin-bottom:6px;font-weight:600;color:var(--t1);font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Last 24h through gate</div>
          ${statsHTML}
        </div>
      </div>`;
  }

  function _wireFilterInputs(container) {
    // Multiselect category checkboxes
    container.querySelectorAll('.f-check[data-filter-key]').forEach(cb => {
      cb.addEventListener('change', () => {
        const key = cb.getAttribute('data-filter-key');
        const allChecks = [...container.querySelectorAll(`.f-check[data-filter-key="${key}"]`)];
        const allVals = allChecks.map(c => c.getAttribute('data-cat-val'));
        const checked = allChecks.filter(c => c.checked).map(c => c.getAttribute('data-cat-val'));
        // All checked or none checked → empty string (= all categories allowed)
        S.filterEdits[key] = (checked.length === 0 || checked.length === allVals.length) ? '' : checked.join(',');
        _updatePendingCount();
      });
    });
    // Standard sliders / selects
    container.querySelectorAll('[data-filter-key]').forEach(el => {
      if ((el.tagName === 'INPUT' && el.type !== 'checkbox') || el.tagName === 'SELECT') {
        el.addEventListener('change', e => {
          const key = e.target.getAttribute('data-filter-key');
          let val = e.target.value;
          if (e.target.type === 'number' || e.target.type === 'range') val = parseFloat(val);
          else if (val === 'true') val = true;
          else if (val === 'false') val = false;
          S.filterEdits[key] = val;
          _updatePendingCount();
          renderFilters();
        });
      }
    });
  }

  // ── Pipeline Dashboard (replaces old _renderFilterControls + _renderPipelineImpact) ──

  function _plHeat(pct) {
    if (pct >= 15) return 'pl-hc';
    if (pct >= 2)  return 'pl-hh';
    if (pct > 0)   return 'pl-hm';
    return 'pl-hq';
  }

  // Filters that run in HARD SAFETY CHECKS (place_copy_trade) — always active,
  // even when FilterRegistry pipeline is bypassed for diagnostic testing.
  // Filters that run in HARD SAFETY CHECKS — always active in pipeline viz.
  // Note: drawdown/safety/exit keys are now in Settings tab, not pipeline.
  // All pipeline filters are active
  function _plIsFilterEnabled() {
    return true;
  }

  function _plToggle(id) {
    if (_plOpenId && _plOpenId !== id) {
      var pe = $('pl-ed-' + _plOpenId), pn = document.querySelector('[data-pl-id="' + _plOpenId + '"]');
      if (pe) pe.classList.remove('on');
      if (pn) pn.classList.remove('on');
    }
    var e = $('pl-ed-' + id), n = document.querySelector('[data-pl-id="' + id + '"]');
    if (!e) return;
    var wasOpen = e.classList.contains('on');
    e.classList.toggle('on', !wasOpen);
    if (n) n.classList.toggle('on', !wasOpen);
    _plOpenId = wasOpen ? null : id;
  }

  function _plTogglePhase(name) {
    if (_plOpenPhases.has(name)) _plOpenPhases.delete(name);
    else _plOpenPhases.add(name);
    _renderPipelineDashboard();
  }

  function _plSwitchTab(tab) {
    S._plSubTab = tab;
    // Toggle panel visibility
    const panels = {funnel: 'plTabFunnel', latency: 'plTabLatency', feed: 'plTabFeed'};
    for (const [key, id] of Object.entries(panels)) {
      const el = document.getElementById(id);
      if (el) el.style.display = key === tab ? 'block' : 'none';
    }
    // Update active tab highlight
    const tabMap = {funnel: 0, latency: 1, feed: 2};
    document.querySelectorAll('.pl-subtab').forEach((t, i) => {
      t.classList.toggle('active', i === tabMap[tab]);
    });
  }

  function _plSliderUpdate(slider, id, entry) {
    var val = parseFloat(slider.value);
    var outEl = $('pl-o-' + id);
    if (outEl) outEl.textContent = _fmtFilterVal(entry, val);
    S.filterEdits[entry.env_key || entry.key] = val;
    _updatePendingCount();
  }

  // (Convergence section removed — replaced by elasticity-based threshold softening)

  // Build the five stat cards shown at the top of the pipeline panel.
  // Extracted so `_refreshStatsRow` can update the live counters without
  // re-rendering the whole pipeline (which is skipped when an editor node
  // is expanded — previously that caused reject counters to appear frozen).
  function _buildStatsRowHTML(pipeline) {
    const totalChecked = (S.rejectStats && S.rejectStats.total_checked) || 0;
    const totalRejected = (S.rejectStats && S.rejectStats.total_rejected) || 0;
    const totalAccepted = (S.rejectStats && S.rejectStats.total_accepted) || Math.max(0, totalChecked - totalRejected);
    const passRate = totalChecked > 0 ? (totalAccepted / totalChecked * 100) : 0;
    const activeCount = pipeline.filter(e => (e.reject_count || 0) > 0).length;
    const hsRejects = pipeline.filter(e => (e.key || '').startsWith('HS_')).reduce((s, e) => s + (e.reject_count || 0), 0);

    let h = '';
    h += `<div class="pl-st"><div class="pl-st-n" style="color:var(--red)">${totalRejected.toLocaleString()}</div><div class="pl-st-l">Rejected</div></div>`;
    h += `<div class="pl-st"><div class="pl-st-n" style="color:var(--amb)">${hsRejects.toLocaleString()}</div><div class="pl-st-l">Hard Safety</div></div>`;
    h += `<div class="pl-st"><div class="pl-st-n" style="color:var(--grn)">~${totalAccepted.toLocaleString()}</div><div class="pl-st-l">Accepted</div></div>`;
    h += `<div class="pl-st"><div class="pl-st-n" style="color:var(--cyan)">${passRate.toFixed(1)}%</div><div class="pl-st-l">Pass rate</div></div>`;
    h += `<div class="pl-st"><div class="pl-st-n">${activeCount}<span style="font-size:13px;color:var(--t3)"> / ${pipeline.length}</span></div><div class="pl-st-l">Active filters</div></div>`;
    return h;
  }

  // In-place stats-row refresh. Safe to call while an editor panel is open:
  // it only touches #pipelineStats and leaves the rest of the DOM (including
  // any active slider/input) untouched.
  function _refreshStatsRow() {
    const el = $('pipelineStats');
    if (!el) return;
    const bot = _getSelectedBot();
    if (!bot) return;
    el.innerHTML = _buildStatsRowHTML(bot.pipeline || []);
  }

  function _renderPipelineDashboard() {
    const container = $('pipelineDashboard');
    if (!container) return;
    const bot = _getSelectedBot();
    if (!bot) {
      container.innerHTML = '<div class="td-dim" style="padding:20px">No bots found</div>';
      return;
    }

    const pipeline = bot.pipeline || [];
    const totalChecked = (S.rejectStats && S.rejectStats.total_checked) || 0;
    const totalRejected = (S.rejectStats && S.rejectStats.total_rejected) || 0;
    const totalAccepted = (S.rejectStats && S.rejectStats.total_accepted) || Math.max(0, totalChecked - totalRejected);
    const passRate = totalChecked > 0 ? (totalAccepted / totalChecked * 100) : 0;
    const activeCount = pipeline.filter(e => (e.reject_count || 0) > 0).length;
    const maxPct = Math.max(...pipeline.map(e => totalChecked > 0 ? (e.reject_count || 0) / totalChecked * 100 : 0), 1);

    // Keys managed only in Settings tab (not pipeline filters) — skip from pipeline viz
    const _SETTINGS_KEYS = new Set([
      'DRAWDOWN_REDUCE_AT',
      'MAX_BET_PERCENT', 'MAX_EXPOSURE_PCT', 'ORDER_TIMEOUT_S',
      'EXIT_TAKE_PROFIT', 'EXIT_STOP_LOSS', 'EXIT_STOP_LOSS_EMERGENCY',
      'EXIT_CEILING_TP_PRICE', 'EXIT_TRAIL_ACTIVATE', 'EXIT_TRAIL_STOP',
      'EXIT_TIME_BEFORE_RESOLUTION_H', 'MIN_STOP_LOSS_AGE_S',
    ]);

    // Group pipeline (skip settings-managed nodes)
    const groups = {};
    const groupOrder = [];
    pipeline.forEach(entry => {
      if (_SETTINGS_KEYS.has(entry.key)) return;  // managed in Settings tab
      const grp = entry.group || 'Other';
      if (!groups[grp]) { groups[grp] = []; groupOrder.push(grp); }
      groups[grp].push(entry);
    });

    // Mode badge
    const mode = _getFilterMode();
    const modeBadge = mode === 'live'
      ? '<span class="b b-live" style="font-size:10px">LIVE</span>'
      : '<span class="b b-dry" style="font-size:10px">DRY RUN</span>';

    // Bot selector
    const botOptions = S.filters.map(b =>
      `<option value="${esc(b.name)}"${b.name === bot.name ? ' selected' : ''}>${esc(b.emoji || '')} ${esc(b.name)}</option>`
    ).join('');
    const hasBots = S.filters.length > 1;
    const botSelHtml = hasBots ? `<select class="f-sel" id="filterBotSel" onchange="renderFilters(true)">${botOptions}</select>` : '';

    // Pending count
    const pendingN = Object.keys(S.filterEdits).length;
    const saveStyle = pendingN ? '' : ' style="display:none"';
    const saveLbl = pendingN ? `Save (${pendingN})` : 'Save';

    let h = '';
    // Header
    h += `<div class="pl-hdr"><div class="pl-hdr-l">${botSelHtml}<span class="pl-hdr-t">Filter pipeline</span>${modeBadge}</div>`;
    h += `<div class="pl-hdr-r"><button class="hdr-btn" onclick="_resetPipelineImpact()">Reset stats</button>`;
    h += `<button class="hdr-btn" id="filterSaveBtn"${saveStyle} onclick="_saveFilterConfig(true)">${saveLbl}</button></div></div>`;

    // Stats row (id enables live refresh even when full re-render is skipped
    // due to an open editor panel — see _refreshStatsRow below).
    h += `<div class="pl-stats" id="pipelineStats">${_buildStatsRowHTML(pipeline)}</div>`;

    // ── Sub-tabs (Funnel | Latency | Live Feed) ──
    const _activeSubTab = S._plSubTab || 'funnel';
    h += `<div class="pl-subtabs">`;
    h += `<span class="pl-subtab${_activeSubTab === 'funnel' ? ' active' : ''}" onclick="_plSwitchTab('funnel')">Funnel</span>`;
    h += `<span class="pl-subtab${_activeSubTab === 'latency' ? ' active' : ''}" onclick="_plSwitchTab('latency')">Latency</span>`;
    h += `<span class="pl-subtab${_activeSubTab === 'feed' ? ' active' : ''}" onclick="_plSwitchTab('feed')">Live Feed</span>`;
    h += `</div>`;

    // ══ TAB: Funnel ══
    h += `<div class="pl-tab-panel" id="plTabFunnel" style="display:${_activeSubTab === 'funnel' ? 'block' : 'none'}">`;

    // ── Per-Phase Funnel ──
    const rejectStats = S.rejectStats || {};

    h += `<div class="pipeline-funnel">`;
    h += `<div style="font-size:0.72rem;color:var(--t3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;width:100%">Signal Funnel · ${(rejectStats.window_hours || 24).toFixed(0)}h</div>`;
    h += `<div style="display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:0">`;
    h += `<div class="funnel-step start"><div class="funnel-count">${totalChecked.toLocaleString()}</div><div class="funnel-label">${App.t('filters.funnel_signals')}</div></div>`;

    let funnelIn = totalChecked;
    const phaseColors = {'⓪ Hard Safety':'var(--red)', '① Conviction':'var(--pur)', '② Wallet Quality':'var(--cyan)', '③ Market Quality':'var(--cyan)', '④ Price Quality':'var(--red)', '⑤ Risk & Exposure':'var(--amb)', '🔧 Signal Context':'var(--pur)', '⑥ Order Execution':'var(--t2)'};
    // Summarize some phases for the funnel to avoid too many steps
    const funnelPhases = [
      {label: 'Hard Safety', groups: ['⓪ Hard Safety']},
      {label: 'Conviction', groups: ['① Conviction']},
      {label: 'Quality', groups: ['② Wallet Quality','③ Market Quality','④ Price Quality','⑤ Risk & Exposure']},
      {label: 'Execution', groups: ['⑥ Order Execution']},
    ];
    funnelPhases.forEach(fp => {
      const fpRejects = fp.groups.reduce((sum, gn) => sum + (groups[gn] || []).reduce((s, e) => s + (e.reject_count || 0), 0), 0);
      const fpOut = Math.max(0, funnelIn - fpRejects);
      const fpPct = funnelIn > 0 ? Math.round(fpOut / funnelIn * 100) : 0;
      const color = phaseColors[fp.groups[0]] || 'var(--t2)';
      h += `<div class="funnel-arrow">→</div>`;
      h += `<div class="funnel-step"><div class="funnel-count" style="color:${color}">${fpOut.toLocaleString()}</div><div class="funnel-label">${fp.label}</div><div class="funnel-pct">${fpPct}%</div></div>`;
      funnelIn = fpOut;
    });

    h += `<div class="funnel-arrow">→</div>`;
    h += `<div class="funnel-step pass"><div class="funnel-count">${funnelIn.toLocaleString()}</div><div class="funnel-label">Passed</div>`;
    h += `<div class="funnel-pct">${totalAccepted} entered</div>`;
    h += `</div>`;
    h += `</div></div>`;

    // ── Phase Bars ──
    let phaseIn = totalChecked;
    groupOrder.forEach((grpName, gi) => {
      const entries = groups[grpName];
      const grpRejects = entries.reduce((s, e) => s + (e.reject_count || 0), 0);
      const phaseOut = Math.max(0, phaseIn - grpRejects);
      const isHardSafety = grpName.includes('Hard Safety');
      const isConvGate = grpName.includes('Conviction');

      // Phase number extraction for badge class
      const phaseNum = grpName.charAt(0); // ⓪①②③④⑤⑥⑦⑧⑨🔀
      const badgeClasses = {'⓪':'hs','①':'pf','②':'cg','③':'wq','④':'mv','⑤':'re','⑥':'pq','⑨':'oe'};
      const badgeCls = badgeClasses[phaseNum] || 'pf';

      // Optional special badges
      let specialBadge = '';
      if (isHardSafety) specialBadge = '<span class="phase-badge">' + App.t('filters.hard_safety_badge') + '</span>';
      else if (isConvGate) specialBadge = '<span class="phase-badge" style="color:var(--pur);background:rgba(167,139,250,0.1)">INTENT-AWARE</span>';

      // Flow indicator
      const flowHtml = totalChecked > 0 ? `<div class="phase-flow">
        <span class="in">${phaseIn.toLocaleString()}</span>
        <span class="arrow">→</span>
        <span class="out">${phaseOut.toLocaleString()}</span>
        <span class="rejected">(−${grpRejects.toLocaleString()}, ${phaseIn > 0 ? (grpRejects / phaseIn * 100).toFixed(1) : 0}%)</span>
      </div>` : '';

      // Collapsed by default, expanded if user clicked (tracked by _plOpenPhases)
      const isExpanded = _plOpenPhases.has(grpName);
      const toggleChar = isExpanded ? '▾' : '▸';

      h += `<div class="phase-bar${isConvGate ? ' phase-bar-accent' : ''}">`;
      h += `<div class="phase-header" onclick="_plTogglePhase('${esc(grpName)}')">`;
      h += `<span class="phase-num ${badgeCls}">${phaseNum}</span>`;
      h += `<span class="phase-title">${esc(grpName.replace(/^[⓪①②③④⑤⑥⑦⑧⑨🔀]\s*/, ''))}</span>`;
      h += specialBadge;
      h += flowHtml;
      h += `<span class="phase-toggle">${toggleChar}</span>`;
      h += `</div>`;

      if (isExpanded) {
        h += `<div class="phase-body">`;
        h += `<div class="filter-grid">`;

        entries.forEach(entry => {
          const cfgKey = entry.env_key || entry.key;
          const rc = entry.reject_count || 0;
          const pct = totalChecked > 0 ? rc / totalChecked * 100 : 0;
          const val = _getFilterDisplayVal(entry);
          const displayVal = _fmtFilterVal(entry, val);
          const nodeId = entry.key.replace(/[^a-zA-Z0-9_]/g, '');

          // Heat class for left border
          let heatCls = 'cold';
          if (pct >= 15) heatCls = 'hot';
          else if (pct >= 2) heatCls = 'warm';

          const eBadge = (entry.elasticity > 0) ? `<span class="pl-badge" style="background:var(--pur);font-size:0.7rem;padding:1px 4px;border-radius:3px;margin-left:4px" title="Elasticity: threshold softened for convergence signals">e:${entry.elasticity}</span>` : '';

          h += `<div class="filter-card ${heatCls}" data-pl-id="${nodeId}" onclick="_plToggle('${nodeId}')">`;
          h += `<div class="fc-left"><div class="fc-name">${esc(entry.label)}${eBadge}</div><div class="fc-value">${esc(displayVal)}</div></div>`;
          h += `<div class="fc-right">`;
          h += `<span class="fc-count"${rc > 0 ? ` style="color:${pct >= 15 ? 'var(--red)' : pct >= 2 ? 'var(--amb)' : 'var(--t3)'}"` : ''}>${rc.toLocaleString()}</span>`;
          if (pct > 0) h += `<span class="fc-pct">${pct.toFixed(1)}%</span>`;
          if (entry.editable) h += `<span class="fc-edit">edit</span>`;
          h += `</div></div>`;

          // Editor panel
          if (entry.editable) {
            h += `<div class="pl-ed" id="pl-ed-${nodeId}">`;
            if (entry.type === 'conviction_gate' && entry.sub_keys) {
              // Multi-threshold conviction gate — editable number input per intent level
              h += '<div class="pl-ed-lb">Conviction thresholds by intent level</div>';
              const subVals = (typeof val === 'object' && val) || {};
              for (const [skName, skDef] of Object.entries(entry.sub_keys)) {
                const skKey = skDef.key;
                const skVal = subVals[skName] != null ? subVals[skName] : skDef.default;
                const skId = skKey.replace(/[^a-zA-Z0-9_]/g, '');
                const unitHint = skDef.unit ? ` <span style="font-size:11px;color:var(--t3)">${esc(skDef.unit)}</span>` : '';
                const rangeHint = `<span style="font-size:10px;color:var(--t3)">[${_fmtVal(skDef.min)}–${_fmtVal(skDef.max)}]</span>`;
                h += `<div class="pl-ed-ct" style="margin-bottom:8px;display:flex;align-items:center;gap:8px">`;
                h += `<span style="min-width:90px;font-size:12px;color:var(--t2)">${esc(skDef.label)}</span>`;
                h += `<input type="number" class="pl-ed-subnum" data-filter-key="${esc(skKey)}" min="${skDef.min}" max="${skDef.max}" step="${skDef.step || 0.01}" value="${skVal}" style="width:110px;padding:3px 8px;background:var(--bg3);border:1px solid var(--brd);border-radius:4px;color:var(--t1);font-size:13px;font-variant-numeric:tabular-nums">`;
                h += unitHint + rangeHint;
                h += `<span class="pl-ed-o" id="pl-o-${skId}" style="display:none">${_fmtVal(skVal)}</span>`;
                h += `</div>`;
              }
              // CONVICTION level is always 0, show as info
              h += `<div class="pl-ed-ct" style="margin-bottom:8px">`;
              h += `<span style="min-width:70px;font-size:12px;color:var(--t2)">CONV</span>`;
              h += `<span style="font-size:12px;color:var(--t3)">always ≥ 0 (pass all — whale proved commitment)</span>`;
              h += `</div>`;
              // Dynamic min trade size calculator
              h += `<div id="convGateCalc" style="margin-top:10px;padding:10px;background:rgba(255,255,255,.03);border-radius:6px;font-size:11px;color:var(--t2)"></div>`;
            } else if (entry.type === 'multiselect' && entry.options) {
              // Category checkboxes
              const currentVal = (val != null && val !== '') ? String(val) : '';
              const selected = currentVal ? currentVal.split(',').map(s => s.trim().toLowerCase()) : [];
              const allAllowed = selected.length === 0;
              h += '<div class="pl-ed-lb">Select categories</div>';
              h += '<div class="pl-ed-checks">';
              entry.options.forEach(opt => {
                const optVal = typeof opt === 'object' ? opt.value : opt;
                const optLabel = typeof opt === 'object' ? (opt.emoji || '') + ' ' + opt.label : opt;
                const checked = allAllowed || selected.includes(optVal);
                h += `<label class="pl-ed-check-lbl"><input type="checkbox" class="pl-ed-check" data-filter-key="${esc(cfgKey)}" data-cat-val="${esc(optVal)}"${checked ? ' checked' : ''}> ${esc(optLabel)}</label>`;
              });
              h += '</div>';
            } else if (entry.type === 'bool') {
              // Toggle
              const isOn = val === true || val === 'true' || val === 1;
              h += '<div class="pl-ed-lb">Toggle</div>';
              h += `<div class="pl-ed-ct"><label class="pl-ed-check-lbl" style="font-size:14px;gap:8px"><input type="checkbox" class="pl-ed-toggle" data-filter-key="${esc(cfgKey)}" style="width:16px;height:16px;accent-color:var(--ind)"${isOn ? ' checked' : ''}> ${isOn ? 'Enabled' : 'Disabled'}</label></div>`;
            } else if ((entry.unit || '') === '%') {
              // Percentage → slider
              const sliderVal = val != null ? val : (entry.default || 0);
              h += '<div class="pl-ed-lb">Adjust value</div>';
              h += `<div class="pl-ed-ct"><input type="range" class="pl-ed-sl" data-filter-key="${esc(cfgKey)}" min="${entry.min}" max="${entry.max}" step="${entry.step || 0.01}" value="${sliderVal}">`;
              h += `<span class="pl-ed-o" id="pl-o-${nodeId}">${esc(displayVal)}</span></div>`;
            } else {
              // Non-percentage numeric → number input
              const numVal = val != null ? val : (entry.default || 0);
              const unitLabel = entry.unit ? ` ${esc(entry.unit)}` : '';
              h += '<div class="pl-ed-lb">Enter value</div>';
              h += `<div class="pl-ed-ct"><input type="number" class="pl-ed-num" data-filter-key="${esc(cfgKey)}" min="${entry.min}" max="${entry.max}" step="${entry.step || 0.01}" value="${numVal}">`;
              h += `<span class="pl-ed-o" id="pl-o-${nodeId}">${unitLabel}</span></div>`;
            }
            if (entry.tooltip) h += `<div class="pl-ed-d">${esc(entry.tooltip)}</div>`;
            else if (entry.description) h += `<div class="pl-ed-d">${esc(entry.description)}</div>`;
            // Elasticity slider — shown when filter supports threshold softening
            if (entry.elasticity_editable) {
              const eKey = entry.key + '_elasticity';
              const curE = S.filterEdits[eKey] ?? entry.elasticity ?? 0;
              h += `<div style="margin-top:6px"><label style="font-size:0.78rem;color:var(--t2)">Elasticity: <b>${curE}</b></label>`;
              h += `<input type="range" min="0" max="1" step="0.05" value="${curE}" style="width:100%" `;
              h += `oninput="App.state.filterEdits['${eKey}']=parseFloat(this.value);this.previousElementSibling.querySelector('b').textContent=this.value;_updatePendingCount()">`;
              h += `</div>`;
            }
            h += `<div class="pl-ed-a"><button class="hdr-btn" style="color:var(--grn);border-color:var(--grn)" onclick="event.stopPropagation();_saveFilterConfig(false)">Save</button>`;
            h += `<button class="hdr-btn" style="color:var(--amb);border-color:var(--amb)" onclick="event.stopPropagation();_saveFilterConfig(true)">Save & Restart</button>`;
            h += `<button class="hdr-btn" onclick="event.stopPropagation();_plToggle('${nodeId}')">Close</button></div>`;
            h += '</div>';
          } else {
            // Info-only expand
            const infoTip = entry.tooltip || entry.description || '';
            if (infoTip) {
              h += `<div class="pl-ed" id="pl-ed-${nodeId}"><div class="pl-ed-d" style="margin:0">${esc(infoTip)}</div></div>`;
            }
          }
        });

        h += `</div>`; // close filter-grid
        h += `</div>`; // close phase-body
      }

      h += `</div>`; // close phase-bar

      phaseIn = phaseOut;
    });

    // Pass output
    h += `<div class="pl-pass-box">`;
    h += `<div class="pl-pass-icon">✓</div>`;
    h += `<div class="pl-pass-info">`;
    h += `<div class="pl-pass-total">${App.t('filters.funnel_entered_trades', {n: totalAccepted.toLocaleString()})}</div>`;
    h += `</div></div>`;

    // Legend
    h += '<div class="pl-legend">';
    h += '<span><span class="pl-legend-dt" style="background:var(--red)"></span>Bottleneck (&gt;15%)</span>';
    h += '<span><span class="pl-legend-dt" style="background:var(--amb)"></span>Active (2\u201315%)</span>';
    h += '<span><span class="pl-legend-dt" style="background:var(--t3)"></span>Light (&lt;2%)</span>';
    h += '<span><span class="pl-legend-dt" style="background:rgba(255,255,255,.06)"></span>Quiet</span>';
    h += '</div>';

    h += `</div>`; // ══ END TAB: Funnel ══

    // ══ TAB: Latency ══
    h += `<div class="pl-tab-panel" id="plTabLatency" style="display:${_activeSubTab === 'latency' ? 'block' : 'none'}">`;
    h += `<div style="font-size:0.8rem;font-weight:600;color:var(--t2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Phase Latency · Median (p95)</div>`;
    h += `<div style="background:var(--bg2);border:1px solid var(--brd);border-radius:var(--r);padding:12px;">`;
    h += `<div id="latencyTabContent"><div style="color:var(--t3);font-size:0.8rem;text-align:center;padding:12px">${App.t('filters.loading')}</div></div>`;
    h += `</div>`;
    h += `</div>`; // ══ END TAB: Latency ══

    // ══ TAB: Live Feed ══
    h += `<div class="pl-tab-panel" id="plTabFeed" style="display:${_activeSubTab === 'feed' ? 'block' : 'none'}">`;
    h += `<div class="pipeline-reject-feed">
      <div class="feed-header" style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--brd);">
        <span style="font-weight:600;font-size:0.9rem;">${App.t('filters.recent_rejects')}</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:0.72rem;color:var(--t3)">auto-refresh 5s</span>
          <select id="rejectPhaseFilter" style="background:var(--bg3);color:var(--t1);border:1px solid var(--brd);border-radius:4px;padding:2px 8px;font-size:0.75rem;">
            <option value="">${App.t('filters.all_phases')}</option>
          </select>
        </div>
      </div>
      <div class="live-feed" id="rejectFeedBody"></div>
    </div>`;
    h += `</div>`; // ══ END TAB: Live Feed ══

    container.innerHTML = h;

    // Helper: find filter entry by key in pipeline
    function _findEntry(key) {
      return pipeline.find(e => e.key === key || e.env_key === key);
    }
    function _nodeIdForEntry(entry) {
      return entry.key.replace(/[^a-zA-Z0-9_]/g, '');
    }

    // Wire conviction-gate sub-key number inputs
    container.querySelectorAll('.pl-ed-subnum[data-filter-key]').forEach(input => {
      const key = input.getAttribute('data-filter-key');
      const skId = key.replace(/[^a-zA-Z0-9_]/g, '');
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (isNaN(v)) return;
        const outEl = $('pl-o-' + skId);
        if (outEl) outEl.textContent = _fmtVal(v);
        S.filterEdits[key] = v;
        _updatePendingCount();
        _updateConvGateCalc();
      });
    });

    // Wire slider inputs (percentage filters + conviction gate sub-sliders)
    container.querySelectorAll('.pl-ed-sl[data-filter-key]').forEach(slider => {
      const key = slider.getAttribute('data-filter-key');
      const entry = _findEntry(key);
      if (entry) {
        // Determine correct output ID: use the closest editor panel's id to
        // distinguish pipeline sliders (pl-ed-FILTER_X) from convergence (pl-ed-cv-*)
        const edPanel = slider.closest('.pl-ed');
        const panelId = edPanel ? edPanel.id.replace('pl-ed-', '') : _nodeIdForEntry(entry);
        slider.addEventListener('input', () => _plSliderUpdate(slider, panelId, entry));
      } else {
        // Sub-key slider (e.g. conviction_gate_probe) — store directly by sub-key
        const skId = key.replace(/[^a-zA-Z0-9_]/g, '');
        slider.addEventListener('input', () => {
          const v = parseFloat(slider.value);
          const outEl = $('pl-o-' + skId);
          if (outEl) outEl.textContent = _fmtVal(v);
          S.filterEdits[key] = v;
          _updatePendingCount();
          _updateConvGateCalc();
        });
      }
    });

    // Wire number inputs (non-percentage numeric filters)
    container.querySelectorAll('.pl-ed-num[data-filter-key]').forEach(input => {
      const key = input.getAttribute('data-filter-key');
      const entry = _findEntry(key);
      if (entry) {
        const saveKey = entry.env_key || entry.key;
        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          if (!isNaN(v)) {
            S.filterEdits[saveKey] = v;
            _updatePendingCount();
          }
        });
      }
    });

    // Initial conviction gate calculator update
    _updateConvGateCalc();

    // ── Load timing and reject feed data ──
    async function _loadPhaseTiming() {
      try {
        const resp = await fetch('/api/polymarket/timing/summary');
        const data = await resp.json();
        const el = document.getElementById('latencyTabContent');
        if (!el || !data.phases) {
          if (el) el.innerHTML = '<div style="color:var(--t3);font-size:0.8rem;text-align:center;padding:12px">' + App.t('filters.no_data') + '</div>';
          return;
        }

        // Phase label → color mapping for latency view
        const _lColors = {
          '⓪ Hard Safety': 'var(--red)', '① Conviction': 'var(--pur)',
          '② Wallet Quality': 'var(--cyan)', '③ Market Quality': 'var(--cyan)',
          '④ Price Quality': 'var(--red)', '⑤ Risk & Exposure': 'var(--amb)',
          '⑥ Price Quality': 'var(--red)', '⑨ Order Execution': 'var(--t2)'
        };

        const maxMs = Math.max(200, ...Object.values(data.phases).map(s => s.p95 || 0));
        let lh = '';
        for (const [phase, stats] of Object.entries(data.phases)) {
          const pct = Math.min(100, (stats.p50 / maxMs) * 100);
          const barColor = stats.p50 < 5 ? 'var(--grn)' : stats.p50 < 50 ? 'var(--amb)' : 'var(--red)';
          const labelColor = _lColors[phase] || 'var(--t2)';
          lh += `<div class="latency-row">
            <span class="latency-label" style="color:${labelColor}">${esc(phase)}</span>
            <div class="latency-bar-bg"><div class="latency-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
            <span class="latency-ms">${stats.p50.toFixed(1)}ms</span>
          </div>`;
        }

        // Totals
        if (data.totals) {
          lh += `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--brd);display:flex;gap:24px;font-size:0.78rem;color:var(--t2)">`;
          lh += `<span>Total p50: <strong style="color:var(--t1)">${data.totals.p50 ? data.totals.p50.toFixed(1) + 'ms' : '—'}</strong></span>`;
          lh += `<span>Total p95: <strong style="color:var(--t1)">${data.totals.p95 ? data.totals.p95.toFixed(1) + 'ms' : '—'}</strong></span>`;
          lh += `</div>`;
        }
        el.innerHTML = lh;
      } catch (e) { console.warn('Timing summary load failed:', e); }
    }

    async function _loadRejectFeed(phase) {
      try {
        const params = new URLSearchParams({limit: '50'});
        if (phase) params.set('phase', phase);
        const resp = await fetch('/api/polymarket/rejects/recent?' + params);
        const data = await resp.json();
        const body = document.getElementById('rejectFeedBody');
        if (!body || !Array.isArray(data)) return;

        if (!data.length) {
          body.innerHTML = '<div style="padding:12px;color:var(--text-muted);text-align:center;font-size:0.8rem;">' + App.t('filters.no_rejects') + '</div>';
          return;
        }

        // Phase → color mapping for badges
        const _phaseColors = {
          'Hard Safety':       {bg: 'rgba(239,68,68,0.15)',  color: 'var(--red)'},
          'Conviction':        {bg: 'rgba(167,139,250,0.15)', color: 'var(--pur)'},
          'Wallet Quality':    {bg: 'rgba(34,211,238,0.15)',  color: 'var(--cyan)'},
          'Market Quality':    {bg: 'rgba(34,211,238,0.15)',  color: 'var(--cyan)'},
          'Price Quality':     {bg: 'rgba(239,68,68,0.15)',  color: 'var(--red)'},
          'Risk & Exposure':   {bg: 'rgba(245,158,11,0.15)', color: 'var(--amb)'},
          'Signal Context':    {bg: 'rgba(167,139,250,0.15)', color: 'var(--pur)'},
          'Order Execution':   {bg: 'rgba(148,163,184,0.15)', color: 'var(--t2)'},
        };
        function _phaseBadgeStyle(phase) {
          // Match by partial phase name (e.g. "⓪ Hard Safety" → "Hard Safety")
          for (const [key, style] of Object.entries(_phaseColors)) {
            if (phase && phase.includes(key)) return style;
          }
          return {bg: 'var(--bg3)', color: 'var(--t3)'};
        }

        body.innerHTML = data.map(r => {
          const time = r.ts ? new Date(r.ts * 1000).toLocaleTimeString('uk-UA', {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';
          const market = (r.market || '—').slice(0, 40);
          const phase = r.phase || '—';
          const ps = _phaseBadgeStyle(phase);
          const phaseShort = phase.replace(/^[⓪①②③④⑤⑥⑦⑧⑨🔀]\s*/, '');
          return `<div class="feed-row">
            <span class="feed-time">${time}</span>
            <span class="feed-phase" style="background:${ps.bg};color:${ps.color};border:1px solid ${ps.color}33">${phaseShort}</span>
            <span class="feed-market" title="${r.market || ''}">${market}</span>
            <span class="feed-reason">${r.reason || '—'}</span>
            ${r.latency_ms ? `<span class="feed-latency">${r.latency_ms}ms</span>` : ''}
          </div>`;
        }).join('');
      } catch (e) { console.warn('Reject feed load failed:', e); }
    }

    // Call new loading functions
    _loadPhaseTiming();
    _loadRejectFeed('');

    // Wire phase filter dropdown
    const filterEl = document.getElementById('rejectPhaseFilter');
    if (filterEl) {
      filterEl.addEventListener('change', () => _loadRejectFeed(filterEl.value));
    }

    // Wire category checkboxes
    container.querySelectorAll('.pl-ed-check[data-filter-key]').forEach(cb => {
      cb.addEventListener('change', () => {
        const key = cb.getAttribute('data-filter-key');
        const allChecks = [...container.querySelectorAll(`.pl-ed-check[data-filter-key="${key}"]`)];
        const allVals = allChecks.map(c => c.getAttribute('data-cat-val'));
        const checked = allChecks.filter(c => c.checked).map(c => c.getAttribute('data-cat-val'));
        S.filterEdits[key] = (checked.length === 0 || checked.length === allVals.length) ? '' : checked.join(',');
        _updatePendingCount();
      });
    });

    // Wire bool toggles
    container.querySelectorAll('.pl-ed-toggle[data-filter-key]').forEach(toggle => {
      toggle.addEventListener('change', () => {
        const key = toggle.getAttribute('data-filter-key');
        S.filterEdits[key] = toggle.checked;
        const lbl = toggle.closest('label');
        if (lbl) lbl.childNodes[lbl.childNodes.length - 1].textContent = toggle.checked ? ' Enabled' : ' Disabled';
        _updatePendingCount();
      });
    });
  }

  async function _resetPipelineImpact() {
    if (!confirm('Reset all pipeline rejection counters?')) return;
    try {
      await fetch('/api/polymarket/filters/reject_stats/reset', { method: 'POST' });
      // Clear cached data immediately so UI shows empty
      S.rejectStats = { counts: {}, total_checked: 0, total_accepted: 0, total_rejected: 0 };
      // Zero out reject_count in cached pipeline data
      if (S.filters.length) {
        S.filters.forEach(bot => {
          (bot.pipeline || []).forEach(e => { e.reject_count = 0; });
        });
      }
      _renderPipelineDashboard();
      // Reload after delay (trader detects reset on next flush)
      setTimeout(() => App.loadAll(), 2000);
    } catch (e) { /* ignore */ }
  }

  function _renderRecentRejections() {
    const card = $('recentRejectionsCard');
    if (!card) return;

    if (!S.recentRejections.length) {
      card.innerHTML = '<div class="td-dim" style="padding:16px">No recent rejections</div>';
      return;
    }

    const headerHtml = `
      <div class="twrap">
        <div style="display:grid;grid-template-columns:1fr 120px auto;gap:10px;padding:7px 12px;background:var(--bg3);border-bottom:1px solid var(--brd)">
          <span style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--t3)" data-tip="Polymarket question that was rejected by this filter">MARKET</span>
          <span style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--t3)" data-tip="Which filter rejected this market&#10;(normalized filter key name)">FILTER</span>
          <span style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--t3)" data-tip="Raw skip reason string as logged by the bot">REASON</span>
        </div>`;

    const rowsHtml = S.recentRejections.map(r => `
      <div class="rej-row">
        <span class="rej-mkt">${esc(r.market)}</span>
        <span class="rej-filter">${esc(r.filter)}</span>
        <span class="rej-reason">${esc(r.skip_reason)}</span>
      </div>`).join('');

    card.innerHTML = headerHtml + rowsHtml + '</div>';
  }

  function renderFilters(force) {
    // Skip full re-render while user is editing filters (open editor / pending changes)
    // but still refresh the live counter row in place so the "Rejected / Accepted /
    // Pass rate" cards don't appear frozen when an editor panel is expanded.
    if (!force && (Object.keys(S.filterEdits).length > 0 || _plOpenId)) {
      _refreshStatsRow();
      return;
    }
    // Capture selected bot name before re-render (select is recreated each time)
    const sel = $('filterBotSel');
    if (sel && sel.value) S.selectedBotName = sel.value;
    _renderPipelineDashboard();
  }

  // renderRiskSettings + _saveRiskSettings removed — merged into settings.js _saveAllSettings

  function _getFilterMode() {
    return (S.filters.length && S.filters[0].active_mode) || S.currentMode || 'dry_run';
  }

  async function _saveFilterConfig(thenRestart) {
    const mode = _getFilterMode();
    const modeLabel = mode === 'live' ? 'LIVE' : 'DRY';
    const n = Object.keys(S.filterEdits).length;
    if (n === 0) {
      App.toast(App.t('filters.no_changes'), 'warn', 2000);
      return;
    }
    if (thenRestart) {
      const changes = Object.entries(S.filterEdits)
        .map(([k, v]) => `  ${k}: ${S.filterSavedConfig[k] ?? '?'} → ${v}`)
        .join('\n');
      if (!confirm(App.t('filters.save_confirm', {n: n, mode: modeLabel, changes: changes}))) return;
    }
    try {
      const resp = await fetch('/api/polymarket/filters/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: S.filterEdits, mode }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      S.filterSavedConfig = data.config || {};
      S.filterEdits = {};
      _plOpenId = null;
      if (thenRestart) {
        App.toast(App.t('filters.save_ok', {mode: modeLabel}), 'ok', 3000);
        await fetch('/api/polymarket/bots/trader/restart', { method: 'POST' });
        setTimeout(() => App.loadAll(), 2500);
      } else {
        App.toast(App.t('filters.save_ok_no_restart', {mode: modeLabel}), 'ok', 3000);
      }
      const filtersData = await App.fetchJSON('/api/polymarket/filters');
      S.filters = filtersData;
      renderFilters(true);
    } catch (err) {
      App.toast(App.t('filters.save_err', {error: err.message}), 'err');
    }
  }

  async function _resetFilterConfig() {
    if (!confirm('Reset all filter overrides to code defaults?')) return;
    try {
      await fetch('/api/polymarket/filters/reset', { method: 'POST' });
      S.filterSavedConfig = {};
      S.filterEdits = {};
      const filtersData = await App.fetchJSON('/api/polymarket/filters');
      S.filters = filtersData;
      renderFilters();
    } catch (err) {
      App.toast(App.t('filters.reset_err', {error: err.message}), 'err');
    }
  }

  function _applyPreset(presetName) {
    if (!S.filters.length) return;
    const presets = S.filters[0].presets || {};
    const preset  = presets[presetName] || presets[presetName.toLowerCase()];
    if (!preset) return;
    // Clear stale edits so only preset values are pending
    S.filterEdits = {};
    S.filters.forEach(bot => {
      (bot.pipeline || []).forEach(entry => {
        if (!entry.editable) return;
        const ck = entry.env_key || entry.key;
        if (preset[ck] !== undefined) S.filterEdits[ck] = preset[ck];
      });
    });
    renderFilters();
    // Show pending count — user must explicitly click Apply
    const applyBtn = $('filterApplyBtn');
    if (applyBtn) {
      const n = Object.keys(S.filterEdits).length;
      applyBtn.textContent = n ? `⚠ Apply (${n})` : 'Apply';
      if (n) applyBtn.style.color = '#fbbf24';
    }
  }

  function _updatePresetSelector() {
    const sel = $('filterPresetSel');
    if (!sel || !S.filters.length) return;
    const presets = S.filters[0].presets || {};
    const current = sel.value;
    // Keep built-in options, add custom ones
    const builtIn = ['calibrated', 'test'];
    const custom = Object.keys(presets).filter(k => !builtIn.includes(k));
    // Remove old custom options
    [...sel.options].forEach(opt => {
      if (!builtIn.includes(opt.value)) sel.removeChild(opt);
    });
    // Add custom options
    custom.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = '📋 ' + name.charAt(0).toUpperCase() + name.slice(1);
      sel.appendChild(opt);
    });
    if (current && [...sel.options].some(o => o.value === current)) sel.value = current;
  }

  async function _savePreset() {
    const sel = $('filterPresetSel');
    const currentName = sel ? sel.value : '';
    const defaultName = currentName && currentName !== 'calibrated' ? currentName : 'test';
    const name = prompt('Preset name:', defaultName);
    if (!name || !name.trim()) return;
    if (name.trim().toLowerCase() === 'calibrated') {
      App.toast(App.t('filters.preset_builtin_err'), 'warn');
      return;
    }

    // Collect current filter values (pending edits + saved config + defaults)
    const values = {};
    if (S.filters.length) {
      (S.filters[0].pipeline || []).forEach(entry => {
        if (!entry.editable || entry.type === 'info' || entry.type === 'multiselect') return;
        const ck = entry.env_key || entry.key;
        const val = S.filterEdits[ck] !== undefined ? S.filterEdits[ck]
                  : S.filterSavedConfig[ck] !== undefined ? S.filterSavedConfig[ck]
                  : entry.current_value;
        if (val !== undefined && val !== null) values[ck] = val;
      });
    }

    try {
      const resp = await fetch('/api/polymarket/filters/presets/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim().toLowerCase(), values }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      // Reload filters to get updated presets
      const filtersData = await App.fetchJSON('/api/polymarket/filters');
      S.filters = filtersData;
      _updatePresetSelector();
      if (sel) sel.value = name.trim().toLowerCase();
      App.toast(App.t('filters.preset_save_ok', {name: name.trim()}), 'ok');
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
  }

  // ─── Diagnostic group toggles ───────────────────────────────────────────────
  const _DIAG_GROUP_LABELS = {
    group_wallet_quality: '② Wallet Quality (trust, SM score)',
    group_market_validation: '③ Market Quality (volume, time, categories)',
    group_risk_exposure: '⑤ Risk & Exposure (correlation, drawdown)',
    group_price_quality: '④ Price Quality (impact, slippage, edge, TP)',
    group_softening: '🔧 Elasticity Softening (convergence threshold relaxation)',
    bypass_conviction_gate: '⚡ Bypass conviction gate',
    bypass_filters: '⚡ Bypass ВСІ фільтри',
  };
  let _diagGroupState = {};

  async function _diagGroupsLoad() {
    try {
      const resp = await fetch('/api/polymarket/diagnostic/groups');
      const data = await resp.json();
      if (data.error) return;
      _diagGroupState = data;
      _diagGroupsRender();
    } catch (e) { /* silent */ }
  }

  function _diagGroupsRender() {
    const el = document.getElementById('plDiagToggles');
    if (!el) return;
    let h = '';
    for (const [key, label] of Object.entries(_DIAG_GROUP_LABELS)) {
      // bypass_* are inverted: true = bypassed (so toggle should show as "off" = filters running)
      const isBypass = key.startsWith('bypass_');
      const raw = _diagGroupState[key];
      const isOn = isBypass ? !!raw : (raw !== false);  // group_* default true
      const cls = isBypass
        ? (isOn ? 'background:var(--red);color:#fff' : 'background:var(--bg3);color:var(--t2)')
        : (isOn ? 'background:var(--grn-bg);color:var(--grn);border:1px solid var(--grn)' : 'background:var(--red-bg);color:var(--red);border:1px solid var(--red)');
      const statusLabel = isBypass ? (isOn ? 'ON (bypass)' : 'OFF') : (isOn ? 'ON' : 'OFF');
      h += `<button style="padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer;border:none;${cls}" `;
      h += `onclick="_diagGroupToggle('${key}')">${label}: <b>${statusLabel}</b></button>`;
    }
    el.innerHTML = h;
  }

  async function _diagGroupToggle(key) {
    const isBypass = key.startsWith('bypass_');
    const current = _diagGroupState[key];
    const newVal = isBypass ? !current : (current === false ? true : false);
    _diagGroupState[key] = newVal;
    _diagGroupsRender();
    try {
      const resp = await fetch('/api/polymarket/diagnostic/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: newVal }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      const label = _DIAG_GROUP_LABELS[key] || key;
      App.toast(`${label}: ${newVal ? 'ON' : 'OFF'}`, 'ok', 2000);
    } catch (e) {
      App.toast(App.t('filters.err_toast', {error: e.message}), 'err');
    }
  }

  async function _diagGroupsToggleAll(enable) {
    const body = {};
    for (const key of Object.keys(_DIAG_GROUP_LABELS)) {
      if (key.startsWith('bypass_')) {
        body[key] = !enable;  // bypass_* inverted: enable=true → bypass=false
      } else {
        body[key] = enable;
      }
    }
    _diagGroupState = { ...body };
    _diagGroupsRender();
    try {
      const resp = await fetch('/api/polymarket/diagnostic/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      App.toast(enable ? App.t('filters.bulk_on') : App.t('filters.bulk_off'), 'ok', 2000);
    } catch (e) {
      App.toast(App.t('filters.err_toast', {error: e.message}), 'err');
    }
  }

  // Auto-load diagnostic groups when filters tab loads
  const _origRender = renderFilters;
  renderFilters = function(force) {
    _origRender(force);
    _diagGroupsLoad();
  };

  // ─── Public API ──────────────────────────────────────────────────────────────
  App.renderFilters = renderFilters;
  App._saveFilterConfig = _saveFilterConfig;
  App._applyPreset = _applyPreset;
  App._savePreset = _savePreset;
  App.getFilterMode = _getFilterMode;

  window._plToggle = _plToggle;
  window._plTogglePhase = _plTogglePhase;
  window._updatePendingCount = _updatePendingCount;
  window._plSwitchTab = _plSwitchTab;
  window._saveFilterConfig = _saveFilterConfig;
  window.renderFilters = renderFilters;
  window._resetPipelineImpact = _resetPipelineImpact;
  window._savePreset = _savePreset;
  window._diagGroupToggle = _diagGroupToggle;
  window._diagGroupsToggleAll = _diagGroupsToggleAll;

})(window.App);
