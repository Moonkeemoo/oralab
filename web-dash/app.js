/* Ora et Labora — dashboard frontend */

// ── Global tooltip ──────────────────────────────────────────────────────────
(function () {
  const tip = document.createElement('div');
  tip.className = 'g-tip';
  document.body.appendChild(tip);
  let _raf = null;

  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.classList.remove('vis'); return; }
    tip.textContent = el.getAttribute('data-tip');
    tip.classList.add('vis');
  });
  document.addEventListener('mouseout', e => {
    if (!e.target.closest('[data-tip]')) return;
    tip.classList.remove('vis');
  });
  document.addEventListener('mousemove', e => {
    if (!tip.classList.contains('vis')) return;
    if (_raf) cancelAnimationFrame(_raf);
    _raf = requestAnimationFrame(() => {
      let x = e.clientX + 14, y = e.clientY + 16;
      if (x + tip.offsetWidth  > window.innerWidth  - 8) x = e.clientX - tip.offsetWidth  - 10;
      if (y + tip.offsetHeight > window.innerHeight - 8) y = e.clientY - tip.offsetHeight - 10;
      tip.style.left = x + 'px';
      tip.style.top  = y + 'px';
    });
  });
})();

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ─── state ──────────────────────────────────────────────────────────────────
  let _period = 'ALL';
  let _activeTab = 'positions';
  let _portfolio = null;
  let _positions = [];
  let _history = null;
  let _filters = [];
  let _filterEdits = {};
  let _filterSavedConfig = {};
  let _rejectStats = null;
  let _convergenceStats = null;
  let _recentRejections = [];
  let _riskSettings = {};
  let _safetyDirty = false;
  let _selectedBotName = null;
  let _profiles = [];
  let _profilesMap = {};
  let _wallets = null;
  let _walletSortCol = 'trust';   // trust | sm | winrate | pnl | trades
  let _walletSortAsc = false;     // default descending
  let _intents = null;
  let _intentFilter = '';
  let _lbSort = 'conviction_rate';
  let _lbFilter = '';
  let _refreshTimer = null;
  let _serverOnline = true;
  let _currentMode = 'dry_run';
  let _budgetData = null;
  let _killActive = false;
  let _logLevel = '';
  let _logSource = '';
  let _logData = [];
  let _usdcBalance = 0;
  let _usdcCash = 0;

  // ─── classification data ─────────────────────────────────────────────────────
  const CLASS_EMOJI = {
    INFORMED: '🧠',
    MARKET_MAKER: '🏪',
    COPYCAT: '🐑',
    SNIPER: '🎯',
    ACCUMULATOR: '📈',
    NOISE: '💨',
  };

  // ─── utilities ───────────────────────────────────────────────────────────────
  function fmt$(n) {
    if (n == null) return '—';
    const abs = Math.abs(n);
    const s = abs >= 1_000_000 ? (abs / 1_000_000).toFixed(2) + 'M'
            : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? '-$' : '$') + s;
  }

  function fmtUpdatedAt(ts) {
    const d = new Date(ts * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function fmtAge(ts) {
    const secs = Date.now() / 1000 - ts;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function trustColor(score) {
    if (score >= 70) return 'var(--grn)';
    if (score >= 50) return 'var(--amb)';
    return 'var(--red)';
  }

  function strategyBadge(strategy) {
    const map = {
      'volume_spike':   ['b-strategy-vs',  'vol spike'],
      'arbitrage':      ['b-strategy-arb', 'arbitrage'],
      'mean_reversion': ['b-strategy-mr',  'mean rev'],
      'ws_signal':      ['b-strategy-ws',  'ws signal'],
    };
    const [cls, label] = map[strategy] || ['b-strategy-vs', strategy || '?'];
    return `<span class="b ${cls}">${esc(label)}</span>`;
  }

  function shortWallet(addr) {
    if (!addr) return '—';
    if (addr.length <= 12) return addr;
    return addr.slice(0, 6) + '…' + addr.slice(-4);
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtTs(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtExpiry(ts) {
    if (!ts) return '—';
    const now = Date.now() / 1000;
    const diff = ts - now;
    if (diff <= 0) return '<span style="color:var(--red)">expired</span>';
    const days = Math.floor(diff / 86400);
    const hours = Math.floor((diff % 86400) / 3600);
    return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
  }

  // ─── tab switching (reference sw() signature) ─────────────────────────────
  function sw(id, btn) {
    document.querySelectorAll('.pane').forEach(p => p.classList.remove('on'));
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('on'));
    document.getElementById('pane-' + id).classList.add('on');
    btn.classList.add('on');
    _activeTab = id;
    if (id === 'wallets') renderWallets();
    if (id === 'intent') renderIntent();
    if (id === 'leaderboard') renderLeaderboard();
    if (id === 'filters') { renderFilters(); renderRiskSettings(); renderSettingsSections(); }
    if (id === 'calibration') loadCalibrationData();
    if (id === 'decisions') renderDecisions();
    if (id === 'logs') App.renderLogs();
  }
  window.sw = sw;

  // ─── sparkline chart ─────────────────────────────────────────────────────────
  function buildPnlSeries(trades, periodHours) {
    const cutoff = periodHours ? Date.now() / 1000 - periodHours * 3600 : 0;
    const filtered = (trades || [])
      .filter(t => {
        const pnl = t.pnl ?? t.pnl_amount;
        const ts = t.close_ts ?? t.resolved_at ?? t.close_time ?? t.timestamp;
        return pnl != null && (!periodHours || ts > cutoff);
      })
      .sort((a, b) => {
        const ta = a.close_ts ?? a.resolved_at ?? a.close_time ?? a.timestamp ?? 0;
        const tb = b.close_ts ?? b.resolved_at ?? b.close_time ?? b.timestamp ?? 0;
        return ta - tb;
      });
    let cum = 0;
    const series = [0];
    filtered.forEach(t => { cum += t.pnl ?? t.pnl_amount ?? 0; series.push(cum); });
    return series;
  }

  function drawChart(data) {
    const canvas = $('pnlChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth || 300;
    const H = 100;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.scale(dpr, dpr);

    if (!data || data.length < 2) {
      ctx.clearRect(0, 0, W, H);
      return;
    }

    const last = data[data.length - 1];
    const isPos = last >= 0;
    const lineColor = isPos ? '#22c55e' : '#f43f5e';
    const fillColor = isPos ? 'rgba(34,197,94,0.1)' : 'rgba(244,63,94,0.08)';

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const pad = 4;

    const pts = data.map((v, i) => ({
      x: pad + i * (W - pad * 2) / (data.length - 1),
      y: pad + (1 - (v - min) / range) * (H - pad * 2),
    }));

    ctx.clearRect(0, 0, W, H);

    // fill
    ctx.beginPath();
    ctx.moveTo(pts[0].x, H);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, H);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    // line
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // last dot
    const lp = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(lp.x, lp.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();

    // update pnl value color
    const el = $('pnlVal');
    if (el) {
      el.className = 'scard-val ' + (isPos ? 'pos' : 'neg');
      el.textContent = (isPos ? '+' : '') + last.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    }
  }

  function setPrd(btn, key) {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _period = key;
    _redrawChart();
  }
  window.setPrd = setPrd;

  function _redrawChart() {
    const canvas = $('pnlChart');
    const pnlValEl = $('pnlVal');
    const trades = (_history && _history.trades) ? _history.trades : [];

    // Compute total unrealized PnL from open positions
    const unrealizedPnl = (_positions || []).reduce((sum, p) => sum + (p.unrealized_pnl || 0), 0);
    const hasData = trades.length > 0 || Math.abs(unrealizedPnl) > 0.001;

    if (!hasData) {
      if (pnlValEl) { pnlValEl.textContent = '—'; pnlValEl.className = 'scard-val'; }
      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const W = canvas.offsetWidth || 260;
        const H0 = 100;
        canvas.width = W * dpr; canvas.height = H0 * dpr;
        canvas.style.width = W + 'px'; canvas.style.height = H0 + 'px';
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = `${11 * dpr}px -apple-system, sans-serif`;
        ctx.fillStyle = 'rgba(148,163,184,0.35)';
        ctx.textAlign = 'center';
        ctx.fillText('No data yet', canvas.width / 2, canvas.height / 2 + 4 * dpr);
      }
      return;
    }

    const periodMap = { 'ALL': null, '1M': 720, '1W': 168, '1D': 24 };
    const hours = periodMap[_period] ?? null;
    const series = buildPnlSeries(trades, hours);

    // Append unrealized PnL from open positions as the current point
    if (Math.abs(unrealizedPnl) > 0.001) {
      const lastRealized = series[series.length - 1] ?? 0;
      series.push(lastRealized + unrealizedPnl);
    }

    // Update PnL value label
    if (pnlValEl) {
      const total = series[series.length - 1] ?? 0;
      pnlValEl.textContent = fmt$(total);
      pnlValEl.className = 'scard-val ' + (total >= 0 ? 'pos' : 'neg');
    }

    drawChart(series);
  }

  // ─── color prices ──────────────────────────────────────────────────────────
  function colorPrices() {
    document.querySelectorAll('.cur-price').forEach(el => {
      const entry   = parseFloat(el.dataset.entry);
      const current = parseFloat(el.dataset.current);
      if (isNaN(entry) || isNaN(current)) return;
      const diff = current - entry;
      const pct  = entry !== 0 ? (diff / entry * 100) : 0;
      const threshold = 0.001;
      if (diff > threshold) {
        el.className = 'price-up td-mono';
        el.title = `+${pct.toFixed(2)}% from entry`;
        el.innerHTML = `<span class="price-arrow">▲</span>${current.toFixed(3)}`;
      } else if (diff < -threshold) {
        el.className = 'price-down td-mono';
        el.title = `${pct.toFixed(2)}% from entry`;
        el.innerHTML = `<span class="price-arrow">▼</span>${current.toFixed(3)}`;
      } else {
        el.className = 'price-flat td-mono';
        el.title = 'No change';
        el.textContent = current.toFixed(3);
      }
    });
  }

  // ─── api fetching ─────────────────────────────────────────────────────────────
  async function fetchJSON(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function loadAll() {
    try {
      const modeParam = _currentMode ? '?mode=' + _currentMode : '';
      [_portfolio, _positions, _history, _filters] = await Promise.all([
        fetchJSON('/api/polymarket/portfolio' + modeParam),
        fetchJSON('/api/polymarket/positions' + modeParam),
        fetchJSON('/api/polymarket/history' + modeParam),
        fetchJSON('/api/polymarket/filters'),
      ]);

      fetchJSON(`/api/polymarket/filters/config?mode=${_currentMode}`).then(cfg => {
        _filterSavedConfig = cfg || {};
        if (_activeTab === 'filters') renderFilters();
      }).catch(() => {});

      fetchJSON('/api/polymarket/settings').then(rs => {
        _riskSettings = rs || {};
        if (_activeTab === 'filters') {
          renderRiskSettings();
          if (!_safetyDirty) renderSettingsLiveSafety();
          _loadExposure();
        }
      }).catch(() => {});

      fetchJSON('/api/polymarket/filters/reject_stats').then(rs => {
        _rejectStats = rs;
        if (_activeTab === 'filters') renderFilters();
      }).catch(() => {});

      fetchJSON('/api/polymarket/filters/convergence_stats').then(cs => {
        _convergenceStats = cs;
        if (_activeTab === 'filters') renderFilters();
      }).catch(() => {});

      fetchJSON('/api/polymarket/filters/recent_rejections').then(data => {
        _recentRejections = Array.isArray(data) ? data : [];
        if (_activeTab === 'filters') renderFilters();
      }).catch(() => {});

      fetchJSON('/api/polymarket/intents').then(data => {
        _intents = Array.isArray(data) ? data : [];
        if (_activeTab === 'intent') renderIntent();
      }).catch(() => {});

      fetchJSON('/api/polymarket/profiles').then(data => {
        _profiles = Array.isArray(data) ? data : [];
        _profilesMap = {};
        _profiles.forEach(p => {
          _profilesMap[p.wallet] = p;
          _profilesMap[(p.wallet || '').toLowerCase()] = p;
        });
        if (_activeTab === 'leaderboard') renderLeaderboard();
        if (_activeTab === 'wallets') renderWallets();
        if (_activeTab === 'positions') renderPositions();
      }).catch(() => {});

      _serverOnline = true;
      render();
      loadModeAndBudget();

      // Auto-refresh calibration tab if active
      if (_activeTab === 'calibration') {
        try { await loadCalibrationData(); } catch(e) { console.error('[calibration] refresh error', e); }
      }
      if (_activeTab === 'logs') App.renderLogs();

      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const tsEl = $('ts');
      if (tsEl) tsEl.textContent = 'Last updated ' + now;
      const trEl = $('tr');
      if (trEl) trEl.textContent = 'Updated ' + now;
    } catch (err) {
      _serverOnline = false;
      console.error('[loadAll] error', err);
      _setHealthOffline();
    }
  }

  function _setHealthOffline() {
    const el = $('systemHealth');
    if (!el) return;
    el.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--red);padding:3px 9px;background:var(--red-bg);border:1px solid var(--red-brd);border-radius:20px';
    el.innerHTML = '<span style="width:5px;height:5px;border-radius:50%;background:var(--red);display:inline-block"></span>OFFLINE';
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    _refreshTimer = setInterval(loadAll, 10000);
  }

  function stopAutoRefresh() {
    if (_refreshTimer) {
      clearInterval(_refreshTimer);
      _refreshTimer = null;
    }
  }

  // ─── render dispatcher ────────────────────────────────────────────────────────
  function render() {
    renderPortfolio();
    renderPositions();
    renderHistory();
    renderFilters();
    _redrawChart();
  }

  // ─── portfolio ───────────────────────────────────────────────────────────────
  function renderPortfolio() {
    if (!_portfolio) return;
    const data = _portfolio;

    const portfolioEl = $('portfolioVal');
    const inPosEl = $('inPositions');
    const availEl = $('available');
    const meterEl = $('portfolioMeter');

    if (_currentMode === 'live') {
      // LIVE: wallet balance is the main number, allocated budget limits trading
      const walletTotal = _usdcBalance || 0;
      const walletCash = _usdcCash || 0;
      const inPositions = walletTotal - walletCash;
      if (portfolioEl) portfolioEl.textContent = fmt$(walletTotal);
      if (inPosEl) inPosEl.textContent = fmt$(inPositions);
      if (availEl) availEl.textContent = fmt$(walletCash);
      if (_budgetData) {
        const budgetUsd = _budgetData.budget_usd || 0;
        const avail = _budgetData.available || 0;
        const pct = budgetUsd > 0 ? Math.min((avail / budgetUsd) * 100, 100) : 0;
        if (meterEl) meterEl.style.width = pct + '%';
      }
    } else {
      const inPos = data.totals ? data.totals.in_positions || 0 : 0;
      if (_budgetData) {
        const budgetUsd = _budgetData.budget_usd || 0;
        const remaining = _budgetData.remaining_budget || 0;
        const avail = _budgetData.available || 0;
        const pct = remaining > 0 ? Math.min((avail / remaining) * 100, 100) : 0;
        if (portfolioEl) {
          portfolioEl.innerHTML = fmt$(remaining) + ' <span style="font-size:14px;font-weight:400;color:var(--t3)">of ' + fmt$(budgetUsd) + '</span>';
        }
        if (inPosEl) inPosEl.textContent = fmt$(inPos);
        if (availEl) availEl.textContent = fmt$(avail);
        if (meterEl) meterEl.style.width = pct + '%';
      }
    }

    // Render bots alloc
    const allocEl = $('botsAlloc');
    if (allocEl && Array.isArray(data.bots)) {
      allocEl.innerHTML = data.bots.map(bot => {
        const botType = bot.type || 'trader';
        const dotCls = bot.running ? 'on' : 'off';
        const statusColor = bot.running ? 'var(--grn)' : 'var(--red)';
        const statusBg = bot.running ? 'var(--grn-bg)' : 'var(--red-bg)';
        const statusBrd = bot.running ? 'var(--grn-brd)' : 'var(--red-brd)';
        const statusLabel = bot.running ? 'RUNNING' : 'STOPPED';
        const balColor = 'var(--ind)';
        const emoji = bot.emoji || '🐋';
        const label = bot.name || 'Whale Copy Bot';
        const balance = typeof bot.balance === 'object' ? bot.balance.current : bot.balance;
        const pid = bot.pid || '—';
        const startId = `bot${botType}Start`;
        const stopId  = `bot${botType}Stop`;
        const rstId   = `bot${botType}Restart`;
        const isServiceBot = botType === 'ws_feed' || botType === 'rtds_feed' || botType === 'calibrator';
        const startDis = bot.running ? ' disabled' : '';
        const stopDis  = bot.running ? '' : ' disabled';
        return `
          <div class="alloc-item">
            <div class="alloc-status-dot ${dotCls}"></div>
            <div class="alloc-info">
              <span class="alloc-name">${emoji} ${esc(label)}</span>
              <div class="alloc-meta">
                <span class="b" style="background:${statusBg};border:1px solid ${statusBrd};color:${statusColor};font-size:9px;letter-spacing:.05em">${statusLabel}</span>
                <span style="color:var(--t3);font-size:10px;font-family:var(--fm)">PID ${pid}</span>
              </div>
            </div>
            <div class="alloc-acts">
              <button class="alloc-act start" id="${startId}" title="Start"${startDis}>▶️</button>
              <button class="alloc-act stop"  id="${stopId}"  title="Stop"${stopDis}>⏹️</button>
              <button class="alloc-act restart" id="${rstId}" title="Restart">🔄</button>
            </div>
          </div>`;
      }).join('');

      // Wire bot action buttons after rendering — use botType (trader/ws_feed) for API
      data.bots.forEach(bot => {
        const botType = bot.type || 'trader';
        const startEl = $(`bot${botType}Start`);
        const stopEl  = $(`bot${botType}Stop`);
        const rstEl   = $(`bot${botType}Restart`);
        if (startEl) { startEl.addEventListener('click', () => botAction(botType, 'start')); startEl.disabled = !!bot.running; }
        if (stopEl)  { stopEl.addEventListener('click',  () => botAction(botType, 'stop'));  stopEl.disabled  = !bot.running; }
        if (rstEl)   rstEl.addEventListener('click', () => botAction(botType, 'restart'));
      });
    }

    // System health pill
    const healthEl = $('systemHealth');
    if (healthEl && Array.isArray(data.bots)) {
      const allRunning  = data.bots.every(b => b.running);
      const someRunning = data.bots.some(b => b.running);
      if (allRunning) {
        healthEl.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--grn);padding:3px 9px;background:var(--grn-bg);border:1px solid var(--grn-brd);border-radius:20px';
        healthEl.innerHTML = '<span class="hdr-status-dot"></span>HEALTHY';
      } else if (someRunning) {
        healthEl.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--amb);padding:3px 9px;background:var(--amb-bg);border:1px solid var(--amb-brd);border-radius:20px';
        healthEl.innerHTML = '<span style="width:5px;height:5px;border-radius:50%;background:var(--amb);display:inline-block"></span>DEGRADED';
      } else {
        healthEl.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--t3);padding:3px 9px;background:var(--bg3);border:1px solid var(--brd2);border-radius:20px';
        healthEl.innerHTML = '<span style="width:5px;height:5px;border-radius:50%;background:var(--t3);display:inline-block"></span>STANDBY';
      }
    }
  }

  // ─── positions ───────────────────────────────────────────────────────────────
  function renderPositions() {
    const tbody = $('positionsTbody');
    const countEl = $('posCount');
    if (!tbody) return;

    const positions = _positions || [];
    if (countEl) countEl.textContent = positions.length;

    if (!positions.length) {
      tbody.innerHTML = '<tr><td colspan="15" class="td-dim" style="text-align:center;padding:32px">No open positions</td></tr>';
      return;
    }

    tbody.innerHTML = positions.map(p => {
      const mode = p.trading_mode === 'live' ? '<span class="b b-live">LIVE</span>' : '<span class="b b-dry">DRY</span>';
      const tradeId = p.trade_id ? `<span class="trade-id">${esc((p.trade_id || '').slice(0, 4))}</span>` : '<span class="td-dim">—</span>';

      const pMktUrl = p.event_slug
        ? `https://polymarket.com/event/${esc(p.event_slug)}`
        : p.condition_id ? `https://polymarket.com/event/${esc(p.condition_id)}` : '';
      const mktCell = pMktUrl
        ? `<a href="${pMktUrl}" target="_blank" class="mkt-link">${esc(p.market)}</a>`
        : esc(p.market || '—');

      const whaleCell = p.wallet
        ? `<span class="td-mono" style="color:var(--ind)">${esc(shortWallet(p.wallet))}</span>`
        : '<span class="td-dim">—</span>';

      const sideBadge = p.side === 'YES'
        ? '<span class="b b-yes">YES</span>'
        : '<span class="b b-no">NO</span>';

      const orderId = p.order_id
        ? `<span class="order-id">${esc((p.order_id || '').slice(0, 8))}</span>`
        : '<span class="td-dim">—</span>';

      const fillStatus = p.fill_status || (p.trading_mode === 'live' ? 'filled' : 'simulated');
      const fillCls = fillStatus === 'filled' ? 'b-filled' : fillStatus === 'pending' ? 'b-pending' : 'b-simulated';
      const fillBadge = `<span class="b ${fillCls}">${esc(fillStatus)}</span>`;

      const markQ = p.mark_quality || (p.trading_mode === 'live' ? 'executable' : '—');
      const markCls = markQ === 'executable' ? 'b-exec' : markQ === 'stale' ? 'b-stale' : 'b-indicative';
      const markBadge = markQ !== '—' ? `<span class="b ${markCls}">${esc(markQ)}</span>` : '<span class="td-dim">—</span>';

      const pnl = p.unrealized_pnl ?? 0;
      const pnlCls = pnl > 0 ? 'td-pos' : pnl < 0 ? 'td-neg' : 'td-dim';
      const pnlStr = (pnl >= 0 ? '+' : '') + fmt$(pnl);

      return `<tr>
        <td>${mode}</td>
        <td>${tradeId}</td>
        <td class="td-main">${mktCell}</td>
        <td>${whaleCell}</td>
        <td>${sideBadge} ${strategyBadge(p.strategy)}</td>
        <td><span class="td-mono">${p.entry_price != null ? p.entry_price.toFixed(3) : '—'}</span></td>
        <td><span class="cur-price td-mono" data-entry="${p.entry_price ?? ''}" data-current="${p.current_price ?? ''}">${p.current_price != null ? p.current_price.toFixed(3) : '—'}</span></td>
        <td><span class="td-mono">${fmt$(p.cost)}</span></td>
        <td class="${pnlCls}">${pnlStr}</td>
        <td>${orderId}</td>
        <td>${fillBadge}</td>
        <td>${markBadge}</td>
        <td class="td-dim">${p.age_ts ? fmtAge(p.age_ts) : '—'}</td>
        <td class="td-dim">${p.last_price_update_ts ? fmtUpdatedAt(p.last_price_update_ts) : '—'}</td>
        <td><button class="btn-exit" onclick="exitPosition('${esc(p.trade_id || '')}','${esc(p.condition_id || '')}','${esc(p.asset_id || '')}','${esc(p.market || '')}','${esc(p.trading_mode || '')}')">Exit</button></td>
      </tr>`;
    }).join('');

    colorPrices();
  }

  async function exitPosition(tradeId, conditionId, assetId, market, mode) {
    const isLive = mode === 'live';
    const verb = isLive ? 'sell on-chain' : 'close';
    if (!confirm(`${verb.charAt(0).toUpperCase() + verb.slice(1)} position?\n\n${market}\n\n${isLive ? 'This will place a real sell order.' : 'This will instantly close the dry-run position.'}`)) return;
    try {
      const body = {};
      if (tradeId) body.trade_id = tradeId;
      if (conditionId) body.condition_id = conditionId;
      if (assetId) body.asset_id = assetId;
      const resp = await fetch('/api/polymarket/positions/exit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      setTimeout(() => loadAll(), 1000);
    } catch (e) {
      alert('Exit failed: ' + e.message);
    }
  }
  window.exitPosition = exitPosition;

  // ─── history ─────────────────────────────────────────────────────────────────
  function renderHistory() {
    const tbody = $('historyTbody');
    const footer = $('historyFooter');
    const countEl = $('histCount');
    if (!tbody || !_history) return;

    const trades = _history.trades || [];
    if (countEl) countEl.textContent = trades.length;

    if (!trades.length) {
      tbody.innerHTML = '<tr><td colspan="12" class="td-dim" style="text-align:center;padding:32px">No trade history</td></tr>';
      if (footer) footer.innerHTML = '';
      return;
    }

    tbody.innerHTML = trades.map(t => {
      const mode = t.trading_mode === 'live' ? '<span class="b b-live">LIVE</span>' : '<span class="b b-dry">DRY</span>';
      const tradeId = t.trade_id ? `<span class="trade-id">${esc((t.trade_id || '').slice(0, 4))}</span>` : '<span class="td-dim">—</span>';

      const mktUrl = t.event_slug
        ? `https://polymarket.com/event/${esc(t.event_slug)}`
        : t.condition_id ? `https://polymarket.com/event/${esc(t.condition_id)}` : '';
      const mktCell = mktUrl
        ? `<a href="${mktUrl}" target="_blank" class="mkt-link">${esc(t.market)}</a>`
        : esc(t.market || '—');

      const sideStr = (t.side || '').toUpperCase();
      const isYes = sideStr.startsWith('YES') || sideStr.startsWith('BUY');
      const sideBadge = isYes
        ? '<span class="b b-yes">YES</span>'
        : '<span class="b b-no">NO</span>';

      const pnlRaw = t.pnl ?? t.pnl_amount ?? 0;
      const isWin = pnlRaw > 0 || t.pnl_status === 'win';
      const resultBadge = isWin
        ? '<span class="b b-win">Won ✅</span>'
        : '<span class="b b-lose">Lost ❌</span>';

      const pnl = pnlRaw;
      const pnlCls = pnl > 0 ? 'td-pos' : pnl < 0 ? 'td-neg' : 'td-dim';
      const pnlStr = (pnl >= 0 ? '+' : '') + fmt$(pnl);

      const entryPrice = t.entry ?? t.entry_price;
      const exitPrice  = t.exit  ?? t.exit_price;

      return `<tr>
        <td class="td-dim">${fmtDate(t.date)}</td>
        <td>${mode}</td>
        <td>${tradeId}</td>
        <td class="td-main">${mktCell}</td>
        <td>${sideBadge}</td>
        <td class="td-mono">${entryPrice != null ? Number(entryPrice).toFixed(3) : '—'}</td>
        <td><span class="cur-price td-mono" data-entry="${entryPrice ?? ''}" data-current="${exitPrice ?? ''}">${exitPrice != null ? Number(exitPrice).toFixed(3) : '—'}</span></td>
        <td class="${pnlCls}">${pnlStr}</td>
        <td>${resultBadge}</td>
        <td class="td-dim">${esc(t.duration || '—')}</td>
        <td><button class="btn-del-hist" onclick="delHistTrade('${esc(t.condition_id || '')}',${t.open_ts || 0})" data-tip="Delete this trade from history">❌</button></td>
      </tr>`;
    }).join('');

    if (footer) {
      const s = _history.summary || {};
      const netPnl = s.net_pnl ?? 0;
      const netCls = netPnl > 0 ? 'td-pos' : netPnl < 0 ? 'td-neg' : '';
      const wrColor = (s.win_rate || 0) >= 50 ? 'var(--grn)' : 'var(--red)';
      footer.innerHTML = `<tr>
        <td colspan="6">Total: ${s.total || 0} trades · Win rate: <span style="color:${wrColor};font-weight:700">${s.win_rate ?? 0}%</span></td>
        <td class="${netCls}" style="font-weight:700">${(netPnl >= 0 ? '+' : '') + fmt$(netPnl)}</td>
        <td colspan="3"></td>
      </tr>`;
    }

    colorPrices();
  }

  // ─── filter helpers ───────────────────────────────────────────────────────────
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
          parts.push(`${def.label} ≥ ${Number(v).toFixed(2)}`);
        }
      }
      parts.push('CONV ≥ 0');
      return parts.join(' · ');
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
    const name = sel ? sel.value : (_selectedBotName || null);
    return _filters.find(b => b.name === name) || _filters[0] || null;
  }

  function _getFilterDisplayVal(entry) {
    const key = entry.key;
    if (entry.type === 'conviction_gate' && entry.sub_keys) {
      // Build merged object from current_value + saved overrides + pending edits
      const base = (typeof entry.current_value === 'object' && entry.current_value) || {};
      const result = {};
      for (const [name, def] of Object.entries(entry.sub_keys)) {
        const sk = def.key;
        const pending = _filterEdits[sk];
        const saved   = _filterSavedConfig[sk];
        result[name] = pending !== undefined ? pending : saved !== undefined ? saved : (base[name] != null ? base[name] : def.default);
      }
      return result;
    }
    const pending = _filterEdits[key];
    const saved   = _filterSavedConfig[key];
    return pending !== undefined ? pending : saved !== undefined ? saved : entry.current_value != null ? entry.current_value : entry.default;
  }

  function _updatePendingCount() {
    const n = Object.keys(_filterEdits).length;
    const saveBtn = $('filterSaveBtn');
    if (saveBtn) {
      saveBtn.textContent = n ? `Save (${n})` : 'Save';
      saveBtn.style.color = n ? '#fbbf24' : '';
      saveBtn.style.display = n ? '' : 'none';
    }
  }

  function _updateConvGateCalc() {
    const el = $('convGateCalc');
    if (!el) return;
    // Read current slider values (or saved config)
    const probeSlider = document.querySelector('.pl-ed-sl[data-filter-key="conviction_gate_probe"]');
    const confirmSlider = document.querySelector('.pl-ed-sl[data-filter-key="conviction_gate_confirm"]');
    const baseSlider = document.querySelector('.pl-ed-sl[data-filter-key="conviction_formula_base"]');
    const probe = probeSlider ? parseFloat(probeSlider.value) : 0.12;
    const confirm_ = confirmSlider ? parseFloat(confirmSlider.value) : 0.04;
    const base = baseSlider ? parseFloat(baseSlider.value) : 500;
    const cap = 100000;
    // score = log(size/base) / log(cap/base) * 0.6 >= threshold
    // size = base * (cap/base)^(threshold/0.6)
    function minTrade(threshold) {
      if (threshold <= 0) return 0;
      return Math.round(base * Math.pow(cap / base, threshold / 0.6));
    }
    const probeMin = minTrade(probe);
    const confirmMin = minTrade(confirm_);
    // Show example trade sizes
    const sizes = [100, 250, 500, 1000, 2000, 5000, 10000];
    function score(size) {
      if (size < base) return 0;
      if (size >= cap) return 0.6;
      return Math.log(size / base) / Math.log(cap / base) * 0.6;
    }
    let rows = sizes.map(s => {
      const sc = score(s);
      const passP = sc >= probe ? '✓' : '✗';
      const passC = sc >= confirm_ ? '✓' : '✗';
      const color = sc >= probe ? 'var(--cal-green-text)' : sc >= confirm_ ? 'var(--cal-amber-text)' : 'var(--cal-red-text)';
      return `<span style="color:${color}">$${s.toLocaleString()} → ${sc.toFixed(3)} ${passP}P ${passC}C</span>`;
    }).join(' · ');
    el.innerHTML = `<div style="margin-bottom:6px;font-weight:600;color:var(--t1)">Min trade size</div>`
      + `<div style="margin-bottom:4px">PROBE ≥ ${probe}: <b style="color:var(--cal-green-text)">$${probeMin.toLocaleString()}</b></div>`
      + `<div style="margin-bottom:8px">CONFIRM ≥ ${confirm_}: <b style="color:var(--cal-amber-text)">$${confirmMin.toLocaleString()}</b></div>`
      + `<div style="font-size:10px;line-height:1.6;word-break:break-all">${rows}</div>`;
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
        _filterEdits[key] = (checked.length === 0 || checked.length === allVals.length) ? '' : checked.join(',');
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
          _filterEdits[key] = val;
          _updatePendingCount();
          renderFilters();
        });
      }
    });
  }

  // ── Pipeline Dashboard (replaces old _renderFilterControls + _renderPipelineImpact) ──

  var _plOpenId = null;  // currently expanded editor node

  function _plHeat(pct) {
    if (pct >= 15) return 'pl-hc';
    if (pct >= 2)  return 'pl-hh';
    if (pct > 0)   return 'pl-hm';
    return 'pl-hq';
  }

  // Filters that run in HARD SAFETY CHECKS (place_copy_trade) — always active,
  // even when FilterRegistry pipeline is bypassed for diagnostic testing.
  var _ACTIVE_FILTER_KEYS = new Set([
    'FILTER_ONLY_BUY',               // #0 only BUY orders
    'FILTER_MAX_OPEN_POSITIONS',     // #1 max open positions
    'FILTER_MAX_PER_EVENT',          // #2 dedup per market
    'FILTER_MAX_TOTAL_EXPOSURE',     // #3 max total exposure
    'FILTER_INTRADAY_ENABLED',       // #5 intraday binary filter
    'FILTER_SKIP_CRYPTO',            // #6 crypto skip
    'FILTER_MAX_DAYS_TO_RESOLUTION', // #7 time to resolution (max days)
    'FILTER_MIN_TIME_TO_RESOLUTION_H', // #7 time to resolution (min hours)
    // FILTER_MIN_WHALE_SIZE_USD moved to ⓪ Hard Safety (HS_MIN_WHALE_SIZE)
    'FILTER_PRICE_MIN',              // #9 price band min
    'FILTER_PRICE_MAX',              // #9 price band max
    'FILTER_MIN_MARKET_VOLUME',      // #10 min market volume
  ]);
  // Note: dedup per market (#2) and drawdown full stop (#4) are also active
  // but don't have editable pipeline cards.

  function _plIsFilterEnabled(entry) {
    return _ACTIVE_FILTER_KEYS.has(entry.key);
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
  window._plToggle = _plToggle;
  window._saveFilterConfig = _saveFilterConfig;
  window.renderFilters = renderFilters;

  function _plSliderUpdate(slider, id, entry) {
    var val = parseFloat(slider.value);
    var outEl = $('pl-o-' + id);
    if (outEl) outEl.textContent = _fmtFilterVal(entry, val);
    _filterEdits[entry.key] = val;
    _updatePendingCount();
  }

  // ── Convergence override pipeline section ────────────────────────────────────

  // Convergence filters — same config keys as main pipeline (shared thresholds)
  const CONV_FILTERS = [
    {id: 'cv-edge', reject_key: 'conv_remaining_edge', key: 'CONV_MIN_REMAINING_EDGE', label: 'Conv: Remaining Edge',
     editable: true, type: 'float', min: 0.05, max: 0.50, step: 0.01, unit: '%', default: 0.20,
     tooltip: "Minimum profit potential from current price. For BUY: (1-price)/price. If remaining edge < threshold, not enough room for profit even with whale convergence."},
    {id: 'cv-vol', reject_key: 'conv_volume', key: 'CONV_MIN_MARKET_VOLUME', label: 'Conv: Market Volume',
     editable: true, type: 'float', min: 0, max: 500000, step: 1000, unit: '$', default: 1500,
     tooltip: "Separate volume threshold for convergence (independent from main Min Market Volume). Low volume = our entry would move the price."},
    {id: 'cv-time', reject_key: 'conv_time', key: 'FILTER_MIN_TIME_TO_RESOLUTION_H', label: 'Conv: Time to Resolution',
     editable: true, type: 'int', min: 1, max: 72, step: 1, unit: 'h', default: 24,
     tooltip: "Market about to close. Even with strong whale agreement, not enough time to monitor and exit the position."},
    {id: 'cv-hard', reject_key: 'conv_hard_stops', label: 'Conv: Hard Stops',
     editable: false, type: 'info', current_value: '\u2014',
     tooltip: "Drawdown (35%), exposure cap, duplicate check, price band, intraday regex. Combined gate \u2014 these always apply."},
    {id: 'cv-coinflip', reject_key: 'conv_coinflip', label: 'Conv: Coin-flip Block',
     editable: false, type: 'info', current_value: 'ON',
     tooltip: "Block intraday/crypto coin-flip markets even for convergence \u2014 too unreliable."},
    {id: 'cv-slip', reject_key: 'conv_slippage', key: 'FILTER_MAX_SLIPPAGE', label: 'Conv: Slippage',
     editable: true, type: 'float', min: 0.01, max: 0.50, step: 0.01, unit: '¢', default: 0.20,
     tooltip: "Absolute price deviation from whale entry (in cents). E.g. 0.15 = max 15¢ difference."},
  ];

  function _renderConvergenceSection() {
    const cs = _convergenceStats || {};

    const signals = cs.total_signals || 0;
    const entered = cs.total_entered || 0;
    const blocked = cs.total_blocked || 0;
    const counts = cs.counts || {};

    // Build filter entries with reject counts + current display values
    // Populate current_value from main pipeline entries (shared keys)
    const bot = _getSelectedBot();
    const plEntries = (bot && bot.pipeline) || [];
    const convEntries = CONV_FILTERS.map(f => {
      const rc = counts[f.reject_key] || 0;
      const pct = signals > 0 ? rc / signals * 100 : 0;
      // Fall back to pipeline current_value for shared keys
      const plEntry = f.editable ? plEntries.find(pe => pe.key === f.key) : null;
      const enriched = plEntry ? {...f, current_value: plEntry.current_value} : f;
      const val = enriched.editable ? _getFilterDisplayVal(enriched) : enriched.current_value;
      const displayVal = enriched.editable ? _fmtFilterVal(enriched, val) : (enriched.current_value || '\u2014');
      return {...enriched, rc, pct, val, displayVal};
    });
    const convMaxPct = Math.max(...convEntries.map(e => e.pct), 1);

    let h = '';
    // Purple divider
    h += '<div class="pl-flow" style="margin-top:18px"><div class="pl-flow-ln pl-flow-ln-purple"></div><span class="pl-flow-n pl-flow-n-purple">Convergence override path</span><div class="pl-flow-ln pl-flow-ln-purple"></div></div>';

    // Section with purple left border
    h += '<div class="pl-conv-section">';

    // Mini stats (3 cols)
    h += '<div class="pl-conv-stats">';
    h += `<div class="pl-st"><div class="pl-st-n" style="color:var(--pur)">${signals}</div><div class="pl-st-l">Signals fired</div></div>`;
    h += `<div class="pl-st"><div class="pl-st-n" style="color:var(--amb)">${blocked}</div><div class="pl-st-l">Blocked</div></div>`;
    h += `<div class="pl-st"><div class="pl-st-n" style="color:var(--grn)">${entered}</div><div class="pl-st-l">Entered</div></div>`;
    h += '</div>';

    // Group label
    h += '<div class="pl-grp pl-grp-purple">Convergence checks</div>';

    // Filter nodes in rows of 2
    const rows = [];
    let row = [];
    convEntries.forEach((e, i) => {
      row.push(e);
      if (row.length >= 2 || i === convEntries.length - 1) { rows.push(row); row = []; }
    });

    rows.forEach(rf => {
      h += `<div class="pl-row c${rf.length}">`;
      rf.forEach(e => {
        const heat = _plHeat(e.pct);
        const barW = e.pct <= 0 ? 0 : Math.max(4, Math.round(e.pct / convMaxPct * 100));
        const tip = esc(e.tooltip || '');
        const nodeId = e.id;

        h += `<div class="pl-node ${heat}" data-pl-id="${nodeId}" data-tooltip="${tip}" onclick="_plToggle('${nodeId}')">`;
        h += `<div class="pl-node-h"><span class="pl-node-nm">${esc(e.label)}</span>`;
        h += `<span class="pl-node-rj">${e.rc > 0 ? e.rc + ' &middot; ' + e.pct.toFixed(1) + '%' : '0'}</span></div>`;
        if (e.rc > 0) h += `<div class="pl-node-br"><div class="pl-node-bf" style="width:${barW}%"></div></div>`;
        h += `<div class="pl-node-bt"><span class="pl-node-v">${esc(e.displayVal)}</span>`;
        if (e.editable) h += '<span class="pl-node-hi">edit</span>';
        h += '</div></div>';

        // Editor panel
        if (e.editable) {
          h += `<div class="pl-ed" id="pl-ed-${nodeId}">`;
          if (e.unit === '%') {
            // Percentage → slider
            const sliderVal = e.val != null ? e.val : e.default;
            h += '<div class="pl-ed-lb">Adjust value</div>';
            h += `<div class="pl-ed-ct"><input type="range" class="pl-ed-sl" data-filter-key="${esc(e.key)}" min="${e.min}" max="${e.max}" step="${e.step}" value="${sliderVal}">`;
            h += `<span class="pl-ed-o" id="pl-o-${nodeId}">${esc(e.displayVal)}</span></div>`;
          } else {
            // Numeric input
            const numVal = e.val != null ? e.val : e.default;
            const unitLabel = e.unit ? ` ${esc(e.unit)}` : '';
            h += '<div class="pl-ed-lb">Enter value</div>';
            h += `<div class="pl-ed-ct"><input type="number" class="pl-ed-num" data-filter-key="${esc(e.key)}" min="${e.min}" max="${e.max}" step="${e.step}" value="${numVal}">`;
            h += `<span class="pl-ed-o" id="pl-o-${nodeId}">${unitLabel}</span></div>`;
          }
          if (e.tooltip) h += `<div class="pl-ed-d">${esc(e.tooltip)}</div>`;
          h += `<div class="pl-ed-a"><button class="hdr-btn" style="color:var(--grn);border-color:var(--grn)" onclick="event.stopPropagation();_saveFilterConfig(true)">Save</button>`;
          h += `<button class="hdr-btn" onclick="event.stopPropagation();_plToggle('${nodeId}')">Close</button></div>`;
          h += '</div>';
        } else if (e.tooltip) {
          h += `<div class="pl-ed" id="pl-ed-${nodeId}"><div class="pl-ed-d" style="margin:0">${esc(e.tooltip)}</div></div>`;
        }
      });
      h += '</div>';
    });

    // Output node
    h += `<div class="pl-pass pl-pass-sm"><div class="pl-pass-n">~${entered}</div><div class="pl-pass-l">entered via convergence</div></div>`;

    h += '</div>'; // close pl-conv-section
    return h;
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
    const totalChecked = (_rejectStats && _rejectStats.total_checked) || 0;
    const totalRejected = (_rejectStats && _rejectStats.total_rejected) || 0;
    const totalAccepted = (_rejectStats && _rejectStats.total_accepted) || Math.max(0, totalChecked - totalRejected);
    const passRate = totalChecked > 0 ? (totalAccepted / totalChecked * 100) : 0;
    const activeCount = pipeline.filter(e => (e.reject_count || 0) > 0).length;
    const maxPct = Math.max(...pipeline.map(e => totalChecked > 0 ? (e.reject_count || 0) / totalChecked * 100 : 0), 1);

    // Group pipeline
    const groups = {};
    const groupOrder = [];
    pipeline.forEach(entry => {
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
    const botOptions = _filters.map(b =>
      `<option value="${esc(b.name)}"${b.name === bot.name ? ' selected' : ''}>${esc(b.emoji || '')} ${esc(b.name)}</option>`
    ).join('');
    const hasBots = _filters.length > 1;
    const botSelHtml = hasBots ? `<select class="f-sel" id="filterBotSel" onchange="renderFilters(true)">${botOptions}</select>` : '';

    // Pending count
    const pendingN = Object.keys(_filterEdits).length;
    const saveStyle = pendingN ? '' : ' style="display:none"';
    const saveLbl = pendingN ? `Save (${pendingN})` : 'Save';

    let h = '';
    // Header
    h += `<div class="pl-hdr"><div class="pl-hdr-l">${botSelHtml}<span class="pl-hdr-t">Filter pipeline</span>${modeBadge}</div>`;
    h += `<div class="pl-hdr-r"><button class="hdr-btn" onclick="_resetPipelineImpact()">Reset stats</button>`;
    h += `<button class="hdr-btn" id="filterSaveBtn"${saveStyle} onclick="_saveFilterConfig(true)">${saveLbl}</button></div></div>`;

    // Stats row
    h += '<div class="pl-stats">';
    h += `<div class="pl-st"><div class="pl-st-n" style="color:var(--red)">${totalRejected.toLocaleString()}</div><div class="pl-st-l">Rejected</div></div>`;
    h += `<div class="pl-st"><div class="pl-st-n" style="color:var(--grn)">~${totalAccepted.toLocaleString()}</div><div class="pl-st-l">Accepted</div></div>`;
    h += `<div class="pl-st"><div class="pl-st-n" style="color:var(--cyan)">${passRate.toFixed(1)}%</div><div class="pl-st-l">Pass rate</div></div>`;
    h += `<div class="pl-st"><div class="pl-st-n">${activeCount}<span style="font-size:13px;color:var(--t3)"> / ${pipeline.length}</span></div><div class="pl-st-l">Active filters</div></div>`;
    h += '</div>';

    // Groups + nodes
    let cumulativeRejects = 0;
    groupOrder.forEach((grpName, gi) => {
      h += `<div class="pl-grp">${esc(grpName)}</div>`;
      const entries = groups[grpName];

      // Chunk entries into rows of 2
      const rows = [];
      let row = [];
      entries.forEach((e, i) => {
        row.push(e);
        if (row.length >= 2 || i === entries.length - 1) { rows.push(row); row = []; }
      });

      rows.forEach(rf => {
        h += `<div class="pl-row c${rf.length}">`;
        rf.forEach(entry => {
          const rc = entry.reject_count || 0;
          const pct = totalChecked > 0 ? rc / totalChecked * 100 : 0;
          const heat = _plHeat(pct);
          const barW = pct <= 0 ? 0 : Math.max(4, Math.round(pct / maxPct * 100));
          const val = _getFilterDisplayVal(entry);
          const displayVal = _fmtFilterVal(entry, val);
          const tip = esc(entry.tooltip || entry.description || '');
          const nodeId = entry.key.replace(/[^a-zA-Z0-9_]/g, '');

          // Determine if filter is active (in hard safety checks) or bypassed
          const _isEnabled = _plIsFilterEnabled(entry);
          const _enabledCls = _isEnabled ? 'pl-on' : 'pl-off';

          h += `<div class="pl-node ${heat} ${_enabledCls}" data-pl-id="${nodeId}" data-tooltip="${tip}" onclick="_plToggle('${nodeId}')">`;
          h += `<div class="pl-node-h"><span class="pl-node-nm">${esc(entry.label)}</span>`;
          h += `<span class="pl-node-rj">${rc > 0 ? rc.toLocaleString() + ' &middot; ' + pct.toFixed(1) + '%' : '0'}</span></div>`;
          if (rc > 0) h += `<div class="pl-node-br"><div class="pl-node-bf" style="width:${barW}%"></div></div>`;
          h += `<div class="pl-node-bt"><span class="pl-node-v">${esc(displayVal)}</span>`;
          if (entry.editable) h += '<span class="pl-node-hi">edit</span>';
          h += '</div></div>';

          // Editor panel
          if (entry.editable) {
            h += `<div class="pl-ed" id="pl-ed-${nodeId}">`;
            if (entry.type === 'conviction_gate' && entry.sub_keys) {
              // Multi-threshold conviction gate — one slider per intent level
              h += '<div class="pl-ed-lb">Conviction thresholds by intent level</div>';
              const subVals = (typeof val === 'object' && val) || {};
              for (const [skName, skDef] of Object.entries(entry.sub_keys)) {
                const skKey = skDef.key;
                const skVal = subVals[skName] != null ? subVals[skName] : skDef.default;
                const skId = skKey.replace(/[^a-zA-Z0-9_]/g, '');
                h += `<div class="pl-ed-ct" style="margin-bottom:8px">`;
                h += `<span style="min-width:70px;font-size:12px;color:var(--t2)">${esc(skDef.label)}</span>`;
                h += `<input type="range" class="pl-ed-sl" data-filter-key="${esc(skKey)}" min="${skDef.min}" max="${skDef.max}" step="${skDef.step || 0.01}" value="${skVal}">`;
                h += `<span class="pl-ed-o" id="pl-o-${skId}">${Number(skVal).toFixed(2)}</span>`;
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
                h += `<label class="pl-ed-check-lbl"><input type="checkbox" class="pl-ed-check" data-filter-key="${esc(entry.key)}" data-cat-val="${esc(optVal)}"${checked ? ' checked' : ''}> ${esc(optLabel)}</label>`;
              });
              h += '</div>';
            } else if (entry.type === 'bool') {
              // Toggle
              const isOn = val === true || val === 'true' || val === 1;
              h += '<div class="pl-ed-lb">Toggle</div>';
              h += `<div class="pl-ed-ct"><label class="pl-ed-check-lbl" style="font-size:14px;gap:8px"><input type="checkbox" class="pl-ed-toggle" data-filter-key="${esc(entry.key)}" style="width:16px;height:16px;accent-color:var(--ind)"${isOn ? ' checked' : ''}> ${isOn ? 'Enabled' : 'Disabled'}</label></div>`;
            } else if ((entry.unit || '') === '%') {
              // Percentage → slider
              const sliderVal = val != null ? val : (entry.default || 0);
              h += '<div class="pl-ed-lb">Adjust value</div>';
              h += `<div class="pl-ed-ct"><input type="range" class="pl-ed-sl" data-filter-key="${esc(entry.key)}" min="${entry.min}" max="${entry.max}" step="${entry.step || 0.01}" value="${sliderVal}">`;
              h += `<span class="pl-ed-o" id="pl-o-${nodeId}">${esc(displayVal)}</span></div>`;
            } else {
              // Non-percentage numeric → number input
              const numVal = val != null ? val : (entry.default || 0);
              const unitLabel = entry.unit ? ` ${esc(entry.unit)}` : '';
              h += '<div class="pl-ed-lb">Enter value</div>';
              h += `<div class="pl-ed-ct"><input type="number" class="pl-ed-num" data-filter-key="${esc(entry.key)}" min="${entry.min}" max="${entry.max}" step="${entry.step || 0.01}" value="${numVal}">`;
              h += `<span class="pl-ed-o" id="pl-o-${nodeId}">${unitLabel}</span></div>`;
            }
            if (entry.tooltip) h += `<div class="pl-ed-d">${esc(entry.tooltip)}</div>`;
            else if (entry.description) h += `<div class="pl-ed-d">${esc(entry.description)}</div>`;
            h += `<div class="pl-ed-a"><button class="hdr-btn" style="color:var(--grn);border-color:var(--grn)" onclick="event.stopPropagation();_saveFilterConfig(true)">Save</button>`;
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
        h += '</div>';
      });

      // Flow connector
      entries.forEach(e => { cumulativeRejects += (e.reject_count || 0); });
      const remaining = Math.max(0, totalChecked - cumulativeRejects);
      if (gi < groupOrder.length - 1 && totalChecked > 0) {
        h += `<div class="pl-flow"><div class="pl-flow-ln"></div><span class="pl-flow-n">~${remaining.toLocaleString()} remaining</span><div class="pl-flow-ln"></div></div>`;
      }
    });

    // Pass output
    h += `<div class="pl-pass"><div class="pl-pass-n">~${totalAccepted.toLocaleString()}</div><div class="pl-pass-l">trades passed all ${pipeline.length} filters</div></div>`;

    // ── Convergence override section ──────────────────────────────────
    h += _renderConvergenceSection();

    // Legend
    h += '<div class="pl-legend">';
    h += '<span><span class="pl-legend-dt" style="background:var(--red)"></span>Bottleneck (&gt;15%)</span>';
    h += '<span><span class="pl-legend-dt" style="background:var(--amb)"></span>Active (2\u201315%)</span>';
    h += '<span><span class="pl-legend-dt" style="background:var(--t3)"></span>Light (&lt;2%)</span>';
    h += '<span><span class="pl-legend-dt" style="background:rgba(255,255,255,.06)"></span>Quiet</span>';
    h += '<span><span class="pl-legend-dt" style="background:var(--pur)"></span>Convergence</span>';
    h += '</div>';

    container.innerHTML = h;

    // Helper: find filter entry by key in pipeline or convergence filters
    function _findEntry(key) {
      return pipeline.find(e => e.key === key) || CONV_FILTERS.find(e => e.key === key);
    }
    function _nodeIdForEntry(entry) {
      // Convergence filters use their .id, pipeline entries use sanitized key
      const convF = CONV_FILTERS.find(e => e.key === entry.key);
      return convF ? convF.id : entry.key.replace(/[^a-zA-Z0-9_]/g, '');
    }

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
          if (outEl) outEl.textContent = v.toFixed(2);
          _filterEdits[key] = v;
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
        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          if (!isNaN(v)) {
            _filterEdits[key] = v;
            _updatePendingCount();
          }
        });
      }
    });

    // Initial conviction gate calculator update
    _updateConvGateCalc();

    // Wire category checkboxes
    container.querySelectorAll('.pl-ed-check[data-filter-key]').forEach(cb => {
      cb.addEventListener('change', () => {
        const key = cb.getAttribute('data-filter-key');
        const allChecks = [...container.querySelectorAll(`.pl-ed-check[data-filter-key="${key}"]`)];
        const allVals = allChecks.map(c => c.getAttribute('data-cat-val'));
        const checked = allChecks.filter(c => c.checked).map(c => c.getAttribute('data-cat-val'));
        _filterEdits[key] = (checked.length === 0 || checked.length === allVals.length) ? '' : checked.join(',');
        _updatePendingCount();
      });
    });

    // Wire bool toggles
    container.querySelectorAll('.pl-ed-toggle[data-filter-key]').forEach(toggle => {
      toggle.addEventListener('change', () => {
        const key = toggle.getAttribute('data-filter-key');
        _filterEdits[key] = toggle.checked;
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
      _rejectStats = { counts: {}, total_checked: 0, total_accepted: 0, total_rejected: 0 };
      _convergenceStats = { counts: {}, total_signals: 0, total_entered: 0, total_blocked: 0 };
      // Zero out reject_count in cached pipeline data
      if (_filters.length) {
        _filters.forEach(bot => {
          (bot.pipeline || []).forEach(e => { e.reject_count = 0; });
        });
      }
      _renderPipelineDashboard();
      // Reload after delay (trader detects reset on next flush)
      setTimeout(() => loadAll(), 2000);
    } catch (e) { /* ignore */ }
  }
  window._resetPipelineImpact = _resetPipelineImpact;

  function _renderRecentRejections() {
    const card = $('recentRejectionsCard');
    if (!card) return;

    if (!_recentRejections.length) {
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

    const rowsHtml = _recentRejections.map(r => `
      <div class="rej-row">
        <span class="rej-mkt">${esc(r.market)}</span>
        <span class="rej-filter">${esc(r.filter)}</span>
        <span class="rej-reason">${esc(r.skip_reason)}</span>
      </div>`).join('');

    card.innerHTML = headerHtml + rowsHtml + '</div>';
  }

  function renderFilters(force) {
    // Skip re-render while user is editing filters (open editor / pending changes)
    if (!force && (Object.keys(_filterEdits).length > 0 || _plOpenId)) return;
    // Capture selected bot name before re-render (select is recreated each time)
    const sel = $('filterBotSel');
    if (sel && sel.value) _selectedBotName = sel.value;
    _renderPipelineDashboard();
  }

  function renderRiskSettings() {
    if (!_riskSettings) return;
    const set = (id, val) => { const el = $(id); if (el) el.value = val; };
    set('riskReduceAt',    ((_riskSettings.DRAWDOWN_REDUCE_AT  ?? 0.15) * 100).toFixed(0));
    set('riskMinimalAt',   ((_riskSettings.DRAWDOWN_MINIMAL_AT ?? 0.25) * 100).toFixed(0));
    set('riskFullStop',    ((_riskSettings.DRAWDOWN_FULL_STOP  ?? 0.35) * 100).toFixed(0));
    set('riskMaxBetPct',   (_riskSettings.MAX_BET_PERCENT ?? 5).toFixed(1));
    set('riskMaxEntryUsd', (_riskSettings.MAX_ENTRY_SHARES ?? 10).toFixed(0));
  }

  async function _saveRiskSettings() {
    const btn    = $('riskSaveBtn');
    const status = $('riskSaveStatus');
    if (btn) btn.disabled = true;
    if (status) status.textContent = '';
    try {
      const num = id => { const el = $(id); return el ? parseFloat(el.value) : null; };
      const updates = {
        DRAWDOWN_REDUCE_AT:  (num('riskReduceAt')  ?? 15) / 100,
        DRAWDOWN_MINIMAL_AT: (num('riskMinimalAt') ?? 25) / 100,
        DRAWDOWN_FULL_STOP:  (num('riskFullStop')  ?? 35) / 100,
        MAX_BET_PERCENT:      num('riskMaxBetPct')  ?? 5,
        MAX_ENTRY_SHARES:     num('riskMaxEntryUsd') ?? 10,
      };
      const resp = await fetch('/api/polymarket/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      _riskSettings = data;
      if (status) { status.textContent = '✓ Saved'; setTimeout(() => { status.textContent = ''; }, 2000); }
    } catch (err) {
      if (status) { status.style.color = 'var(--red)'; status.textContent = 'Save failed: ' + err.message; }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function _flashBtn(btn, successText, ms = 1800) {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = successText;
    btn.style.color = '#4ade80';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, ms);
  }

  function _getFilterMode() {
    return (_filters.length && _filters[0].active_mode) || _currentMode || 'dry_run';
  }

  async function _saveFilterConfig(thenRestart) {
    const mode = _getFilterMode();
    const modeLabel = mode === 'live' ? 'LIVE' : 'DRY';
    const n = Object.keys(_filterEdits).length;
    if (thenRestart && n > 0) {
      const changes = Object.entries(_filterEdits)
        .map(([k, v]) => `  ${k}: ${_filterSavedConfig[k] ?? '?'} → ${v}`)
        .join('\n');
      if (!confirm(`Apply ${n} filter changes to ${modeLabel} mode?\nThis will save config and restart bots.\n\n${changes}`)) return;
    }
    const saveBtn  = $('filterSaveBtn');
    const applyBtn = $('filterApplyBtn');
    if (saveBtn)  saveBtn.disabled = true;
    if (applyBtn) applyBtn.disabled = true;
    try {
      const resp = await fetch('/api/polymarket/filters/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: _filterEdits, mode }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      _filterSavedConfig = data.config || {};
      _filterEdits = {};
      _plOpenId = null;  // reset open editor panel so renderFilters doesn't skip
      if (applyBtn) applyBtn.style.color = '';
      if (thenRestart) {
        _flashBtn(applyBtn, '✓ Applied to ' + modeLabel);
        await fetch('/api/polymarket/bots/trader/restart', { method: 'POST' });
        setTimeout(() => loadAll(), 2500);
      } else {
        _flashBtn(saveBtn, '✓ Saved (' + modeLabel + ')');
      }
      const filtersData = await fetchJSON('/api/polymarket/filters');
      _filters = filtersData;
      renderFilters(true);
    } catch (err) {
      alert('Save failed: ' + err.message);
    } finally {
      if (saveBtn)  saveBtn.disabled = false;
      if (applyBtn) applyBtn.disabled = false;
    }
  }

  async function _resetFilterConfig() {
    if (!confirm('Reset all filter overrides to code defaults?')) return;
    try {
      await fetch('/api/polymarket/filters/reset', { method: 'POST' });
      _filterSavedConfig = {};
      _filterEdits = {};
      const filtersData = await fetchJSON('/api/polymarket/filters');
      _filters = filtersData;
      renderFilters();
    } catch (err) {
      alert('Reset failed: ' + err.message);
    }
  }

  function _applyPreset(presetName) {
    if (!_filters.length) return;
    const presets = _filters[0].presets || {};
    const preset  = presets[presetName] || presets[presetName.toLowerCase()];
    if (!preset) return;
    // Clear stale edits so only preset values are pending
    _filterEdits = {};
    _filters.forEach(bot => {
      (bot.pipeline || []).forEach(entry => {
        if (!entry.editable) return;
        if (preset[entry.key] !== undefined) _filterEdits[entry.key] = preset[entry.key];
      });
    });
    renderFilters();
    // Show pending count — user must explicitly click Apply
    const applyBtn = $('filterApplyBtn');
    if (applyBtn) {
      const n = Object.keys(_filterEdits).length;
      applyBtn.textContent = n ? `⚠ Apply (${n})` : 'Apply';
      if (n) applyBtn.style.color = '#fbbf24';
    }
  }

  function _updatePresetSelector() {
    const sel = $('filterPresetSel');
    if (!sel || !_filters.length) return;
    const presets = _filters[0].presets || {};
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
      alert('Cannot overwrite built-in "calibrated" preset');
      return;
    }

    // Collect current filter values (pending edits + saved config + defaults)
    const values = {};
    if (_filters.length) {
      (_filters[0].pipeline || []).forEach(entry => {
        if (!entry.editable || entry.type === 'info' || entry.type === 'multiselect') return;
        const val = _filterEdits[entry.key] !== undefined ? _filterEdits[entry.key]
                  : _filterSavedConfig[entry.key] !== undefined ? _filterSavedConfig[entry.key]
                  : entry.current_value;
        if (val !== undefined && val !== null) values[entry.key] = val;
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
      const filtersData = await fetchJSON('/api/polymarket/filters');
      _filters = filtersData;
      _updatePresetSelector();
      if (sel) sel.value = name.trim().toLowerCase();
      alert('Preset "' + name.trim() + '" saved!');
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
  }
  window._savePreset = _savePreset;

  // ─── wallets ─────────────────────────────────────────────────────────────────
  function profileFor(addr) {
    if (!addr) return null;
    return _profilesMap[addr] || _profilesMap[(addr || '').toLowerCase()] || null;
  }

  function categoryBadge(cat) {
    if (!cat) return '';
    const name = typeof cat === 'object' ? (cat.name || '') : String(cat);
    const pct  = typeof cat === 'object' ? (cat.pct  || '') : '';
    const upper = name.toUpperCase();
    let cls = '';
    if (upper === 'POLITICS') cls = 'b-pol';
    else if (upper.startsWith('SPORT')) cls = 'b-sport';
    else if (upper === 'CRYPTO') cls = 'b-crypto';
    else if (upper === 'FINANCE' || upper === 'ECONOMICS') cls = 'b-econ';

    if (cls) {
      const label = pct ? `${name} ${pct}%` : name;
      return `<span class="b ${cls}">${esc(label)}</span>`;
    }
    // fallback inline
    return `<span class="b" style="background:rgba(100,116,139,.1);border:1px solid rgba(100,116,139,.2);color:var(--t2)">${esc(pct ? `${name} ${pct}%` : name)}</span>`;
  }

  async function renderWallets() {
    const tbody   = $('walletsTbody');
    const countEl = $('walCount');
    if (!tbody) return;

    try {
      const data = await fetchJSON('/api/polymarket/wallets');
      _wallets = Array.isArray(data) ? data : (data.wallets || []);
    } catch (_) {}

    const wallets = _wallets || [];
    if (countEl) countEl.textContent = wallets.length;

    // Stats
    if (wallets.length) {
      const avgTrust = wallets.reduce((s, w) => s + (Number(w.trust_score) || 50), 0) / wallets.length;
      const activeCount = wallets.filter(w => !w.trust_disabled).length;
      const prunedCount = wallets.filter(w => w.trust_disabled).length;
      const catSet = new Set();
      wallets.forEach(w => {
        const cats = Array.isArray(w.categories) ? w.categories : (w.category ? [w.category] : []);
        cats.forEach(c => catSet.add(typeof c === 'object' ? c.name : c));
      });

      const wt  = $('walletTotal');    if (wt)  wt.textContent  = wallets.length;
      const wat = $('walletAvgTrust'); if (wat) wat.textContent = avgTrust.toFixed(0);
      const wa  = $('walletActive');   if (wa)  wa.textContent  = activeCount;
      const wp  = $('walletPruned');   if (wp)  wp.textContent  = prunedCount;
      const wty = $('walletTypes');    if (wty) wty.textContent = catSet.size;
    }

    if (!wallets.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="td-dim" style="text-align:center;padding:32px">No wallets tracked</td></tr>';
      return;
    }

    const sorted = [...wallets].sort((a, b) => {
      const addrA = a.address || a.wallet || '';
      const addrB = b.address || b.wallet || '';
      const profA = profileFor(addrA);
      const profB = profileFor(addrB);
      let va, vb;
      switch (_walletSortCol) {
        case 'trust':
          va = Number(a.trust_score) || 50;
          vb = Number(b.trust_score) || 50;
          break;
        case 'sm':
          va = profA?.smart_money_score ?? a.score ?? (Number(a.trust_score) || 50);
          vb = profB?.smart_money_score ?? b.score ?? (Number(b.trust_score) || 50);
          break;
        case 'winrate': {
          const tA = (a.trust_wins || 0) + (a.trust_losses || 0);
          const tB = (b.trust_wins || 0) + (b.trust_losses || 0);
          va = tA > 0 ? a.trust_wins / tA : -1;
          vb = tB > 0 ? b.trust_wins / tB : -1;
          break;
        }
        case 'pnl':
          va = Number(a.trust_pnl) || 0;
          vb = Number(b.trust_pnl) || 0;
          break;
        case 'trades':
          va = (a.trust_wins || 0) + (a.trust_losses || 0);
          vb = (b.trust_wins || 0) + (b.trust_losses || 0);
          break;
        default:
          va = Number(a.trust_score) || 50;
          vb = Number(b.trust_score) || 50;
      }
      return _walletSortAsc ? va - vb : vb - va;
    });

    tbody.innerHTML = sorted.map((w, i) => {
      const addr  = w.address || w.wallet || '';
      const score = Number(w.trust_score) || 50;
      const tc    = trustColor(score);
      const trustTrades = (w.trust_wins || 0) + (w.trust_losses || 0);
      const winRate = trustTrades > 0 ? ((w.trust_wins / trustTrades) * 100) : null;
      const wr  = winRate != null ? winRate.toFixed(0) : null;
      const wrColor = winRate != null ? (winRate >= 75 ? 'var(--grn)' : winRate >= 60 ? 'var(--amb)' : 'var(--red)') : 'var(--t3)';
      const trustPnl = Number(w.trust_pnl) || 0;
      const pnlCls = trustPnl > 0 ? 'td-pos' : trustPnl < 0 ? 'td-neg' : 'td-dim';
      const profile = profileFor(addr);
      const smScore = profile?.smart_money_score ?? w.score;
      const cats = Array.isArray(w.categories) ? w.categories : (w.category ? [w.category] : []);
      const isNew = w.trust_disabled ? false : trustTrades === 0;
      const statusBadge = isNew
        ? '<span class="b b-new">New</span>'
        : (w.trust_disabled
          ? '<span class="b" style="background:var(--red-bg);border:1px solid var(--red-brd);color:var(--red)">Pruned</span>'
          : '<span class="b" style="background:var(--grn-bg);border:1px solid var(--grn-brd);color:var(--grn)">Active</span>');

      return `<tr>
        <td class="td-dim">${i + 1}</td>
        <td class="td-mono" style="color:var(--ind)">${esc(shortWallet(addr))}</td>
        <td class="td-dim">${smScore != null ? `<span style="color:var(--cyan);font-weight:700">${smScore}</span>${profile?.classification ? ` ${CLASS_EMOJI[profile.classification] || ''}` : ''}` : '—'}</td>
        <td><div class="trust-ring" style="border-color:${tc};color:${tc}">${score}</div></td>
        <td>
          <div class="winbar">
            <div class="winbar-bg"><div class="winbar-fill" style="width:${wr != null ? wr : 0}%;background:${wrColor}"></div></div>
            <span style="font-size:10px;color:${wrColor}">${wr != null ? wr + '%' : '—'}</span>
          </div>
        </td>
        <td class="${pnlCls}">${trustPnl !== 0 ? (trustPnl > 0 ? '+' : '') + fmt$(trustPnl) : '—'}</td>
        <td class="td-dim">${trustTrades > 0 ? trustTrades : '—'}</td>
        <td>${cats.map(categoryBadge).join(' ')}</td>
        <td>${statusBadge}</td>
        <td><button class="btn-reset-wallet" onclick="resetWallet('${esc(addr)}')" data-tip="Reset trust scores for this wallet">↺</button></td>
      </tr>`;
    }).join('');
  }

  function sortWallets(col) {
    if (_walletSortCol === col) {
      _walletSortAsc = !_walletSortAsc;
    } else {
      _walletSortCol = col;
      _walletSortAsc = false;
    }
    updateWalletSortHeaders();
    renderWallets();
  }
  window.sortWallets = sortWallets;

  async function delHistTrade(conditionId, openTs) {
    if (!confirm('Delete this trade from history?')) return;
    try {
      const r = await fetch('/api/polymarket/history/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ condition_id: conditionId, timestamp: openTs }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); alert(e.error || 'Failed'); return; }
      _history = await fetchJSON('/api/polymarket/history');
      renderHistory();
    } catch (e) { alert('Error: ' + e.message); }
  }
  window.delHistTrade = delHistTrade;

  async function resetWallet(address) {
    if (!confirm('Reset trust scores for this wallet to defaults?')) return;
    try {
      const r = await fetch('/api/polymarket/wallets/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); alert(e.error || 'Failed'); return; }
      await renderWallets();
    } catch (e) { alert('Error: ' + e.message); }
  }
  window.resetWallet = resetWallet;

  function updateWalletSortHeaders() {
    document.querySelectorAll('#pane-wallets th[data-sort]').forEach(th => {
      const col = th.dataset.sort;
      const arrow = th.querySelector('.sort-arrow');
      if (!arrow) return;
      if (col === _walletSortCol) {
        arrow.textContent = _walletSortAsc ? ' \u25B2' : ' \u25BC';
        arrow.style.opacity = '1';
      } else {
        arrow.textContent = ' \u25BC';
        arrow.style.opacity = '0.25';
      }
    });
  }

  // ─── intent ──────────────────────────────────────────────────────────────────
  function renderIntent() {
    const tbody   = $('intentTbody');
    const countEl = $('intentCount');
    if (!tbody) return;

    const records  = _intents || [];
    const filtered = _intentFilter ? records.filter(r => r.level === _intentFilter) : records;

    // Stats
    const probes     = records.filter(r => r.level === 'PROBE').length;
    const confirms   = records.filter(r => r.level === 'CONFIRM').length;
    const convictions = records.filter(r => r.level === 'CONVICTION').length;
    const totalUsd   = records.reduce((s, r) => s + (r.total_invested || 0), 0);

    const probesEl = $('intentProbes');
    const confsEl  = $('intentConfirms');
    const convsEl  = $('intentConvictions');
    const trackedEl = $('intentTracked');
    if (probesEl)   probesEl.textContent = probes;
    if (confsEl)    confsEl.textContent  = confirms;
    if (convsEl)    convsEl.textContent  = convictions;
    if (trackedEl)  trackedEl.textContent = fmt$(totalUsd) + ' tracked';
    if (countEl)    countEl.textContent  = confirms + convictions;

    // Also try fetching stats from API
    fetchJSON('/api/polymarket/intents/stats').then(stats => {
      if (probesEl)   probesEl.textContent = stats.probes ?? probes;
      if (confsEl)    confsEl.textContent  = stats.confirms ?? confirms;
      if (convsEl)    convsEl.textContent  = stats.convictions ?? convictions;
      if (trackedEl)  trackedEl.textContent = fmt$(stats.total_usd ?? totalUsd) + ' tracked';
    }).catch(() => {});

    const LEVEL_ORDER = { CONVICTION: 0, CONFIRM: 1, PROBE: 2 };
    const sorted = [...filtered].sort((a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9));

    if (!sorted.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="td-dim" style="text-align:center;padding:32px">No intent records</td></tr>';
      return;
    }

    tbody.innerHTML = sorted.map(r => {
      const levelBadge = r.level === 'PROBE'
        ? '<span class="b b-probe">PROBE</span>'
        : r.level === 'CONFIRM'
        ? '<span class="b b-confirm">CONFIRM</span>'
        : '<span class="b b-conv">CONVICTION</span>';

      const sideBadge = (r.side === 'YES' || r.side === 'BUY')
        ? '<span class="b b-yes">BUY</span>'
        : '<span class="b b-no">SELL</span>';

      const mktCell = r.market_id
        ? `<a href="https://polymarket.com/event/${esc(r.market_id)}" target="_blank" class="mkt-link">${esc(r.market_title || r.market_id.slice(0, 10) + '…')}</a>`
        : '—';

      const marketIdShort = r.market_id ? esc(r.market_id.slice(0, 10) + '…') : '—';

      return `<tr>
        <td class="td-mono" style="color:var(--ind)">${esc(shortWallet(r.wallet))}</td>
        <td class="td-mono td-dim">${marketIdShort}</td>
        <td class="td-main">${mktCell}</td>
        <td>${sideBadge}</td>
        <td>${levelBadge}</td>
        <td style="font-weight:700;color:var(--t1)">${r.trade_count || 0}</td>
        <td class="td-pos">${fmt$(r.total_invested)}</td>
        <td class="td-dim">${fmtTs(r.probe_time)}</td>
        <td class="td-dim">${fmtTs(r.last_trade_time)}</td>
        <td class="td-dim">${fmtExpiry(r.expires_at)}</td>
      </tr>`;
    }).join('');
  }

  // ─── leaderboard ─────────────────────────────────────────────────────────────
  let _lbData = [];
  function clearLeaderboardCache() { _lbData = []; }

  async function renderLeaderboard() {
    const tbody = $('lbTbody');
    if (!tbody) return;

    // fetch on first load or refresh
    if (!_lbData.length) {
      try {
        _lbData = await fetchJSON('/api/polymarket/leaderboard');
      } catch (_) { _lbData = []; }
    }

    const filtered = _lbFilter ? _lbData.filter(p => p.classification === _lbFilter) : _lbData;
    const sorted = [...filtered].sort((a, b) => {
      if (_lbSort === 'smart_money_score') return (b.smart_money_score || 0) - (a.smart_money_score || 0);
      if (_lbSort === 'total_capital')     return (b.total_capital || 0)     - (a.total_capital || 0);
      if (_lbSort === 'markets_tracked')   return (b.markets_tracked || 0)   - (a.markets_tracked || 0);
      return (b.conviction_rate || 0) - (a.conviction_rate || 0); // default
    });

    if (!sorted.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="td-dim" style="text-align:center;padding:32px">No whale activity tracked yet</td></tr>';
      return;
    }

    const medals = ['🥇', '🥈', '🥉'];

    tbody.innerHTML = sorted.map((p, i) => {
      const rank = i + 1;
      const rankCell = rank <= 3
        ? `${medals[rank - 1]} <span style="font-weight:700;color:var(--t1)">${rank}</span>`
        : `<span style="font-weight:600;color:var(--t3);padding-left:16px">${rank}</span>`;

      const smScore = p.smart_money_score ?? '—';
      const smColor = rank <= 3 ? 'var(--cyan)' : 'var(--t2)';

      // conviction rate bar
      const cr = Number(p.conviction_rate) || 0;
      const crColor = cr >= 30 ? 'var(--grn)' : cr >= 10 ? 'var(--amb)' : 'var(--red)';

      const walletAddr = p.wallet || '';
      const nameTag = p.name ? `<span style="color:var(--t3);font-size:10px;margin-left:5px">${esc(p.name)}</span>` : '';

      const typeBadge = p.classification && p.classification !== 'NOISE'
        ? `<span class="b" style="font-size:9px">${esc(p.classification_emoji || '')} ${esc(p.classification)}</span>`
        : `<span style="color:var(--t3);font-size:10px">${esc(p.classification_emoji || '❓')} ${esc(p.classification || 'NOISE')}</span>`;

      const mkts = p.markets_tracked || 0;
      const active = p.active_markets || 0;
      const mktsCell = active > 0
        ? `${mkts} <span style="color:var(--grn);font-size:10px">(${active} active)</span>`
        : String(mkts);

      return `<tr>
        <td>${rankCell}</td>
        <td><span class="td-mono" style="color:var(--ind)">${esc(shortWallet(walletAddr))}</span>${nameTag}</td>
        <td style="color:${smColor};font-weight:800">${smScore}</td>
        <td>
          <div class="winbar">
            <div class="winbar-bg"><div class="winbar-fill" style="width:${Math.min(cr,100)}%;background:${crColor}"></div></div>
            <span style="font-size:11px;font-weight:700;color:${crColor}">${cr}%</span>
          </div>
        </td>
        <td class="td-pos">${fmt$(p.total_capital || 0)}</td>
        <td style="color:var(--t2)">${mktsCell}</td>
        <td>${typeBadge}</td>
      </tr>`;
    }).join('');
  }

  // ─── calibration tab v2 (entry + exit engines) ─────────────────────────────
  let _calData = null;
  let _calSource = 'trader';
  let _calAutoRunTs = 0;          // last auto-trigger timestamp (debounce)
  let _calAutoRunning = false;    // prevent concurrent auto-runs
  const _CAL_AUTO_DEBOUNCE = 30 * 60 * 1000; // 30 minutes debounce

  async function loadCalibrationData() {
    try {
      const resp = await fetch('/api/polymarket/calibration/status');
      const data = await resp.json();
      if (data.error) { console.error('[calibration]', data.error); return; }
      _calData = data;
      renderCalibrationTab(data);

      // Auto-trigger disabled — calibration runs only via "Run now" or "AI advisor" buttons
    } catch (err) {
      console.error('[calibration]', err);
    }
  }

  function _calColor(val, greenMin, amberMin) {
    return val >= greenMin ? 'var(--cal-green)' : val >= amberMin ? 'var(--cal-amber)' : 'var(--cal-red)';
  }

  function _calAssessBadge(assessment) {
    const map = {
      balanced: 'cal-badge-green', balanced_low_confidence: 'cal-badge-amber',
      too_tight: 'cal-badge-red', too_loose: 'cal-badge-amber',
      healthy: 'cal-badge-green', sl_tight: 'cal-badge-amber', sl_loose: 'cal-badge-red',
      tp_unreachable: 'cal-badge-red', tp_low: 'cal-badge-amber',
      watch: 'cal-badge-blue', insufficient_data: 'cal-badge-gray', no_data: 'cal-badge-gray',
    };
    return map[assessment] || 'cal-badge-gray';
  }

  function renderCalibrationTab(data) {
    _calData = data;
    const s = data.state || {};
    const em = data.entry_metrics || {};
    const xm = data.exit_metrics || {};

    // Status bar
    const agoEl = $('calLastRun');
    if (agoEl) {
      if (s.last_run_ts) {
        const h = Math.round((Date.now()/1000 - s.last_run_ts)/3600);
        agoEl.textContent = h > 0 ? h+'h ago' : 'just now';
      } else agoEl.textContent = 'never';
    }
    const nextEl = $('calNextRun');
    if (nextEl) nextEl.textContent = s.next_run_in === 'ready' ? 'ready now' : (s.next_run_in || '—');
    const eaEl = $('calEntryAuto');
    if (eaEl) eaEl.textContent = (s.entry_auto_count||0)+'/'+(s.entry_auto_max||3);
    const xaEl = $('calExitAuto');
    if (xaEl) xaEl.textContent = (s.exit_auto_count||0)+'/'+(s.exit_auto_max||2);
    const pauseBtn = $('calPauseBtn');
    if (pauseBtn) {
      if (s.paused) { pauseBtn.textContent = 'Paused'; pauseBtn.className = 'cal-btn cal-btn-danger'; }
      else { pauseBtn.textContent = 'Active'; pauseBtn.className = 'cal-btn'; }
    }

    renderEntryCard(em);
    renderConvergenceCard(data.convergence_metrics || {});
    renderExitCard(xm);
    renderFilterQuality(data.filter_quality || {});
    renderCounterfactual(data.counterfactual || {});
    renderEntryExitCorrelation(xm);
    renderSlippageAnalysis(xm);
    renderDomainExits(xm);
    _renderCalPending(data.pending);
    _renderCalHistory(data.history);
  }

  function renderEntryCard(m) {
    const card = $('calEntryCard');
    if (!card) return;
    const checks = m.total_checked || 0;
    const positions = m.total_accepted || 0;
    const assessment = m.assessment || 'no_data';
    const passRate = checks > 0 ? (m.pass_rate * 100).toFixed(1) + '%' : '—';
    const winRate = m.closed_trades > 0 ? Math.round(m.wr_total * 100) + '%' : '—';
    const totalRej = m.total_rejected || 0;
    const prColor = checks === 0 ? '' : m.pass_rate < 0.01 ? 'red' : m.pass_rate > 0.10 ? 'amber' : 'teal';
    const wrColor = !m.closed_trades ? '' : m.wr_total >= 0.55 ? 'green' : m.wr_total >= 0.50 ? 'amber' : 'red';

    let bottlenecksHtml = '';
    const bnecks = m.top_bottlenecks || [];
    if (bnecks.length === 0) {
      const rc = m.reject_counts || {};
      const sorted = Object.entries(rc).sort((a,b) => b[1] - a[1]).slice(0, 5);
      if (sorted.length > 0) {
        const maxCount = sorted[0][1];
        bottlenecksHtml = sorted.map(([reason, count], i) => {
          const pct = totalRej > 0 ? (count / totalRej * 100).toFixed(1) : '0';
          const heat = parseFloat(pct) >= 15 ? 'crit' : parseFloat(pct) >= 2 ? 'high' : 'med';
          const barW = Math.round(count / maxCount * 100);
          return `<div class="bneck-row"><span class="bneck-rank">${i+1}</span><span class="bneck-name">${reason.replace(/_/g,' ')}</span><div class="bneck-track"><div class="bneck-fill fill-${heat}" style="width:${barW}%"></div></div><span class="bneck-count">${count}</span><span class="bneck-pct pct-${heat}">${pct}%</span></div>`;
        }).join('');
      }
    } else {
      const maxCount = bnecks[0].count;
      bottlenecksHtml = bnecks.map((b, i) => {
        const heat = b.pct >= 15 ? 'crit' : b.pct >= 2 ? 'high' : 'med';
        const barW = Math.round(b.count / maxCount * 100);
        return `<div class="bneck-row"><span class="bneck-rank">${i+1}</span><span class="bneck-name">${b.label}</span><div class="bneck-track"><div class="bneck-fill fill-${heat}" style="width:${barW}%"></div></div><span class="bneck-count">${b.count}</span><span class="bneck-pct pct-${heat}">${b.pct.toFixed(1)}%</span></div>`;
      }).join('');
    }
    if (!bottlenecksHtml) {
      bottlenecksHtml = '<div class="cal-empty"><div>No rejection data yet<div class="cal-empty-hint">Bottlenecks appear after first trading cycle</div></div></div>';
    } else {
      bottlenecksHtml += `<div class="quiet-line"><b>${m.quiet_filter_count||0}</b> quiet filters · <b>${m.other_rejects||0}</b> other rejects</div>`;
    }
    card.innerHTML = `<div class="cal-card-hdr"><span class="badge b-entry">Entry</span><span class="badge b-status">${assessment.replace(/_/g,' ')}</span><span class="cal-card-sub">${checks} checks, ${positions} positions</span></div><div class="cal-metrics"><div class="cal-metric"><div class="cal-metric-label">Pass rate</div><div class="cal-metric-val ${prColor}">${passRate}</div></div><div class="cal-metric"><div class="cal-metric-label">Win rate</div><div class="cal-metric-val ${wrColor}">${winRate}</div>${m.closed_trades?`<div class="cal-metric-hint">of ${m.closed_trades} closed</div>`:''}</div><div class="cal-metric"><div class="cal-metric-label">Total rejected</div><div class="cal-metric-val red">${totalRej}</div></div></div><div class="cal-sub-label">Top bottlenecks (24h)</div><div class="cal-card-body">${bottlenecksHtml}</div>`;
  }

  function renderConvergenceCard(cm) {
    const card = $('calConvergenceCard');
    if (!card) return;
    const hasData = cm && (cm.conv_signals > 0 || cm.conv_entered > 0);
    if (!hasData) {
      card.innerHTML = `<div class="cal-card-hdr"><span class="badge b-conv">Convergence</span></div><div class="cal-empty"><div>No convergence data yet<div class="cal-empty-hint">Appears when 3+ whales converge on the same market</div></div></div>`;
      return;
    }
    const convWR = cm.conv_entered > 0 ? Math.round(cm.conv_wr*100)+'%' : '—';
    const normalWR = cm.normal_wr > 0 ? Math.round(cm.normal_wr*100)+'%' : '—';
    const blocked = cm.conv_blocked || 0;
    const blockPct = cm.conv_signals > 0 ? Math.round(blocked/cm.conv_signals*100) : 0;
    const convPnl = cm.conv_avg_pnl!=null ? (cm.conv_avg_pnl>=0?'+':'')+'$'+Math.round(cm.conv_avg_pnl) : '—';
    const normalPnl = cm.normal_avg_pnl!=null ? (cm.normal_avg_pnl>=0?'+':'')+'$'+Math.round(cm.normal_avg_pnl) : '—';
    const reasons = cm.conv_block_reasons || {};
    const maxR = Math.max(...Object.values(reasons), 1);
    const reasonsHtml = Object.entries(reasons).sort((a,b)=>b[1]-a[1]).map(([r,c])=>{
      const pct=blocked>0?Math.round(c/blocked*100):0;
      const barW=Math.round(c/maxR*100);
      const clr=pct>=30?'cal-red-text':pct>=10?'cal-amber-text':'t3';
      return `<div class="bar-row"><span class="bar-label">${r.replace(/_/g,' ')}</span><div class="bar-track"><div class="bar-fill" style="width:${barW}%;background:var(--${clr})"></div></div><span class="bar-val">${c}</span><span class="bar-pct">${pct}%</span></div>`;
    }).join('');
    card.innerHTML = `<div class="cal-card-hdr"><span class="badge b-conv">Convergence</span><span class="cal-card-sub">${cm.conv_signals} signals, ${cm.conv_entered} entered</span></div><div class="cal-metrics"><div class="cal-metric"><div class="cal-metric-label">Conv WR</div><div class="cal-metric-val ${cm.conv_wr>=0.55?'green':cm.conv_wr>=0.50?'amber':'red'}">${convWR}</div></div><div class="cal-metric"><div class="cal-metric-label">Normal WR</div><div class="cal-metric-val ${cm.normal_wr>=0.55?'green':cm.normal_wr>=0.50?'amber':cm.normal_wr>0?'red':''}">${normalWR}</div></div><div class="cal-metric"><div class="cal-metric-label">Blocked</div><div class="cal-metric-val red">${blocked}</div><div class="cal-metric-hint">${blockPct}% blocked</div></div></div><div class="cal-split"><div class="cal-split-col"><div class="cal-split-label">Conv avg PnL</div><div class="cal-split-val" style="color:var(--${(cm.conv_avg_pnl||0)>=0?'cal-green-text':'cal-red-text'})">${convPnl}</div></div><div class="cal-split-vs">vs</div><div class="cal-split-col"><div class="cal-split-label">Normal avg PnL</div><div class="cal-split-val" style="color:var(--${(cm.normal_avg_pnl||0)>=0?'cal-green-text':'cal-amber-text'})">${normalPnl}</div></div></div>${reasonsHtml?`<div class="cal-sub-label" style="margin-top:12px">Conv block reasons</div>${reasonsHtml}`:''}`;
  }

  function renderExitCard(xm) {
    const card = $('calExitCard');
    if (!card) return;
    const closed = xm.closed_trades || 0;
    const assessment = xm.assessment || 'no_data';
    const pf = closed > 0 ? xm.profit_factor.toFixed(2) : '—';
    const wl = closed > 0 ? xm.avg_wl_ratio.toFixed(2) : '—';
    const slp = closed > 0 ? Math.round(xm.sl_prematurity_rate*100)+'%' : '—';
    const pfColor = closed===0 ? '' : xm.profit_factor>=1.5 ? 'teal' : xm.profit_factor>=1.0 ? 'amber' : 'red';
    const slpColor = closed===0 ? '' : xm.sl_prematurity_rate>0.35 ? 'red' : xm.sl_prematurity_rate>0.25 ? 'amber' : 'green';

    let exitBarsHtml = '';
    const reasons = xm.exit_reasons || {};
    const sorted = Object.entries(reasons).sort((a,b)=>b[1]-a[1]);
    if (sorted.length > 0) {
      const maxShare = sorted[0][1];
      const exitColors = {sl_hit:'var(--cal-red-text)',tp_hit:'var(--cal-green-text)',trailing:'var(--cal-teal-text)',time_exit:'var(--t3)'};
      exitBarsHtml = sorted.map(([r,share])=>{
        const barW = Math.round(share/maxShare*100);
        const color = exitColors[r] || 'var(--t3)';
        return `<div class="bar-row"><span class="bar-label">${r.replace(/_/g,' ')}</span><div class="bar-track"><div class="bar-fill" style="width:${barW}%;background:${color}"></div></div><span class="bar-val">${Math.round(share*100)}%</span></div>`;
      }).join('');
    } else {
      exitBarsHtml = '<div class="cal-empty" style="min-height:60px"><div>No exit data</div></div>';
    }

    card.innerHTML = `<div class="cal-card-hdr"><span class="badge b-exit">Exit</span><span class="badge b-status">${assessment.replace(/_/g,' ')}</span><span class="cal-card-sub">${closed} closed trades</span></div><div class="cal-metrics"><div class="cal-metric"><div class="cal-metric-label">Profit factor</div><div class="cal-metric-val ${pfColor}">${pf}</div></div><div class="cal-metric"><div class="cal-metric-label">Avg W/L</div><div class="cal-metric-val">${wl}</div>${closed?`<div class="cal-metric-hint">win $${xm.avg_win?xm.avg_win.toFixed(0):0} / loss $${xm.avg_loss?xm.avg_loss.toFixed(0):0}</div>`:''}</div><div class="cal-metric"><div class="cal-metric-label">SL premature</div><div class="cal-metric-val ${slpColor}">${slp}</div><div class="cal-metric-hint">recovered after SL</div></div></div><div class="cal-sub-label">Exit reason distribution</div>${exitBarsHtml}`;
  }

  function renderFilterQuality(fq) {
    const card = $('calFilterQuality');
    if (!card) return;
    const entries = fq ? Object.entries(fq).sort((a,b)=>(b[1].blocked||0)-(a[1].blocked||0)) : [];
    let body = '';
    if (!entries.length) {
      body = '<div class="cal-empty"><div>Waiting for data...<div class="cal-empty-hint">Requires rejected trades with known whale trust scores</div></div></div>';
    } else {
      const rows = entries.map(([r,d])=>{
        const wr=d.avg_whale_wr!=null?Math.round(d.avg_whale_wr*100)+'%':'—';
        const wrC=d.avg_whale_wr==null?'neutral':d.avg_whale_wr>0.58?'pos':d.avg_whale_wr<0.45?'neutral':'neutral';
        const vC=d.verdict==='correct'?'cf-good':d.verdict==='may_be_too_tight'?'cf-bad':'cf-neutral';
        const vL=d.verdict==='correct'?'Correct':d.verdict==='may_be_too_tight'?'May be too tight':d.verdict==='insufficient'?'Low data':'Neutral';
        return `<tr><td style="font-weight:500">${r.replace(/_/g,' ')}</td><td class="mono">${d.blocked||0}</td><td class="mono ${wrC}">${wr}</td><td><span class="cf-verdict ${vC}">${vL}</span></td></tr>`;
      }).join('');
      body = `<table class="qtable"><tr><th>Filter</th><th>Blocked</th><th>Whale avg WR</th><th>Verdict</th></tr>${rows}</table><div style="font-size:10px;color:var(--t3);margin-top:8px">Whale avg WR = trust-based win rate of blocked whales</div>`;
    }
    card.innerHTML = `<div class="cal-card-hdr"><span style="font-size:13px;font-weight:600">Filter quality analysis</span></div><div class="cal-card-body">${body}</div>`;
  }

  function renderCounterfactual(cf) {
    const card = $('calCounterfactual');
    if (!card) return;
    const entries = cf ? Object.entries(cf).sort((a,b)=>(b[1].resolved||0)-(a[1].resolved||0)) : [];
    let body = '';
    if (!entries.length) {
      body = '<div class="cal-empty"><div>Counterfactual data appears after markets resolve (24-48h)<div class="cal-empty-hint">Tracks outcomes of rejected trades via Polymarket API</div></div></div>';
    } else {
      const rows = entries.map(([r,d])=>{
        const pp=d.resolved>0?Math.round(d.would_profit/d.resolved*100):0;
        const pc=pp>60?'pos':pp<35?'neg':'neutral';
        const missed=d.missed_pnl>0?'~$'+Math.round(d.missed_pnl):'—';
        return `<tr><td style="font-weight:500">${r.replace(/_/g,' ')}</td><td class="mono">${d.resolved}</td><td class="mono ${pc}">${d.would_profit} (${pp}%)</td><td class="mono ${pc}">${missed}</td></tr>`;
      }).join('');
      body = `<table class="qtable"><tr><th>Filter</th><th>Resolved</th><th>Would profit</th><th>Missed $</th></tr>${rows}</table><div style="font-size:10px;color:var(--t3);margin-top:8px">Updates every 24h via background job</div>`;
    }
    card.innerHTML = `<div class="cal-card-hdr"><span class="badge b-new">NEW</span><span style="font-size:13px;font-weight:600">Counterfactual: what if we entered?</span></div><div class="cal-card-body">${body}</div>`;
  }

  function renderEntryExitCorrelation(em) {
    const card = $('calEntryExitCorr');
    if (!card) return;
    const byST = em.by_signal_type || {};
    const byCls = em.by_classification || {};
    const hasData = Object.keys(byST).length > 0 || Object.keys(byCls).length > 0;
    if (!hasData) {
      card.innerHTML = `<div class="cal-card-hdr"><span class="badge b-new">NEW</span><span style="font-size:13px;font-weight:600">Entry quality → Exit outcomes</span></div><div class="cal-empty"><div>Requires closed trades to analyze<div class="cal-empty-hint">Groups trades by entry signal type and whale classification</div></div></div>`;
      return;
    }
    const rows = [];
    if (byST.convergence) rows.push(_corrRow('<span class="badge b-conv">Convergence</span>', byST.convergence));
    Object.entries(byCls).sort((a,b)=>(b[1].trades||0)-(a[1].trades||0)).forEach(([cls,d])=>{
      const lbl = cls==='unknown'||cls==='UNKNOWN' ? `<span style="color:var(--t3)">${cls}</span>` : `<span style="font-weight:500">${esc(cls)}</span>`;
      rows.push(_corrRow(lbl, d));
    });
    let insight = '';
    const worst = Object.entries(byCls).find(([c,d])=>d.wr<0.45&&d.trades>=5);
    if (worst) insight = `<div class="insight-box insight-red"><span class="insight-label" style="color:var(--cal-red-text)">Insight:</span> "${worst[0]}" trades have WR ${Math.round(worst[1].wr*100)}%. Consider tightening entry filters.</div>`;
    card.innerHTML = `<div class="cal-card-hdr"><span class="badge b-new">NEW</span><span style="font-size:13px;font-weight:600">Entry quality → Exit outcomes</span></div><table class="qtable"><tr><th>Entry type</th><th>Trades</th><th>WR</th><th>Avg PnL</th><th>TP hit</th><th>SL hit</th></tr>${rows.join('')}</table>${insight}`;
  }
  function _corrRow(lbl, d) {
    const wc=d.wr>=0.55?'pos':d.wr<0.45?'neg':'neutral';
    const pc=(d.avg_pnl||0)>=0?'pos':'neg';
    const pnl=d.avg_pnl!=null?(d.avg_pnl>=0?'+':'')+'$'+Math.round(d.avg_pnl):'—';
    return `<tr><td>${lbl}</td><td class="mono">${d.trades||0}</td><td class="mono ${wc}">${d.wr!=null?Math.round(d.wr*100)+'%':'—'}</td><td class="mono ${pc}">${pnl}</td><td class="mono">${d.tp_rate!=null?Math.round(d.tp_rate*100)+'%':'—'}</td><td class="mono ${(d.sl_rate||0)>0.40?'neg':''}">${d.sl_rate!=null?Math.round(d.sl_rate*100)+'%':'—'}</td></tr>`;
  }

  function renderSlippageAnalysis(em) {
    const card = $('calSlippage');
    if (!card) return;
    const buckets = em.by_slippage_bucket || {};
    const sorted = Object.entries(buckets).sort((a,b)=>parseInt(a[0])-parseInt(b[0]));
    if (!sorted.length) {
      card.innerHTML = `<div class="cal-card-hdr"><span class="badge b-new">NEW</span><span style="font-size:13px;font-weight:600">Entry slippage vs outcome</span></div><div class="cal-empty"><div>Requires closed trades with whale_price and entry_price data</div></div>`;
      return;
    }
    const rows = sorted.map(([b,d])=>{
      const wc=d.wr>=0.55?'pos':d.wr<0.45?'neg':'neutral';
      const pc=(d.avg_pnl||0)>=0?'pos':'neg';
      const pnl=d.avg_pnl!=null?(d.avg_pnl>=0?'+':'')+'$'+Math.round(d.avg_pnl):'—';
      return `<tr><td>${b}</td><td class="mono">${d.trades}</td><td class="mono ${wc}">${Math.round(d.wr*100)}%</td><td class="mono ${pc}">${pnl}</td></tr>`;
    }).join('');
    let suggest = '';
    for (const [b,d] of sorted) { if (d.trades>=5 && d.wr<0.50) { suggest=`<div class="insight-box insight-amber"><span class="insight-label" style="color:var(--cal-amber-text)">Suggestion:</span> Consider lowering MAX_SLIPPAGE to ${parseInt(b)}%. Trades above have lower WR.</div>`; break; } }
    card.innerHTML = `<div class="cal-card-hdr"><span class="badge b-new">NEW</span><span style="font-size:13px;font-weight:600">Entry slippage vs outcome</span></div><table class="qtable"><tr><th>Slippage</th><th>Trades</th><th>WR</th><th>Avg PnL</th></tr>${rows}</table>${suggest}`;
  }

  function renderDomainExits(em) {
    const card = $('calDomainExits');
    if (!card) return;
    const cats = em.exit_by_category || {};
    const entries = Object.entries(cats).sort((a,b)=>(b[1].count||0)-(a[1].count||0));
    if (!entries.length) {
      card.innerHTML = `<div class="cal-card-hdr"><span style="font-size:13px;font-weight:600">Exit patterns by domain</span></div><div class="cal-empty"><div>No domain exit data</div></div>`;
      return;
    }
    const rows = entries.map(([cat,d])=>{
      const sl = Math.round((d.reasons?.sl_hit||0)*100);
      const tp = Math.round((d.reasons?.tp_hit||0)*100);
      return `<tr><td style="font-weight:500">${esc(cat)}</td><td class="mono">${d.count}</td><td class="mono ${sl>40?'neg':''}">${sl}%</td><td class="mono ${tp>30?'pos':''}">${tp}%</td></tr>`;
    }).join('');
    card.innerHTML = `<div class="cal-card-hdr"><span style="font-size:13px;font-weight:600">Exit patterns by domain</span></div><table class="qtable"><tr><th>Domain</th><th>Trades</th><th>SL hit</th><th>TP hit</th></tr>${rows}</table>`;
  }

  function renderPendingReason(reason) {
    const tags = {
      '[Counterfactual]':{cls:'b-teal',label:'Counterfactual'},
      '[Filter Quality]':{cls:'b-purple',label:'Filter Quality'},
      '[Domain]':{cls:'b-coral',label:'Domain'},
      '[Slippage]':{cls:'b-amber',label:'Slippage'},
    };
    let badge='', text=reason||'';
    for (const [prefix,tag] of Object.entries(tags)) {
      if (text.startsWith(prefix)) {
        badge=`<span class="badge ${tag.cls}">${tag.label}</span> `;
        text=text.substring(prefix.length).replace(/^\s*\]?\s*/,'');
        break;
      }
    }
    if (text.match(/^\[AI[:\s]/i)) {
      badge=`<span class="badge b-purple">AI</span> `;
      text=text.replace(/^\[AI[:\s][^\]]*\]\s*/,'');
    }
    return badge + esc(text);
  }

  function _renderCalPending(pending) {
    const el = $('calPendingList');
    const countEl = $('calPendingCount');
    if (!el) return;

    if (!pending || !pending.length) {
      el.innerHTML = '<div class="cal-small">No pending changes</div>';
      if (countEl) countEl.textContent = '0';
      return;
    }

    if (countEl) countEl.textContent = pending.length;
    el.innerHTML = pending.map((p, i) => {
      const srcClass = p.source === 'exit' ? 'cal-badge-exit' : 'cal-badge-entry';
      const srcLabel = p.source || 'entry';
      const botLabel = p.bot || '';
      const botClass = botLabel === 'trader' ? 'cal-badge-green' : 'cal-badge-gray';
      return `
      <div class="cal-pending-item">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div style="flex:1">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
              ${botLabel ? `<span class="cal-badge ${botClass}">${esc(botLabel)}</span>` : ''}
              <span class="cal-badge ${srcClass}">${esc(srcLabel)}</span>
              <strong style="font-size:14px">${esc((p.filter || '').replace(/_/g, ' '))}</strong>
              <span class="cal-badge cal-badge-amber">${p.change_pct > 0 ? '+' : ''}${p.change_pct}%</span>
            </div>
            <div style="font-size:13px;color:var(--t3);margin-bottom:6px">${renderPendingReason(p.reason)}</div>
            <div style="font-size:13px">
              <span class="cal-small">Current: </span><code class="cal-code">${p.current}</code>
              <span class="cal-small" style="margin:0 8px">→</span>
              <span class="cal-small">Proposed: </span><code class="cal-code" style="color:var(--cal-amber-text)">${p.recommended}</code>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button class="cal-btn cal-btn-approve" onclick="calApprove(${i})">Approve</button>
            <button class="cal-btn cal-btn-dismiss" onclick="calReject(${i})">Dismiss</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function _renderCalHistory(history) {
    const el = $('calHistoryTimeline');
    if (!el) return;
    if (!history || !history.length) {
      el.innerHTML = '<div class="cal-timeline-line"></div><div class="cal-small" style="padding-left:30px">No calibration history</div>';
      return;
    }

    const dotColors = {
      auto_apply: 'var(--cal-green)', manual_approve: 'var(--cal-blue)',
      rollback: 'var(--cal-red)', no_change: 'rgba(255,255,255,0.2)',
    };
    const badgeClasses = {
      auto_apply: 'cal-badge-green', manual_approve: 'cal-badge-blue',
      rollback: 'cal-badge-red', no_change: 'cal-badge-gray',
    };

    el.innerHTML = '<div class="cal-timeline-line"></div>' +
      history.slice().reverse().map((h, idx) => {
        const isAi = h.calibration_type === 'ai' || h.direction === 'ai_recommendation';
        const dotColor = isAi ? 'var(--cal-teal)' : (dotColors[h.action] || 'rgba(255,255,255,0.2)');
        const badgeCls = isAi ? 'cal-badge-blue' : (badgeClasses[h.action] || 'cal-badge-gray');
        const label = (h.action || 'unknown').replace(/_/g, ' ');
        const source = h.source || 'entry';
        const srcClass = source === 'exit' ? 'cal-badge-exit' : source === 'both' ? 'cal-badge-gray' : 'cal-badge-entry';
        const hBot = h.bot || '';
        const hBotClass = hBot === 'trader' ? 'cal-badge-green' : '';
        const ago = Math.round((Date.now() / 1000 - (h.ts || 0)) / 3600);
        const hasChange = h.old_value !== null && h.old_value !== undefined;
        const typeBadge = isAi
          ? '<span class="cal-badge cal-badge-amber" style="font-size:10px">AI порада</span>'
          : (h.action !== 'no_change' ? '<span class="cal-badge cal-badge-gray" style="font-size:10px">калібровка</span>' : '');

        return `<div class="cal-timeline-item">
          <div class="cal-timeline-dot" style="background:${dotColor}"></div>
          <div style="flex:1">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
              <span class="cal-badge ${badgeCls}">${esc(label)}</span>
              ${typeBadge}
              ${hBot ? `<span class="cal-badge ${hBotClass}">${esc(hBot)}</span>` : ''}
              <span class="cal-badge ${srcClass}">${esc(source)}</span>
              ${h.filter ? `<strong style="font-size:13px">${esc(h.filter)}</strong>` : ''}
              <span style="font-size:12px;color:var(--t3);margin-left:auto">${ago}h ago</span>
            </div>
            <div style="font-size:12px;color:var(--t3);margin-bottom:3px">${esc(h.reason || '')}</div>
            ${hasChange ? `<div style="display:flex;gap:8px;font-size:12px;align-items:center">
              <code class="cal-code" style="color:var(--t3)">${h.old_value}</code>
              <span style="color:var(--t3)">→</span>
              <code class="cal-code" style="color:var(--cal-green-text)">${h.new_value}</code>
              ${h.rollback_available ? `<button class="cal-btn cal-btn-rollback" onclick="calRollback(${h._log_index != null ? h._log_index : idx})">Rollback</button>` : ''}
            </div>` : ''}
          </div>
        </div>`;
      }).join('');
  }

  async function calApprove(index) {
    await fetch('/api/polymarket/calibration/approve', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ index }),
    });
    loadCalibrationData();
  }
  window.calApprove = calApprove;

  async function calReject(index) {
    await fetch('/api/polymarket/calibration/reject', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ index }),
    });
    loadCalibrationData();
  }
  window.calReject = calReject;

  async function calRollback(logIndex) {
    if (!confirm('Revert this change?')) return;
    const body = logIndex !== undefined ? JSON.stringify({ log_index: logIndex }) : '{}';
    await fetch('/api/polymarket/calibration/rollback', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body,
    });
    loadCalibrationData();
  }
  window.calRollback = calRollback;

  async function calTogglePause() {
    const btn = $('calPauseBtn');
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      await fetch('/api/polymarket/calibration/pause', { method: 'POST' });
      await loadCalibrationData();
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  window.calTogglePause = calTogglePause;

  async function calRunNow() {
    const btn = $('calRunBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
    try {
      await fetch('/api/polymarket/calibration/run', { method: 'POST' });
      await loadCalibrationData();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Run now'; }
    }
  }
  window.calRunNow = calRunNow;

  async function calRunAi() {
    if (!confirm('Run AI advisor? This calls the Claude API.')) return;
    const btn = $('calAiBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
    try {
      const resp = await fetch('/api/polymarket/calibration/ai', { method: 'POST' });
      const result = await resp.json();
      if (result.error) alert('AI advisor error: ' + result.error);
      await loadCalibrationData();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'AI advisor'; }
    }
  }
  window.calRunAi = calRunAi;

  async function calClearHistory() {
    if (!confirm('Clear all calibration history and pending approvals?')) return;
    try {
      const resp = await fetch('/api/polymarket/calibration/clear-history', { method: 'POST' });
      const data = await resp.json();
      console.log('[calibration] Clear history result:', data);
      if (data.error) { alert('Error: ' + data.error); return; }
    } catch (e) {
      console.error('[calibration] Clear history failed:', e);
      alert('Failed to clear history: ' + e.message);
      return;
    }
    await loadCalibrationData();
  }
  window.calClearHistory = calClearHistory;

  function calSwitchSource(src) {
    _calSource = src;
    if (_calData) renderCalibrationTab(_calData);
  }
  window.calSwitchSource = calSwitchSource;

  // ─── bot controls ─────────────────────────────────────────────────────────────
  async function botAction(bot, action) {
    const cap = action.charAt(0).toUpperCase() + action.slice(1);
    const btn = $(`bot${bot}${cap}`);
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    try {
      const resp = await fetch(`/api/polymarket/bots/${bot}/${action}`, { method: 'POST' });
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try { const d = await resp.json(); if (d.error) msg = d.error; } catch {}
        console.error(`[bot] ${bot}/${action}: ${msg}`);
        return;
      }
      setTimeout(() => loadAll(), 1200);
    } catch (err) {
      console.error(`[bot] ${bot}/${action}:`, err.message);
    } finally {
      if (btn) { btn.classList.remove('loading'); }
      // re-enable after loadAll refreshes, or after 3s fallback
      setTimeout(() => { if (btn) btn.disabled = false; }, 3000);
    }
  }

  // ─── wiring ───────────────────────────────────────────────────────────────────
  function wireAll() {
    // Refresh button
    const refreshBtn = $('refreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadAll);

    // Top Up button
    const topUpBtn = $('topUpBtn');
    if (topUpBtn) {
      topUpBtn.addEventListener('click', async () => {
        if (_currentMode === 'live') {
          window.open('https://polymarket.com/', '_blank');
          return;
        }
        topUpBtn.disabled = true;
        try {
          await fetch('/api/polymarket/topup', { method: 'POST' });
          await loadAll();
        } finally {
          topUpBtn.disabled = false;
        }
      });
    }

    // Restart dashboard button
    const restartBtn = $('restartDashboardBtn');
    if (restartBtn) {
      restartBtn.addEventListener('click', async () => {
        restartBtn.disabled = true;
        restartBtn.textContent = '⏳ Restarting…';
        try {
          await fetch('/api/polymarket/dashboard/restart', { method: 'POST' });
        } catch { /* server closes connection on restart — expected */ }
        // Poll until server is back up, then reload
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          try {
            const r = await fetch('/api/polymarket/portfolio');
            if (r.ok) { clearInterval(poll); location.reload(); }
          } catch { /* still restarting */ }
          if (attempts > 20) { clearInterval(poll); restartBtn.disabled = false; restartBtn.textContent = '♻️ Restart Dashboard'; }
        }, 500);
      });
    }

    // Reset & clean button — shows dropdown with two options
    const resetAllBtn = $('pmResetAll');
    const resetMenu   = $('resetMenu');
    if (resetAllBtn && resetMenu) {
      // Toggle menu open/close
      resetAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resetMenu.classList.toggle('hidden');
      });

      // Close menu when clicking outside
      document.addEventListener('click', (e) => {
        if (!resetMenu.contains(e.target) && e.target !== resetAllBtn) {
          resetMenu.classList.add('hidden');
        }
      });

      $('resetCancel').addEventListener('click', () => resetMenu.classList.add('hidden'));

      async function doReset(mode, confirmMsg) {
        if (confirmMsg && !confirm(confirmMsg)) return;
        resetMenu.classList.add('hidden');
        resetAllBtn.disabled = true;
        resetAllBtn.textContent = '⏳ Cleaning...';
        try {
          const resp = await fetch('/api/polymarket/bots/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
          });
          const data = await resp.json();
          if (data.error) { alert(`Error: ${data.error}`); return; }
          const label = data.mode === 'hard' ? 'Hard reset' : 'Soft reset';
          alert(`✅ ${label} complete (${data.deleted || 0} items cleaned). Bots stopped.`);
          clearLeaderboardCache();
          loadAll();
        } catch (err) {
          alert(`Error: ${err.message}`);
        } finally {
          resetAllBtn.disabled = false;
          resetAllBtn.textContent = '❌ Reset & Clean';
        }
      }

      $('resetSoft').addEventListener('click', () => doReset(
        'soft',
        '🔄 Soft Reset — stop trader, reset balance, close open positions.\n\nTrade history & wallet intelligence preserved.\n\nContinue?'
      ));

      $('resetHard').addEventListener('click', () => {
        if (!confirm('⚠️ Hard Reset — stop trader, wipe all trade history, trust scores, decision logs, reject stats & caches.\n\nWallet list, profiles & filter config preserved.\nCannot be undone!\n\nContinue?')) return;
        if (!confirm('⚠️ Are you sure? All position history will be permanently deleted.')) return;
        doReset('hard', null);
      });
    }

    // Risk settings save button
    const riskSaveBtn = $('riskSaveBtn');
    if (riskSaveBtn) riskSaveBtn.addEventListener('click', _saveRiskSettings);

    // Filter buttons
    const filterApplyBtn = $('filterApplyBtn');
    const filterSaveBtn  = $('filterSaveBtn');
    if (filterApplyBtn) filterApplyBtn.addEventListener('click', () => _saveFilterConfig(true));
    if (filterSaveBtn)  filterSaveBtn.addEventListener('click',  () => _saveFilterConfig(true));

    // Filter bot selector
    const filterBotSel = $('filterBotSel');
    if (filterBotSel) {
      filterBotSel.addEventListener('change', () => {
        _selectedBotName = filterBotSel.value;
        renderFilters();
      });
    }

    // Filter preset selector
    const filterPresetSel = $('filterPresetSel');
    if (filterPresetSel) {
      filterPresetSel.addEventListener('change', () => {
        const preset = filterPresetSel.value;
        if (preset) _applyPreset(preset);
      });
    }
    const savePresetBtn = $('filterSavePresetBtn');
    if (savePresetBtn) savePresetBtn.addEventListener('click', _savePreset);
    const restoreBtn = $('filterRestoreBtn');
    if (restoreBtn) restoreBtn.addEventListener('click', async () => {
      if (!confirm('Restore filter config from backup?\nThis will revert to the state before last save.')) return;
      try {
        const mode = _getFilterMode();
        const resp = await fetch('/api/polymarket/filters/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        _filterSavedConfig = data.config || {};
        _filterEdits = {};
        const filtersData = await fetchJSON('/api/polymarket/filters');
        _filters = filtersData;
        renderFilters();
        _flashBtn(restoreBtn, 'Restored!');
      } catch (e) { alert('Restore failed: ' + e.message); }
    });

    // Wallet discovery button — with live progress polling
    const discoverBtn  = $('discoverBtn');
    const discoverStop = $('discoverStopBtn');
    if (discoverBtn) {
      let _discoverPoll = null;

      function _discoverLabel(st) {
        if (!st || !st.running) return '⚡ Run Discovery';
        if (st.phase === 'enriching' && st.total > 0)
          return `⏳ ${st.progress}/${st.total} wallets…`;
        if (st.phase === 'saving') return '⏳ Saving…';
        return '⏳ Running…';
      }

      function _setRunning(yes) {
        discoverBtn.disabled = yes;
        if (discoverStop) discoverStop.classList.toggle('hidden', !yes);
      }

      function _stopDiscoverPoll() {
        if (_discoverPoll) { clearInterval(_discoverPoll); _discoverPoll = null; }
      }

      async function _pollDiscoverStatus() {
        try {
          const st = await fetchJSON('/api/polymarket/wallets/discover/status');
          discoverBtn.textContent = _discoverLabel(st);
          if (!st.running) {
            _stopDiscoverPoll();
            _setRunning(false);
            if (st.phase === 'done') {
              discoverBtn.textContent = `✅ +${st.new_wallets} new (${st.total_wallets} total)`;
              setTimeout(() => { discoverBtn.textContent = '⚡ Run Discovery'; }, 4000);
              loadAll();
            } else if (st.phase === 'stopped') {
              discoverBtn.textContent = '⛔ Stopped';
              setTimeout(() => { discoverBtn.textContent = '⚡ Run Discovery'; }, 3000);
            } else if (st.phase === 'error') {
              discoverBtn.textContent = '⚠️ Error';
              setTimeout(() => { discoverBtn.textContent = '⚡ Run Discovery'; }, 4000);
            }
          }
        } catch { _stopDiscoverPoll(); _setRunning(false); discoverBtn.textContent = '⚡ Run Discovery'; }
      }

      // Check if already running on page load
      (async () => {
        try {
          const st = await fetchJSON('/api/polymarket/wallets/discover/status');
          if (st.running) {
            _setRunning(true);
            discoverBtn.textContent = _discoverLabel(st);
            _discoverPoll = setInterval(_pollDiscoverStatus, 2000);
          }
        } catch { /* ignore */ }
      })();

      discoverBtn.addEventListener('click', async () => {
        const count    = parseInt($('discoverCount')?.value  || '200', 10);
        const source   = $('discoverSource')?.value   || 'all';
        const category = $('discoverCategory')?.value || 'OVERALL';
        _setRunning(true);
        discoverBtn.textContent = '⏳ Starting…';
        try {
          const resp = await fetch('/api/polymarket/wallets/discover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ count, source, category }),
          });
          const data = await resp.json();
          if (resp.status === 409) {
            discoverBtn.textContent = '⏳ Already running…';
            _stopDiscoverPoll();
            _discoverPoll = setInterval(_pollDiscoverStatus, 2000);
            return;
          }
          if (data.error) { alert(`Error: ${data.error}`); _setRunning(false); discoverBtn.textContent = '⚡ Run Discovery'; return; }
          _stopDiscoverPoll();
          _discoverPoll = setInterval(_pollDiscoverStatus, 2000);
        } catch (err) {
          alert('Error: ' + err.message);
          _setRunning(false);
          discoverBtn.textContent = '⚡ Run Discovery';
        }
      });

      // Stop button
      if (discoverStop) {
        discoverStop.addEventListener('click', async () => {
          discoverStop.disabled = true;
          try {
            await fetch('/api/polymarket/wallets/discover/stop', { method: 'POST' });
            _stopDiscoverPoll();
            _setRunning(false);
            discoverBtn.textContent = '⛔ Stopped';
            setTimeout(() => { discoverBtn.textContent = '⚡ Run Discovery'; }, 3000);
          } catch { /* ignore */ } finally {
            discoverStop.disabled = false;
          }
        });
      }
    }

    // Intent filter select
    const intentFilterSel = $('intentFilterSel');
    if (intentFilterSel) {
      intentFilterSel.addEventListener('change', () => {
        _intentFilter = intentFilterSel.value;
        renderIntent();
      });
    }

    // Leaderboard sort buttons
    document.querySelectorAll('.sort-b').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sort-b').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        _lbSort = btn.dataset.sort || 'smart_money_score';
        renderLeaderboard();
      });
    });

    // Leaderboard filter select
    const lbFilterSel = $('lbFilterSel');
    if (lbFilterSel) {
      lbFilterSel.addEventListener('change', () => {
        _lbFilter = lbFilterSel.value;
        renderLeaderboard();
      });
    }

    // Calibration controls are wired via onclick in HTML (calTogglePause, calRunNow, calRunAi)
  }

  // ─── resize chart ─────────────────────────────────────────────────────────────
  window.addEventListener('resize', () => {
    _redrawChart();
  });

  // ─── Sprint 5: Mode + Budget + Kill + Logs + Settings ──────────────────────

  async function loadModeAndBudget() {
    try {
      const [mode, budget, kill] = await Promise.all([
        fetchJSON('/api/polymarket/trading-mode'),
        fetchJSON('/api/polymarket/budget').catch(() => null),
        fetchJSON('/api/polymarket/kill-switch').catch(() => ({active: false})),
      ]);
      _currentMode = mode.mode || 'dry_run';
      _budgetData = budget;
      _killActive = kill.active || false;

      // Mode toggle in header
      const dryBtn = $('modeDryBtn');
      const liveBtn = $('modeLiveBtn');
      if (dryBtn && liveBtn) {
        if (_currentMode === 'live') {
          dryBtn.className = 'mode-opt';
          dryBtn.querySelector('.mode-dot').style.background = 'var(--t3)';
          liveBtn.className = 'mode-opt active-live';
          liveBtn.querySelector('.mode-dot').style.background = 'var(--grn)';
          liveBtn.querySelector('.mode-dot').classList.add('live');
        } else {
          dryBtn.className = 'mode-opt active-dry';
          dryBtn.querySelector('.mode-dot').style.background = 'var(--ind)';
          liveBtn.className = 'mode-opt';
          liveBtn.querySelector('.mode-dot').style.background = 'var(--t3)';
          liveBtn.querySelector('.mode-dot').classList.remove('live');
        }
      }


      // Fetch USDC on-chain balance when live
      const isLive = _currentMode === 'live';
      if (isLive) {
        fetchJSON('/api/polymarket/usdc-balance').then(u => {
          const portfolio = u.portfolio_value || u.balance || 0;
          const cash = u.cash || 0;
          _usdcBalance = portfolio;
          _usdcCash = cash;
          const usdcEl = $('usdcBal');
          if (usdcEl) usdcEl.textContent = portfolio.toFixed(2);
          const chainEl = $('chainUsdc');
          if (chainEl) chainEl.textContent = '$' + cash.toFixed(2);
          renderPortfolio();
        }).catch(() => {});
      } else {
        _usdcBalance = 0;
        _usdcCash = 0;
      }

      // Live-only elements
      const usdcPill = $('usdcPill');
      const killBtn = $('killBtn');
      const onchainCard = $('onchainCard');
      const statsRow = document.querySelector('.stats-row');
      if (usdcPill) usdcPill.style.display = isLive ? '' : 'none';
      if (killBtn) {
        // KILL_SWITCH affects both modes — show button always so user can deactivate
        killBtn.style.display = '';
        killBtn.className = _killActive ? 'kill-btn active' : 'kill-btn';
        killBtn.textContent = _killActive ? 'KILL ON' : 'KILL';
      }
      if (onchainCard) onchainCard.style.display = isLive ? '' : 'none';
      if (statsRow) {
        statsRow.classList.toggle('stats-4', isLive);
      }

      // Budget section: hide in live mode (wallet IS the budget)
      const budgetSec = $('budgetSection');
      if (budgetSec) budgetSec.style.display = isLive ? 'none' : '';

      // Safety / hard limits — always visible (applies to DRY and LIVE alike)
      const safetySec = $('liveSafetySection');
      if (safetySec) safetySec.style.display = '';

      // Update settings sections if visible (skip safety if user has unsaved edits)
      if (_activeTab === 'filters') {
        renderSettingsMode();
        renderSettingsBudget();
        if (!_safetyDirty) renderSettingsLiveSafety();
        _loadExposure();
        renderSettingsExits();
        renderCalibrationProfiles();
      }
    } catch (e) {
      console.error('[loadModeAndBudget]', e);
    }
  }

  async function switchMode(newMode) {
    if (newMode === _currentMode) return;
    const msg = newMode === 'live'
      ? 'Switch to LIVE mode? This will use real USDC on Polymarket.'
      : 'Switch back to DRY RUN mode?';
    if (!confirm(msg)) return;
    try {
      const r = await fetchJSON('/api/polymarket/trading-mode', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({mode: newMode}),
      });
      if (r.error) { alert(r.error); return; }
      _currentMode = newMode;
      loadModeAndBudget();
      loadAll();
    } catch (e) { alert('Failed: ' + e.message); }
  }
  window.switchMode = switchMode;

  function switchModeFromSettings() {
    const newMode = _currentMode === 'live' ? 'dry_run' : 'live';
    switchMode(newMode);
  }
  window.switchModeFromSettings = switchModeFromSettings;

  async function toggleKillSwitch() {
    const action = _killActive ? 'Deactivate kill switch?' : 'ACTIVATE kill switch? All trading will be halted immediately.';
    if (!confirm(action)) return;
    try {
      const r = await fetchJSON('/api/polymarket/kill-switch', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: '{}',
      });
      _killActive = r.active;
      const killBtn = $('killBtn');
      if (killBtn) {
        killBtn.className = _killActive ? 'kill-btn active' : 'kill-btn';
        killBtn.textContent = _killActive ? 'KILL ON' : 'KILL';
      }
    } catch (e) { alert('Failed: ' + e.message); }
  }
  window.toggleKillSwitch = toggleKillSwitch;

  async function saveBudget() {
    const input = $('settingsBudgetInput');
    if (!input) return;
    const val = parseFloat(input.value);
    if (isNaN(val) || val <= 0) { alert('Budget must be positive'); return; }
    try {
      await fetchJSON('/api/polymarket/budget', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({budget_usd: val}),
      });
      // Restart trader so it picks up new budget
      await fetch('/api/polymarket/bots/trader/restart', { method: 'POST' }).catch(() => {});
      setTimeout(() => { loadModeAndBudget(); loadAll(); }, 2000);
    } catch (e) { alert('Failed: ' + e.message); }
  }
  window.saveBudget = saveBudget;

  async function resetBudget() {
    const input = $('settingsBudgetInput');
    const budgetVal = input ? parseFloat(input.value) : 0;
    if (!confirm(`Reset budget to $${budgetVal}?\n\nThis will set available = $${budgetVal}, clear spent/losses/gains.\nDoes NOT restart the bot.`)) return;
    try {
      await fetchJSON('/api/polymarket/budget/reset', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({budget_usd: budgetVal}),
      });
      setTimeout(() => { loadModeAndBudget(); loadAll(); }, 500);
    } catch (e) { alert('Reset failed: ' + e.message); }
  }
  window.resetBudget = resetBudget;

  // ─── Logs (structured events) ───────────────────────────────────────────────

  App.setLogLevel = function (btn, level) {
    _logLevel = level;
    document.querySelectorAll('.log-filter-btn[data-level]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    App.renderLogs();
  };

  App.setLogSource = function (btn, src) {
    _logSource = src;
    document.querySelectorAll('.log-src-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    App.renderLogs();
  };

  function _logEventColor(evt) {
    if (!evt) return 'var(--t2)';
    if (evt.indexOf('failed') >= 0 || evt.indexOf('error') >= 0) return 'var(--red)';
    if (evt.indexOf('filled') >= 0 || evt.indexOf('passed') >= 0 || evt.indexOf('success') >= 0) return 'var(--grn)';
    if (evt.indexOf('triggered') >= 0 || evt.indexOf('degraded') >= 0) return 'var(--amb)';
    if (evt.indexOf('rejected') >= 0) return 'var(--red-soft, var(--amb))';
    return 'var(--cyan)';
  }

  function _logDetail(e) {
    var evt = e.event || '';
    if (evt === 'filter_rejected') return e.reason || '';
    if (evt === 'buy_start' || evt === 'buy_filled') {
      var parts = [];
      if (e.price || e.fill_price) parts.push(((e.fill_price || e.price) * 100).toFixed(1) + '¢');
      if (e.size || e.fill_size) parts.push('×' + (e.fill_size || e.size));
      if (e.cost_usd) parts.push('$' + e.cost_usd.toFixed(2));
      if (e.slippage) parts.push('slip ' + e.slippage.toFixed(1) + '%');
      if (e.latency_ms) parts.push(e.latency_ms + 'ms');
      return parts.join(' · ');
    }
    if (evt === 'buy_failed' || evt === 'sell_failed') return (e.reason || e.error || '') + (e.retry_count ? ' · retry ' + e.retry_count : '');
    if (evt === 'exit_triggered') {
      var p = [];
      if (e.trigger) p.push(e.trigger);
      if (e.pnl_pct != null) p.push('P&L ' + (e.pnl_pct >= 0 ? '+' : '') + e.pnl_pct.toFixed(1) + '%');
      if (e.reason) p.push(e.reason);
      return p.join(' · ');
    }
    if (evt === 'sell_filled') {
      var p = [];
      if (e.exit_price) p.push('exit ' + (e.exit_price * 100).toFixed(1) + '¢');
      if (e.pnl_usd != null) p.push((e.pnl_usd >= 0 ? '+' : '') + '$' + e.pnl_usd.toFixed(2));
      if (e.pnl_pct != null) p.push('(' + (e.pnl_pct >= 0 ? '+' : '') + e.pnl_pct.toFixed(1) + '%)');
      if (e.duration_s) {
        var ds = e.duration_s;
        p.push(ds > 3600 ? (ds / 3600).toFixed(1) + 'h' : ds > 60 ? Math.round(ds / 60) + 'm' : ds + 's');
      }
      return p.join(' · ');
    }
    if (evt === 'calibrator_run') {
      var p = [];
      if (e.mode) p.push(e.mode);
      p.push('checked=' + (e.checked || 0));
      p.push('accepted=' + (e.accepted || 0));
      if (e.bottleneck) p.push('bottleneck: ' + e.bottleneck);
      return p.join(' · ');
    }
    if (evt === 'state_transition') return (e.from_state || '') + ' → ' + (e.to_state || '');
    if (evt === 'mark_degraded' || evt === 'mark_quality_change') return (e.old_quality || '') + ' → ' + (e.new_quality || '');
    return e.reason || e.msg || '';
  }

  App.filterLogByTrade = function (tradeId) {
    var searchEl = $('logSearch');
    if (searchEl) {
      searchEl.value = tradeId;
      App.renderLogs();
    }
  };

  App.copyLogs = function () {
    if (!_logData.length) { App.toast('Нічого копіювати', 'warn'); return; }
    var text = JSON.stringify(_logData, null, 2);
    navigator.clipboard.writeText(text).then(function () {
      App.toast('Скопійовано ' + _logData.length + ' подій як JSON', 'ok', 1500);
    });
  };

  App.clearLogs = async function () {
    if (!confirm('Очистити events.jsonl?')) return;
    var btn = $('clearLogBtn');
    if (btn) btn.disabled = true;
    try {
      await fetch('/api/polymarket/logs/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      App.renderLogs();
    } catch (e) { /* ignore */ }
    finally { if (btn) btn.disabled = false; }
  };

  // ─── Decisions tab ─────────────────────────────────────────────────────────
  async function renderDecisions() {
    const body = $('decBody');
    if (!body) return;
    try {
      const resp = await fetch('/api/polymarket/trade-decisions');
      const data = await resp.json();
      if (Array.isArray(data)) {
        const countEl = $('decCount');
        if (countEl) countEl.textContent = data.length;
        // Sort newest first
        data.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        body.innerHTML = data.map(d => {
          const isEntry = d.type === 'entry';
          const ts = d.ts ? new Date(d.ts * 1000) : null;
          const timeStr = ts ? ts.toLocaleDateString('en-GB', {day:'numeric',month:'short'}) + ' ' + ts.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'}) : '—';
          const typeBadge = isEntry
            ? '<span style="color:#4ecdc4;font-weight:700">ENTRY</span>'
            : '<span style="color:#ff6b6b;font-weight:700">EXIT</span>';
          const market = (d.market || '').length > 50 ? d.market.slice(0, 50) + '…' : (d.market || '—');
          const whale = d.whale_price != null ? d.whale_price.toFixed(3) : '—';
          const mkt = d.market_price != null ? d.market_price.toFixed(3) : '—';
          const fill = (d.fill_price || d.entry_price || d.exit_price);
          const fillStr = fill != null ? Number(fill).toFixed(3) : '—';
          const edge = d.remaining_edge != null ? (d.remaining_edge * 100).toFixed(1) + '%' : '—';
          const edgeColor = d.remaining_edge != null && d.remaining_edge < 0.05 ? 'color:#ff6b6b' : '';
          const reason = d.exit_reason || '—';
          const pnl = d.pnl_amount != null ? (d.pnl_amount >= 0 ? '+' : '') + '$' + d.pnl_amount.toFixed(2) : '—';
          const pnlColor = d.pnl_amount != null ? (d.pnl_amount >= 0 ? 'color:#4ecdc4' : 'color:#ff6b6b') : '';
          const durS = d.duration_s;
          let dur = '—';
          if (durS != null) {
            if (durS < 60) dur = durS + 's';
            else if (durS < 3600) dur = Math.floor(durS / 60) + 'm';
            else dur = Math.floor(durS / 3600) + 'h ' + Math.floor((durS % 3600) / 60) + 'm';
          }
          // Details: collect relevant fields
          const details = [];
          if (d.conviction != null) details.push('conv=' + d.conviction.toFixed(2));
          if (d.trust_score != null) details.push('trust=' + d.trust_score);
          if (d.classification) details.push(d.classification);
          if (d.mark_quality) details.push('mark=' + d.mark_quality);
          if (d.mark_source) details.push('src=' + d.mark_source);
          if (d.signal_type) details.push(d.signal_type);
          if (d.convergence_count) details.push('×' + d.convergence_count + ' whales');
          if (d.pnl_pct != null) details.push(d.pnl_pct.toFixed(1) + '%');
          const detailStr = details.join(' · ') || '—';
          return `<tr>
            <td>${timeStr}</td>
            <td>${typeBadge}</td>
            <td title="${d.market || ''}">${market}</td>
            <td>${whale}</td>
            <td>${mkt}</td>
            <td>${fillStr}</td>
            <td style="${edgeColor}">${edge}</td>
            <td style="font-size:0.85em">${isEntry ? '—' : reason}</td>
            <td style="${pnlColor}">${isEntry ? '—' : pnl}</td>
            <td>${isEntry ? '—' : dur}</td>
            <td style="font-size:0.8em;opacity:0.7">${detailStr}</td>
          </tr>`;
        }).join('');
      }
    } catch (e) {
      body.innerHTML = '<tr><td colspan="11">Error loading decisions</td></tr>';
    }
  }

  App.renderLogs = async function () {
    const body = $('logBody');
    if (!body) return;
    const search = ($('logSearch') || {}).value || '';

    try {
      const params = new URLSearchParams({ limit: '200' });
      if (_logLevel) params.set('level', _logLevel);
      if (_logSource) params.set('source', _logSource);
      if (search) params.set('search', search);
      const entries = await fetchJSON('/api/polymarket/logs?' + params);
      _logData = entries || [];
      const countEl = $('logEntryCount');
      if (countEl) countEl.textContent = (_logData.length || 0) + ' entries';

      body.innerHTML = _logData.map(function (e) {
        var ts = (e.ts || '').slice(11, 23) || '';
        var level = (e.level || 'INFO').toUpperCase();
        var lvlClass = level.indexOf('ERROR') >= 0 || level.indexOf('CRITICAL') >= 0 ? 'ERROR'
          : level.indexOf('WARN') >= 0 ? 'WARNING'
          : level.indexOf('DEBUG') >= 0 ? 'DEBUG' : 'INFO';
        var evt = e.event || '';
        var tid = e.trade_id ? '[' + esc(e.trade_id.substring(0, 8)) + ']' : '';
        var market = e.market ? esc(e.market.substring(0, 50)) : '';

        var detail = _logDetail(e);
        var evtColor = _logEventColor(evt);
        var bgStyle = lvlClass === 'ERROR' ? 'background:rgba(244,63,94,0.05)'
          : lvlClass === 'WARNING' ? 'background:rgba(245,158,11,0.04)' : '';

        return '<div class="log-line" style="' + bgStyle + '">'
          + '<span class="log-ts">' + esc(ts) + '</span> '
          + '<span class="log-level ' + lvlClass + '">' + esc(lvlClass.slice(0, 4)) + '</span> '
          + '<span style="color:' + evtColor + ';font-weight:600;min-width:120px;display:inline-block">' + esc(evt) + '</span> '
          + (tid ? '<span class="log-tid" onclick="App.filterLogByTrade(\'' + esc(e.trade_id || '') + '\')" style="cursor:pointer;color:var(--cyan);font-weight:600">' + tid + '</span> ' : '')
          + (market ? '<span style="color:var(--t2)">' + market + '</span> ' : '')
          + (detail ? '<span style="color:var(--t3)">' + detail + '</span>' : '')
          + '</div>';
      }).join('');
    } catch (e) {
      body.innerHTML = '<div class="log-line"><span class="log-msg" style="color:var(--t3)">Failed to load logs</span></div>';
    }
  };

  // ─── Settings sections ─────────────────────────────────────────────────────

  async function renderSettingsSections() {
    renderSettingsMode();
    renderSettingsBudget();
    renderSettingsLiveSafety();
    _loadExposure();
    renderSettingsExits();
  }

  function renderSettingsMode() {
    const badge = $('settingsModeBadge');
    const body = $('settingsModeBody');
    const switchBtn = $('switchModeBtn');
    if (!body) return;

    const isLive = _currentMode === 'live';
    if (badge) {
      badge.textContent = isLive ? 'LIVE' : 'DRY RUN';
      badge.style.cssText = isLive
        ? 'background:var(--grn-bg);color:var(--grn);border:1px solid rgba(34,197,94,0.2)'
        : 'background:var(--ind-bg);color:var(--ind);border:1px solid rgba(99,102,241,0.22)';
    }
    if (switchBtn) {
      switchBtn.textContent = isLive ? 'Switch to Dry Run' : 'Switch to Live';
      switchBtn.className = isLive ? 'btn btn-primary' : 'btn btn-green';
    }

    body.innerHTML = `
      <div class="mode-cards">
        <div class="mode-card ${isLive ? '' : 'active-dry'}">
          ${isLive ? '' : '<span class="mode-card-check">✓</span>'}
          <div class="mode-card-title"><span class="mode-card-dot" style="background:var(--ind)"></span>Dry Run</div>
          <div class="mode-card-desc">Paper trading. No real orders.</div>
        </div>
        <div class="mode-card ${isLive ? 'active-live' : ''}">
          ${isLive ? '<span class="mode-card-check">✓</span>' : ''}
          <div class="mode-card-title"><span class="mode-card-dot" style="background:var(--grn)"></span>Live</div>
          <div class="mode-card-desc">Real USDC on Polymarket CLOB.</div>
        </div>
      </div>
      <div class="cred-grid" id="credGrid"></div>`;

    // Load credential status
    fetchJSON('/api/polymarket/trading-mode').then(m => {
      const cg = $('credGrid');
      if (!cg) return;
      const required = ['POLY_API_KEY', 'POLY_API_SECRET', 'POLY_API_PASSPHRASE', 'POLY_PRIVATE_KEY', 'POLY_WALLET_ADDRESS'];
      const missing = m.missing_credentials || [];
      cg.innerHTML = required.map(k => {
        const ok = !missing.includes(k);
        return `<div class="cred-item"><span style="color:${ok ? 'var(--grn)' : 'var(--red)'}">${ok ? '✅' : '❌'}</span> ${esc(k)}</div>`;
      }).join('');
      if (m.wallet_preview) {
        cg.innerHTML += `<div class="cred-item"><span style="color:var(--cyan)">◎</span> Wallet: ${esc(m.wallet_preview)}</div>`;
      }
    }).catch(() => {});
  }

  function renderSettingsBudget() {
    const info = $('settingsBudgetInfo');
    const status = $('settingsBudgetStatus');
    const input = $('settingsBudgetInput');
    if (!_budgetData) return;
    const isLive = _currentMode === 'live';

    if (isLive) {
      // LIVE: budget limits how much the bot can risk from the wallet
      const walletTotal = _usdcBalance || 0;
      const budgetUsd = _budgetData.budget_usd || 0;
      const histPnl = _history && _history.summary ? _history.summary.net_pnl || 0 : 0;
      if (info) info.textContent = '$' + budgetUsd.toFixed(0) + ' budget · wallet $' + walletTotal.toFixed(0);
      if (input) input.value = budgetUsd.toFixed(0);
      if (status) {
        const pnlColor = histPnl >= 0 ? 'var(--grn)' : 'var(--red)';
        const pnlStr = (histPnl >= 0 ? '+' : '') + '$' + histPnl.toFixed(2);
        status.innerHTML = `
          <div style="font-size:12px;font-family:var(--fm);color:var(--t1)">Wallet: $${walletTotal.toFixed(2)}</div>
          <div style="font-size:11px;color:${pnlColor};font-family:var(--fm)">${pnlStr} realized PnL</div>`;
      }
    } else {
      // DRY: simulated capital
      if (info) info.textContent = '$' + (_budgetData.remaining_budget || 0).toFixed(0) + ' total · $' + (_budgetData.available || 0).toFixed(0) + ' avail';
      if (input) input.value = (_budgetData.budget_usd || 50).toFixed(0);
      if (status) {
        const dryHint = (_budgetData.budget_usd || 0) <= 0
          ? '<div style="font-size:10px;color:var(--amb);margin-top:4px">⚠️ Set a budget for DRY RUN to work</div>' : '';
        status.innerHTML = `
          <div style="font-size:12px;font-family:var(--fm);color:var(--t1)">$${(_budgetData.available || 0).toFixed(2)} available</div>
          <div style="font-size:11px;color:var(--grn);font-family:var(--fm)">+$${(_budgetData.profit || 0).toFixed(2)} profit</div>${dryHint}`;
      }
    }
  }

  function renderSettingsLiveSafety() {
    const body = $('liveSafetyBody');
    if (!body) return;
    const rs = _riskSettings || {};
    const maxEntry = (rs.MAX_ENTRY_SHARES ?? 10).toFixed(0);
    const maxPos   = (rs.FILTER_MAX_OPEN_POSITIONS ?? 5).toFixed(0);
    const maxExp   = ((rs.MAX_EXPOSURE_PCT ?? 0.30) * 100).toFixed(0);
    const dailyLoss = ((rs.DAILY_LOSS_LIMIT_PCT ?? 0.10) * 100).toFixed(0);
    const timeout  = (rs.ORDER_TIMEOUT_S ?? 30).toFixed(0);
    body.innerHTML = `
      <div class="exposure-monitor" id="exposureMonitor" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;margin-bottom:14px;background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.2);border-radius:8px">
        <div style="display:flex;align-items:center;gap:16px">
          <div>
            <div style="font-size:11px;color:var(--t3);font-family:var(--fm)">Current Exposure</div>
            <div style="display:flex;align-items:baseline;gap:6px">
              <span id="exposureValue" style="font-size:20px;font-weight:700;color:var(--t1);font-family:var(--fm)">--</span>
              <span style="font-size:12px;color:var(--t3);font-family:var(--fm)">USDC</span>
            </div>
          </div>
          <div style="width:1px;height:32px;background:rgba(139,92,246,0.2)"></div>
          <div>
            <div style="font-size:11px;color:var(--t3);font-family:var(--fm)">of limit</div>
            <span id="exposureLimit" style="font-size:14px;font-weight:600;color:var(--t2);font-family:var(--fm)">--</span>
          </div>
          <div style="width:1px;height:32px;background:rgba(139,92,246,0.2)"></div>
          <div>
            <div style="font-size:11px;color:var(--t3);font-family:var(--fm)">Positions</div>
            <span id="exposurePositions" style="font-size:14px;font-weight:600;color:var(--t2);font-family:var(--fm)">--</span>
          </div>
        </div>
        <button class="btn" id="exposureResetBtn" onclick="_resetExposure()" style="font-size:11px;padding:4px 12px;border-color:rgba(139,92,246,0.3);color:rgb(139,92,246)">Reset</button>
      </div>
      <div class="f-grid">
        <div>
          <div class="f-row"><span class="f-label">Max entry shares<small>Hard cap on shares per trade</small></span><div class="f-input-wrap"><input class="f-input" id="safetyMaxEntry" value="${maxEntry}"><span class="f-unit">shares</span></div></div>
          <div class="f-row"><span class="f-label">Max open positions</span><div class="f-input-wrap"><input class="f-input" id="safetyMaxPos" value="${maxPos}"></div></div>
          <div class="f-row"><span class="f-label">Max total exposure<small>% of budget</small></span><div class="f-input-wrap"><input class="f-input" id="safetyMaxExp" value="${maxExp}"><span class="f-unit">%</span></div></div>
        </div>
        <div>
          <div class="f-row"><span class="f-label">Daily loss limit</span><div class="f-input-wrap"><input class="f-input" id="safetyDailyLoss" value="${dailyLoss}"><span class="f-unit">%</span></div></div>
          <div class="f-row"><span class="f-label">Order timeout</span><div class="f-input-wrap"><input class="f-input" id="safetyTimeout" value="${timeout}"><span class="f-unit">sec</span></div></div>
          <div class="f-row"><span class="f-label">Reconciliation interval</span><div class="f-input-wrap"><input class="f-input" value="300" disabled><span class="f-unit">sec</span></div></div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <button class="btn btn-primary" id="safetySaveBtn" onclick="_saveSafetySettings()">Save</button>
        <span id="safetySaveStatus" style="font-size:11px;color:var(--grn)"></span>
      </div>
      <div class="kill-section">
        <div><div class="kill-label-title">Emergency Kill Switch</div><div class="kill-label-desc">Halts all trading instantly.</div></div>
        <button class="kill-big-btn" onclick="toggleKillSwitch()">${_killActive ? 'DEACTIVATE' : 'ACTIVATE'}</button>
      </div>`;
    // Mark dirty when user edits any safety input
    body.querySelectorAll('.f-input').forEach(inp => {
      inp.addEventListener('input', () => { _safetyDirty = true; });
    });
  }

  async function _saveSafetySettings() {
    const btn = $('safetySaveBtn');
    const status = $('safetySaveStatus');
    if (btn) btn.disabled = true;
    if (status) { status.style.color = 'var(--grn)'; status.textContent = ''; }
    try {
      const num = id => { const el = $(id); return el ? parseFloat(el.value) : null; };
      const intNum = id => { const el = $(id); return el ? parseInt(el.value, 10) : null; };
      const updates = {
        MAX_ENTRY_SHARES:          num('safetyMaxEntry') ?? 10,
        FILTER_MAX_OPEN_POSITIONS: intNum('safetyMaxPos') ?? 5,
        MAX_EXPOSURE_PCT:          (num('safetyMaxExp') ?? 30) / 100,
        DAILY_LOSS_LIMIT_PCT:      (num('safetyDailyLoss') ?? 10) / 100,
        ORDER_TIMEOUT_S:           intNum('safetyTimeout') ?? 30,
      };
      const resp = await fetch('/api/polymarket/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      Object.assign(_riskSettings, updates);
      _safetyDirty = false;
      if (btn) {
        const orig = btn.textContent;
        const origBg = btn.style.background;
        const origBorder = btn.style.borderColor;
        btn.textContent = 'Saved';
        btn.style.background = 'var(--grn)';
        btn.style.borderColor = 'var(--grn)';
        btn.style.color = '#000';
        setTimeout(() => {
          btn.textContent = orig;
          btn.style.background = origBg;
          btn.style.borderColor = origBorder;
          btn.style.color = '';
        }, 2000);
      }
    } catch (err) {
      if (btn) {
        const orig = btn.textContent;
        const origBg = btn.style.background;
        const origBorder = btn.style.borderColor;
        btn.textContent = 'Failed';
        btn.style.background = 'var(--red)';
        btn.style.borderColor = 'var(--red)';
        btn.style.color = '#000';
        setTimeout(() => {
          btn.textContent = orig;
          btn.style.background = origBg;
          btn.style.borderColor = origBorder;
          btn.style.color = '';
        }, 2000);
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  window._saveSafetySettings = _saveSafetySettings;

  async function _loadExposure() {
    try {
      const data = await fetchJSON('/api/polymarket/exposure?mode=' + (_currentMode || 'dry_run'));
      if (data.error) return;
      const valEl = $('exposureValue');
      const limEl = $('exposureLimit');
      const posEl = $('exposurePositions');
      if (valEl) {
        const exposed = data.total_exposed || 0;
        const limit = data.max_exposure_usd || 0;
        valEl.textContent = '$' + exposed.toFixed(2);
        // Color: green if under 50% of limit, yellow 50-80%, red >80%
        const ratio = limit > 0 ? exposed / limit : 0;
        valEl.style.color = ratio > 0.8 ? 'var(--red)' : ratio > 0.5 ? '#eab308' : 'var(--grn)';
      }
      if (limEl) limEl.textContent = '$' + (data.max_exposure_usd || 0).toFixed(2);
      if (posEl) posEl.textContent = data.open_positions || 0;
    } catch (e) { /* ignore */ }
  }
  window._loadExposure = _loadExposure;

  async function _resetExposure() {
    if (!confirm('Reset exposure tracking to 0? This resets the spent_usd counter in balance.json.')) return;
    const btn = $('exposureResetBtn');
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch('/api/polymarket/exposure/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      await _loadExposure();
      if (btn) {
        btn.textContent = 'Done';
        setTimeout(() => { btn.textContent = 'Reset'; }, 1500);
      }
    } catch (err) {
      if (btn) {
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Reset'; }, 1500);
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  window._resetExposure = _resetExposure;

  function renderSettingsExits() {
    const body = $('exitSettingsBody');
    if (!body) return;
    const rs = _riskSettings || {};
    const tp   = ((rs.EXIT_TAKE_PROFIT ?? 0.40) * 100).toFixed(0);
    const sl   = ((rs.EXIT_STOP_LOSS ?? -0.25) * 100).toFixed(0);
    const emsl = ((rs.EXIT_STOP_LOSS_EMERGENCY ?? -0.50) * 100).toFixed(0);
    const ceil = (rs.EXIT_CEILING_TP_PRICE ?? 0.97).toFixed(2);
    const trAct = ((rs.EXIT_TRAIL_ACTIVATE ?? 0.15) * 100).toFixed(0);
    const trStp = ((rs.EXIT_TRAIL_STOP ?? 0.10) * 100).toFixed(0);
    const timeH = (rs.EXIT_TIME_BEFORE_RESOLUTION_H ?? 6).toFixed(0);
    const slAge = (rs.MIN_STOP_LOSS_AGE_S ?? 300).toFixed(0);
    body.innerHTML = `
      <div class="f-grid">
        <div>
          <div class="f-row"><span class="f-label">Take profit</span><div class="f-input-wrap"><input class="f-input" id="exitTP" value="${tp}"><span class="f-unit">%</span></div></div>
          <div class="f-row"><span class="f-label">Stop loss</span><div class="f-input-wrap"><input class="f-input" id="exitSL" value="${sl}"><span class="f-unit">%</span></div></div>
          <div class="f-row"><span class="f-label">Emergency stop</span><div class="f-input-wrap"><input class="f-input" id="exitEmSL" value="${emsl}"><span class="f-unit">%</span></div></div>
          <div class="f-row"><span class="f-label">Ceiling TP price</span><div class="f-input-wrap"><input class="f-input" id="exitCeil" value="${ceil}"></div></div>
        </div>
        <div>
          <div class="f-row"><span class="f-label">Trail activate</span><div class="f-input-wrap"><input class="f-input" id="exitTrailAct" value="${trAct}"><span class="f-unit">%</span></div></div>
          <div class="f-row"><span class="f-label">Trail stop</span><div class="f-input-wrap"><input class="f-input" id="exitTrailStp" value="${trStp}"><span class="f-unit">%</span></div></div>
          <div class="f-row"><span class="f-label">Time before resolution</span><div class="f-input-wrap"><input class="f-input" id="exitTimeH" value="${timeH}"><span class="f-unit">hrs</span></div></div>
          <div class="f-row"><span class="f-label">Min SL age</span><div class="f-input-wrap"><input class="f-input" id="exitSlAge" value="${slAge}"><span class="f-unit">sec</span></div></div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-top:12px">
        <button class="btn btn-primary" onclick="_saveExitSettings()">Save</button>
        <span id="exitSaveStatus" style="font-size:12px;color:var(--grn)"></span>
      </div>`;
  }

  async function _saveExitSettings() {
    const status = $('exitSaveStatus');
    if (status) { status.style.color = 'var(--grn)'; status.textContent = ''; }
    try {
      const num = id => { const el = $(id); return el ? parseFloat(el.value) : null; };
      const updates = {
        EXIT_TAKE_PROFIT:       (num('exitTP') ?? 40) / 100,
        EXIT_STOP_LOSS:         (num('exitSL') ?? -25) / 100,
        EXIT_STOP_LOSS_EMERGENCY: (num('exitEmSL') ?? -50) / 100,
        EXIT_CEILING_TP_PRICE:  num('exitCeil') ?? 0.97,
        EXIT_TRAIL_ACTIVATE:    (num('exitTrailAct') ?? 15) / 100,
        EXIT_TRAIL_STOP:        (num('exitTrailStp') ?? 10) / 100,
        EXIT_TIME_BEFORE_RESOLUTION_H: num('exitTimeH') ?? 6,
        MIN_STOP_LOSS_AGE_S:    num('exitSlAge') ?? 300,
      };
      const resp = await fetch('/api/polymarket/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      _riskSettings = data;
      if (status) { status.textContent = '✓ Saved'; setTimeout(() => { status.textContent = ''; }, 2000); }
    } catch (err) {
      if (status) { status.style.color = 'var(--red)'; status.textContent = 'Failed: ' + err.message; }
    }
  }
  window._saveExitSettings = _saveExitSettings;

  async function renderCalibrationProfiles() {
    const body = $('calProfilesBody');
    const footer = $('calProfilesFooter');
    const info = $('calProfilesInfo');
    if (!body) return;

    try {
      const data = await fetchJSON('/api/polymarket/calibration/configs');
      const dry = data.dry || {};
      const live = data.live || {};
      const diffKeys = data.diff_keys || [];
      const allKeys = [...new Set([...Object.keys(dry), ...Object.keys(live)])].sort();
      const activeMode = data.active_mode || 'dry_run';

      if (info) {
        const activeBadge = activeMode === 'live'
          ? '<span class="b b-live" style="font-size:9px">LIVE</span>'
          : '<span class="b b-dry" style="font-size:9px">DRY</span>';
        info.innerHTML = `Active: ${activeBadge} · <span style="font-size:11px;color:var(--t3)">${diffKeys.length} parameters differ</span>`;
      }

      if (!allKeys.length) {
        body.innerHTML = '<div style="padding:16px;color:var(--t3);text-align:center">No calibration profiles configured</div>';
        if (footer) footer.innerHTML = '';
        return;
      }

      // Copy direction: FROM active mode TO other mode
      const fromMode = activeMode;
      const toMode = activeMode === 'live' ? 'dry_run' : 'live';
      const fromLabel = activeMode === 'live' ? 'LIVE' : 'DRY';
      const toLabel = activeMode === 'live' ? 'DRY' : 'LIVE';

      body.innerHTML = `<table class="prof-table">
        <thead><tr>
          <th style="width:30%">Parameter</th>
          <th style="width:22%"><span class="b b-dry" style="font-size:9px">DRY</span> Value</th>
          <th style="width:6%"></th>
          <th style="width:22%"><span class="b b-live" style="font-size:9px">LIVE</span> Value</th>
          <th style="width:10%">Status</th>
          <th style="width:10%"></th>
        </tr></thead>
        <tbody>${allKeys.map(k => {
          const isDiff = diffKeys.includes(k);
          const dv = dry[k] != null ? dry[k] : '—';
          const lv = live[k] != null ? live[k] : '—';
          const arrowDir = activeMode === 'live' ? '←' : '→';
          return `<tr class="${isDiff ? 'diff' : ''}">
            <td><span class="prof-param">${esc(k)}</span></td>
            <td><span class="prof-val${activeMode === 'dry_run' ? ' active' : ''}">${esc(String(dv))}</span></td>
            <td><span style="color:var(--ind);cursor:pointer" onclick="copyCalKey('${esc(k)}','${fromMode}','${toMode}')" title="Copy ${fromLabel} → ${toLabel}">${arrowDir}</span></td>
            <td><span class="prof-val${activeMode === 'live' ? ' active' : ''}">${esc(String(lv))}</span></td>
            <td><span class="b ${isDiff ? 'b-diff' : 'b-same'}">${isDiff ? 'differs' : 'same'}</span></td>
            <td>${isDiff ? `<button class="btn-copy" onclick="copyCalKey('${esc(k)}','${fromMode}','${toMode}')">Copy ${arrowDir}</button>` : ''}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;

      if (footer) {
        footer.innerHTML = `
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary" onclick="copyCalAll('${fromMode}','${toMode}')">Copy ALL ${fromLabel} → ${toLabel}</button>
            <button class="btn btn-ghost" onclick="copyCalAll('${toMode}','${fromMode}')">Copy ALL ${toLabel} → ${fromLabel}</button>
          </div>
          <span style="font-size:11px;color:var(--t3)">Copy creates a backup of the target config</span>`;
      }
    } catch (e) {
      body.innerHTML = '<div style="padding:16px;color:var(--t3);text-align:center">Failed to load profiles</div>';
    }
  }

  async function copyCalKey(key, source, target) {
    try {
      await fetchJSON('/api/polymarket/calibration/copy-key', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({key, source, target}),
      });
      renderCalibrationProfiles();
    } catch (e) { alert('Copy failed: ' + e.message); }
  }
  window.copyCalKey = copyCalKey;

  async function copyCalAll(source, target) {
    if (!confirm(`Copy ALL settings from ${source} to ${target}? A backup will be created.`)) return;
    try {
      await fetchJSON('/api/polymarket/calibration/copy', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source, target}),
      });
      renderCalibrationProfiles();
    } catch (e) { alert('Copy failed: ' + e.message); }
  }
  window.copyCalAll = copyCalAll;

  // ─── init ─────────────────────────────────────────────────────────────────────
  async function init() {
    wireAll();
    // Fetch mode BEFORE loading data so _currentMode is correct
    try {
      const mode = await fetchJSON('/api/polymarket/trading-mode');
      _currentMode = mode.mode || 'dry_run';
    } catch (e) { /* keep default dry_run */ }
    loadAll();
    startAutoRefresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
