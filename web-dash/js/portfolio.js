/* Ora et Labora — portfolio rendering (L26 redesign) */

(function (App) {
  'use strict';

  const $ = App.$;
  const S = App.state;
  const fmt$ = App.fmt$;
  const esc = App.esc;

  // ── KPI state (loaded from /api/polymarket/kpi) ──
  S.kpiData = null;
  var _kpiTimer = null;

  // ── Render portfolio (balance + PnL + bots) ────────────────────────────
  App.renderPortfolio = function () {
    if (!S.portfolio) return;
    var data = S.portfolio;

    // Balance
    var portfolioEl = $('portfolioVal');
    var inPosEl = $('inPositions');
    var availEl = $('available');
    var meterEl = $('portfolioMeter');

    if (S.currentMode === 'live') {
      var walletTotal = S.usdcBalance || 0;
      var walletCash = S.usdcCash || 0;
      var inPositions = walletTotal - walletCash;
      if (portfolioEl) portfolioEl.textContent = fmt$(walletTotal);
      if (inPosEl) inPosEl.textContent = fmt$(inPositions);
      if (availEl) availEl.textContent = fmt$(walletCash);
      if (S.budgetData) {
        var budgetUsd = S.budgetData.budget_usd || 0;
        var avail = S.budgetData.available || 0;
        var pct = budgetUsd > 0 ? Math.min((avail / budgetUsd) * 100, 100) : 0;
        if (meterEl) meterEl.style.width = pct + '%';
      }
    } else {
      var inPos = data.totals ? data.totals.in_positions || 0 : 0;
      if (S.budgetData) {
        var budgetUsd2 = S.budgetData.budget_usd || 0;
        var remaining = S.budgetData.remaining_budget || 0;
        var avail2 = S.budgetData.available || 0;
        var pct2 = remaining > 0 ? Math.min((avail2 / remaining) * 100, 100) : 0;
        if (portfolioEl) {
          portfolioEl.innerHTML = fmt$(remaining) +
            ' <span style="font-size:12px;font-weight:400;color:var(--t3)">of ' + fmt$(budgetUsd2) + '</span>';
        }
        if (inPosEl) inPosEl.textContent = fmt$(inPos);
        if (availEl) availEl.textContent = fmt$(avail2);
        if (meterEl) meterEl.style.width = pct2 + '%';
      }
    }

    // PnL periods
    var pnl = data.pnl || {};
    _setPnlPeriod('pnlToday', pnl['1d'] || 0);
    _setPnlPeriod('pnlWeek', pnl['1w'] || 0);
    _setPnlPeriod('pnlAll', pnl['all'] || 0);

    // PnL headline — follows selected period
    _renderPnlHeadline(pnl);
    _syncPrdActive();

    // Reconciliation
    var recon = S.reconciliation;
    var reconEl = $('reconStatus');
    if (reconEl) {
      if (recon && !recon.ok) {
        var ph = recon.phantom_count || 0;
        var ut = recon.untracked_count || 0;
        reconEl.innerHTML = '<span class="b b-ghost" style="font-size:9px">' + ph + ' phantom</span> ' +
          '<span class="b b-untracked" style="font-size:9px">' + ut + ' untracked</span>';
        reconEl.style.display = '';
      } else {
        reconEl.style.display = 'none';
      }
    }

    // ── Render bots as compact pills ──────────────────────────────────
    var allocEl = $('botsAlloc');
    if (allocEl && Array.isArray(data.bots)) {
      allocEl.innerHTML = data.bots.map(function (bot) {
        var botType = bot.type || 'trader';
        var dotCls = bot.running ? 'on' : 'off';
        var label = bot.name || 'Bot';
        var pid = bot.pid || '—';
        return '<div class="bp" data-bot="' + esc(botType) + '">' +
          '<span class="bp-d ' + dotCls + '"></span>' +
          '<span class="bp-n">' + esc(label) + '</span>' +
          '<span class="bp-p">' + pid + '</span>' +
          '<span class="bp-a">' +
            '<button class="bp-b bp-start" title="Start"' + (bot.running ? ' disabled' : '') + '>▶</button>' +
            '<button class="bp-b bp-stop" title="Stop"' + (bot.running ? '' : ' disabled') + '>⏹</button>' +
            '<button class="bp-b bp-restart" title="Restart">↻</button>' +
          '</span>' +
        '</div>';
      }).join('');

      // Attach click handlers
      data.bots.forEach(function (bot) {
        var botType = bot.type || 'trader';
        var pill = allocEl.querySelector('[data-bot="' + botType + '"]');
        if (!pill) return;
        var startBtn = pill.querySelector('.bp-start');
        var stopBtn = pill.querySelector('.bp-stop');
        var restartBtn = pill.querySelector('.bp-restart');
        if (startBtn) startBtn.addEventListener('click', function () { App.botAction(botType, 'start'); });
        if (stopBtn) stopBtn.addEventListener('click', function () { App.botAction(botType, 'stop'); });
        if (restartBtn) restartBtn.addEventListener('click', function () { App.botAction(botType, 'restart'); });
      });
    }

    // ── System health pill ──────────────────────────────────────────
    var healthEl = $('systemHealth');
    if (healthEl && Array.isArray(data.bots)) {
      var allRunning = data.bots.every(function (b) { return b.running; });
      var someRunning = data.bots.some(function (b) { return b.running; });
      if (allRunning) {
        healthEl.className = 'sys-pill ok';
        healthEl.innerHTML = '<span class="sys-pill-dot"></span> ALL HEALTHY';
      } else if (someRunning) {
        healthEl.className = 'sys-pill warn';
        healthEl.innerHTML = '<span class="sys-pill-dot"></span> DEGRADED';
      } else {
        healthEl.className = 'sys-pill bad';
        healthEl.innerHTML = '<span class="sys-pill-dot"></span> DOWN';
      }
    }

    // ── KPI from trades summary (available immediately) ─────────────
    _renderTradeKPIs();
  };

  function _setPnlPeriod(id, val) {
    var el = $(id);
    if (!el) return;
    el.textContent = (val >= 0 ? '+' : '') + fmt$(val);
    el.className = 'ds-prd-v ' + (val >= 0 ? 'pos' : 'neg');
  }

  var _PRD_TO_KEY = { '1D': '1d', '1W': '1w', 'ALL': 'all' };

  function _renderPnlHeadline(pnl) {
    var pnlEl = $('pnlVal');
    if (!pnlEl) return;
    var key = _PRD_TO_KEY[S.period] || 'all';
    var val = pnl[key] || 0;
    pnlEl.textContent = (val >= 0 ? '+' : '') + fmt$(val);
    pnlEl.className = 'ds-num ' + (val >= 0 ? 'pos' : 'neg');
  }

  function _syncPrdActive() {
    document.querySelectorAll('.ds-prd[data-prd]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-prd') === S.period);
    });
  }

  // Click handler: switch period → re-render headline + chart
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('.ds-prd[data-prd]') : null;
    if (!el) return;
    var key = el.getAttribute('data-prd');
    if (!key || key === S.period) return;
    S.period = key;
    _syncPrdActive();
    if (S.portfolio) _renderPnlHeadline(S.portfolio.pnl || {});
    if (App.redrawChart) App.redrawChart();
  });

  // ── Trade-based KPIs (from /state summary — lightweight) ──────────
  function _renderTradeKPIs() {
    var positions = S.positions || [];
    var history = S.history || {};
    var summary = history.summary || {};
    var portfolio = S.portfolio || {};
    var totals = portfolio.totals || {};

    // Win Rate
    var wins = summary.wins || 0;
    var losses = summary.losses || 0;
    var closed = wins + losses;
    var wr = closed > 0 ? Math.round(wins / closed * 100) : 0;
    _setKpi('kpiWinRate', wr + '%', wr >= 50 ? 'green' : wr > 0 ? 'red' : '', wins + 'W ' + losses + 'L');

    // Avg PnL/Trade
    var netPnl = summary.net_pnl || 0;
    var avgPnl = closed > 0 ? netPnl / closed : 0;
    _setKpi('kpiAvgPnl', (avgPnl >= 0 ? '+' : '') + fmt$(avgPnl),
      avgPnl >= 0 ? 'green' : 'red', closed + ' closed trades');

    // Exposure
    var balance = totals.balance || 0;
    var inPos = totals.in_positions || 0;
    var expPct = balance > 0 ? Math.round(inPos / balance * 100) : 0;
    _setKpi('kpiExposure', expPct + '%', '', fmt$(inPos) + ' / ' + fmt$(balance));

    // Profit Factor, Drawdown, Duration — populated by loadKPIs from /api/polymarket/kpi
    // Only set placeholders here if KPI data hasn't loaded yet
    if (!S.kpiData) {
      _setKpi('kpiProfitFactor', '—', '', '');
      _setKpi('kpiDrawdown', '—', '', '');
      _setKpi('kpiDuration', '—', '', '');
    }

    // Open Positions (count from state)
    var openCount = positions.length;
    _setKpi('kpiOpenPos', openCount + '', '', openCount === 1 ? 'position' : 'positions');
  }

  function _setKpi(id, val, cls, sub) {
    var vEl = $(id);
    var sEl = $(id + 'Sub');
    if (vEl) {
      vEl.textContent = val;
      vEl.className = 'ds-kpi-v' + (cls ? ' ' + cls : '');
    }
    if (sEl && sub != null) sEl.textContent = sub;
  }

  // ── Calibrator-derived KPIs (from /api/polymarket/calibration/overview) ───
  async function _loadCalibratorKPIs() {
    try {
      var data = await App.fetchJSON('/api/polymarket/calibration/overview');
      if (!data) return;

      var kpi = data.kpi || {};
      var exitKpi = data.exit_kpi || {};
      // Exit targets from calibrator (single source of truth; fallbacks match
      // calibrator/exit_thermostat.py defaults if endpoint pre-dates targets field).
      var targets = data.exit_targets || {};
      var tT = targets.tp_hit_rate     || { min: 0.20, ideal: 0.35 };
      var sT = targets.sl_rate         || { max: 0.30 };
      var eT = targets.exit_efficiency || { min: 0.60, ideal: 0.75 };
      var lT = targets.left_on_table   || { max: 0.30 };

      // Top Rejection — human-readable reason from calibrator
      if (kpi.rejection_top) {
        _setKpi('kpiTopRej', kpi.rejection_top, 'amber', 'top blocker');
      } else {
        _setKpi('kpiTopRej', '—', '', '');
      }

      // CF Net (saved $ − lost $)
      if (typeof kpi.cf_net === 'number') {
        var cfn = kpi.cf_net;
        var cfLost = kpi.cf_lost || 0;
        var cfSaved = cfn + cfLost;
        var cls = cfn > 0 ? 'green' : cfn < 0 ? 'red' : '';
        var sign = cfn >= 0 ? '+' : '−';
        _setKpi('kpiCfNet', sign + '$' + Math.abs(cfn).toFixed(2), cls,
                '$' + cfSaved.toFixed(2) + ' saved');
      }

      // TP Hit Rate — ≥ideal green, ≥min amber, else red
      if (typeof exitKpi.tp_hit_rate === 'number') {
        var tp = exitKpi.tp_hit_rate;
        var tpCls = tp >= tT.ideal ? 'green' : tp >= tT.min ? 'amber' : 'red';
        _setKpi('kpiTpHit', (tp * 100).toFixed(1) + '%', tpCls,
                'target ≥' + Math.round(tT.ideal * 100) + '%');
      }

      // SL Rate — below (max-10pp) green, ≤max amber, else red
      if (typeof exitKpi.sl_rate === 'number') {
        var sl = exitKpi.sl_rate;
        var slSoft = sT.max - 0.10;
        var slCls = sl < slSoft ? 'green' : sl <= sT.max ? 'amber' : 'red';
        _setKpi('kpiSlRate', (sl * 100).toFixed(1) + '%', slCls,
                'target <' + Math.round(sT.max * 100) + '%');
      }

      // Exit Efficiency — ≥ideal green, ≥min amber, else red
      if (typeof exitKpi.exit_efficiency === 'number') {
        var ee = exitKpi.exit_efficiency;
        var eeCls = ee >= eT.ideal ? 'green' : ee >= eT.min ? 'amber' : 'red';
        _setKpi('kpiExitEff', (ee * 100).toFixed(1) + '%', eeCls, 'realized/peak');
      }

      // Left on Table — below (max-15pp) green, ≤max amber, else red
      if (typeof exitKpi.left_on_table === 'number') {
        var lot = exitKpi.left_on_table;
        var lotSoft = lT.max - 0.15;
        var lotCls = lot < lotSoft ? 'green' : lot <= lT.max ? 'amber' : 'red';
        _setKpi('kpiLeftOnTable', (lot * 100).toFixed(1) + '%', lotCls, 'unrealized upside');
      }
    } catch (e) {
      // Calibrator offline or endpoint missing — leave cells as '—'
    }
  }

  // ── Pipeline KPIs (from /api/polymarket/kpi — async) ──────────────
  App.loadKPIs = async function () {
    try {
      var mode = S.currentMode || 'dry_run';
      var data = await App.fetchJSON('/api/polymarket/kpi?mode=' + mode);
      if (!data) return;
      S.kpiData = data;

      // Pass Rate — combined regular + convergence
      if (data.total_checked != null) {
        var regAcc = data.total_accepted || 0;
        var regRej = data.total_rejected || 0;
        var regTotal = data.total_checked || 0;
        var convEnt = data.conv_entered || 0;
        var convBlk = data.conv_blocked || 0;
        var convTotal = data.conv_signals || 0;
        var combinedAcc = regAcc + convEnt;
        var combinedTotal = regTotal + convTotal;
        var pr = combinedTotal > 0 ? (combinedAcc / combinedTotal * 100) : 0;
        var prStr = pr < 1 ? pr.toFixed(1) + '%' : pr.toFixed(1) + '%';
        var sub = regAcc + ' pipe + ' + convEnt + ' conv / ' + combinedTotal;
        _setKpi('kpiPassRate', prStr, pr < 1 ? 'red' : pr > 10 ? 'amber' : 'green', sub);
      }

      // Signals/hr
      if (data.signals_per_hour != null) {
        var sph = data.signals_per_hour;
        _setKpi('kpiSignalsHr', sph < 1 ? sph.toFixed(1) : Math.round(sph) + '',
          '', '~' + Math.round(sph * 24) + '/day');
      }

      // Avg Latency
      if (data.avg_latency_ms != null) {
        var lat = data.avg_latency_ms;
        var latStr = lat >= 1000 ? (lat / 1000).toFixed(1) + 's' : Math.round(lat) + 'ms';
        _setKpi('kpiLatency', latStr, lat > 10000 ? 'red' : lat > 5000 ? 'amber' : 'green',
          data.latency_bottleneck || '');
      }

      // Profit Factor (from server — real computation)
      if (data.profit_factor != null) {
        var pf = data.profit_factor;
        var gw = data.gross_win || 0;
        var gl = data.gross_loss || 0;
        var pfStr = pf >= 99 ? '∞' : pf > 10 ? pf.toFixed(0) + 'x' : pf.toFixed(2);
        _setKpi('kpiProfitFactor', pfStr, pf >= 1.5 ? 'green' : pf >= 1.0 ? 'amber' : pf > 0 ? 'red' : '',
          '$' + gw.toFixed(2) + 'W / $' + gl.toFixed(2) + 'L');
      }

      // Max Drawdown (peak-to-trough from server)
      if (data.max_drawdown != null) {
        var dd = data.max_drawdown;
        _setKpi('kpiDrawdown', dd > 0 ? '-' + fmt$(dd) : '$0',
          dd > 0 ? 'red' : '', dd > 0 ? 'peak→trough' : 'no drawdown');
      }

      // Avg Duration (from server — includes open positions)
      if (data.avg_duration_s != null) {
        var dur = data.avg_duration_s;
        var durStr;
        if (dur > 86400) durStr = (dur / 86400).toFixed(1) + 'd';
        else if (dur > 3600) durStr = (dur / 3600).toFixed(1) + 'h';
        else if (dur > 60) durStr = Math.round(dur / 60) + 'm';
        else durStr = Math.round(dur) + 's';
        var openN = data.open_count || 0;
        var closedN = data.closed_count || 0;
        _setKpi('kpiDuration', durStr, '', closedN + ' closed · ' + openN + ' open');
      }
    } catch (e) {
      // silent
    }
  };

  // Auto-refresh KPIs every 30 seconds (heavier than /state)
  _kpiTimer = setInterval(function() {
    App.loadKPIs();
    _loadCalibratorKPIs();
  }, 30000);
  setTimeout(function() {
    App.loadKPIs();
    _loadCalibratorKPIs();
  }, 1500);

})(window.App);
