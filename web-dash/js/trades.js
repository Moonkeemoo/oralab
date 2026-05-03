/* Ora et Labora — Trades tab (consolidated view) */

(function (App) {
  'use strict';

  const S = App.state;
  const esc = App.esc;
  const fmt$ = App.fmt$;

  // ── State ─────────────────────────────────────────────────────────
  let _tradesData = null;
  let _activeFilter = 'all';  // all | won | lost | open | live | dry
  let _searchQuery = '';
  let _expandedTradeId = null;
  let _expandedEvents = [];  // cached events for restore after re-render

  // ── Exit-price freshness tracking ─────────────────────────────────
  // Підсвітка EXIT ціни показує "вік" ціни — скільки часу минуло з
  // останньої РЕАЛЬНОЇ зміни значення (price-change detection):
  //
  //   0-2с   яскравий amber + glow  — "щойно оновилось"
  //   2-30с  amber плавно fade → dim grey — "ціна старіє"
  //   30с+   червоний, наростає — "STALE, щось зламалось"
  //
  // Ключовий принцип: рефреш без зміни ціни НЕ скидає таймер.
  // Тільки реальна зміна значення (toFixed(3) diff) запускає amber.
  var _priceState = {};  // tid -> { price: string, changedAt: number }
  var _EXIT_FRESH_WINDOW_MS = 30 * 1000;  // 30с — повний fade від amber до dim
  var _lastExitGcAt = 0;

  function _exitFreshnessStyle(tid, price, isOpen, serverTs) {
    if (!isOpen || price == null || !tid) return null;
    var now = Date.now();
    var key = price.toFixed(3);

    // ── Track price changes ──────────────────────────────────────
    var state = _priceState[tid];
    if (!state) {
      // Вперше бачимо цю позицію — вважаємо ціну "свіжою"
      _priceState[tid] = { price: key, changedAt: now };
      state = _priceState[tid];
    } else if (state.price !== key) {
      // Ціна реально змінилась — скидаємо таймер
      state.price = key;
      state.changedAt = now;
    }

    var age = now - state.changedAt;  // мс з останньої зміни ціни

    // ── Age label для tooltip ────────────────────────────────────
    var ageLabel;
    if (age < 1000) ageLabel = App.t('trades.time_lt_1s');
    else if (age < 60000) ageLabel = App.t('trades.time_s', {n: Math.floor(age / 1000)});
    else {
      var mm = Math.floor(age / 60000);
      var ss = Math.floor((age % 60000) / 1000);
      ageLabel = App.t('trades.time_m_s', {m: mm, s: ss});
    }

    // ── >30с: STALE червоний — ціна довго не рухалась ────────────
    if (age >= _EXIT_FRESH_WINDOW_MS) {
      var overAge = age - _EXIT_FRESH_WINDOW_MS;
      var sat = Math.min(1, overAge / 30000);  // повна насиченість на 60с
      // Dim grey (140,140,150) → red (244,63,94)
      var rr = Math.round(140 + (244 - 140) * sat);
      var rg = Math.round(140 + (63 - 140) * sat);
      var rb = Math.round(150 + (94 - 150) * sat);
      return {
        style: 'color:rgb(' + rr + ',' + rg + ',' + rb + ');font-weight:500',
        title: App.t('trades.price_stale_title', {age: ageLabel})
      };
    }

    // ── 0-30с: amber → dim grey плавний fade ─────────────────────
    // t: 0 (щойно) → 1 (30с без зміни)
    var t = age / _EXIT_FRESH_WINDOW_MS;

    // Перші 2с: яскравий amber з glow
    if (age < 2000) {
      var earlyT = age / 2000;
      // Bright amber (245,158,11) з легким fade
      var r = Math.round(245 - 10 * earlyT);
      var g = Math.round(158 - 10 * earlyT);
      var b = Math.round(11 + 15 * earlyT);
      var weight = age < 500 ? '700' : '600';
      var glow = '';
      if (age < 1000) {
        var glowA = (1 - age / 1000).toFixed(2);
        glow = ';text-shadow:0 0 6px rgba(245,158,11,' + glowA + ')';
      }
      return {
        style: 'color:rgb(' + r + ',' + g + ',' + b + ');font-weight:' + weight + glow,
        title: App.t('trades.price_updated_title', {age: ageLabel})
      };
    }

    // 2-30с: amber (235,148,26) → dim grey (140,140,150)
    var fadeT = (age - 2000) / (_EXIT_FRESH_WINDOW_MS - 2000);  // 0→1
    var ease = Math.sqrt(fadeT);  // ease-in: повільний старт, швидший кінець
    var r = Math.round(235 + (140 - 235) * ease);
    var g = Math.round(148 + (140 - 148) * ease);
    var b = Math.round(26 + (150 - 26) * ease);
    var weight = fadeT < 0.3 ? '600' : '500';
    return {
      style: 'color:rgb(' + r + ',' + g + ',' + b + ');font-weight:' + weight,
      title: 'Ціна оновлена ' + ageLabel + ' тому'
    };
  }

  function _gcExitFreshness(visibleOpenTids) {
    var now = Date.now();
    if (now - _lastExitGcAt < 30000) return;
    _lastExitGcAt = now;
    var keep = {};
    var keepPnl = {};
    for (var i = 0; i < visibleOpenTids.length; i++) {
      var tid = visibleOpenTids[i];
      if (_priceState[tid]) keep[tid] = _priceState[tid];
      if (_pnlState[tid]) keepPnl[tid] = _pnlState[tid];
    }
    _priceState = keep;
    _pnlState = keepPnl;
  }

  // ── PnL change tracking ──────────────────────────────────────────
  // Для відкритих позицій: при зміні PnL показуємо трикутник напрямку
  // ▲ (зелений) коли PnL зріс, ▼ (червоний) коли впав.
  // Підсвітка fade 3 секунди, потім тільки трикутник залишається 10с.
  var _pnlState = {};  // tid -> { pnl: string, dir: 'up'|'down'|null, changedAt: number }
  var _PNL_GLOW_MS = 3000;      // яскрава підсвітка при зміні
  var _PNL_ARROW_MS = 10000;    // трикутник тримається довше

  function _pnlChangeInfo(tid, pnl, isOpen) {
    if (!isOpen || pnl == null || !tid) return null;
    var now = Date.now();
    var key = pnl.toFixed(2);

    var state = _pnlState[tid];
    if (!state) {
      _pnlState[tid] = { pnl: key, dir: null, changedAt: 0 };
      return null;
    }

    if (state.pnl !== key) {
      var oldVal = parseFloat(state.pnl);
      var newVal = parseFloat(key);
      state.dir = newVal > oldVal ? 'up' : newVal < oldVal ? 'down' : state.dir;
      state.pnl = key;
      state.changedAt = now;
    }

    if (!state.dir || !state.changedAt) return null;

    var age = now - state.changedAt;
    if (age > _PNL_ARROW_MS) {
      state.dir = null;  // expired
      return null;
    }

    var isUp = state.dir === 'up';
    var arrow = isUp ? '▲' : '▼';
    // Green: rgb(34,197,94)  Red: rgb(244,63,94)
    var baseR = isUp ? 34 : 244;
    var baseG = isUp ? 197 : 63;
    var baseB = isUp ? 94 : 94;

    // Glow phase: 0-3s bright colored highlight
    if (age < _PNL_GLOW_MS) {
      var t = age / _PNL_GLOW_MS;
      var opacity = 1 - t * 0.6;  // 1.0 → 0.4
      return {
        arrow: arrow,
        arrowStyle: 'color:rgb(' + baseR + ',' + baseG + ',' + baseB + ');opacity:' + opacity.toFixed(2),
        cellGlow: 'text-shadow:0 0 8px rgba(' + baseR + ',' + baseG + ',' + baseB + ',' + (0.5 * (1 - t)).toFixed(2) + ')',
      };
    }

    // Arrow-only phase: 3-10s, fading arrow, no cell glow
    var fadeT = (age - _PNL_GLOW_MS) / (_PNL_ARROW_MS - _PNL_GLOW_MS);
    var arrowOpacity = Math.max(0.2, 1 - fadeT);
    return {
      arrow: arrow,
      arrowStyle: 'color:rgb(' + baseR + ',' + baseG + ',' + baseB + ');opacity:' + arrowOpacity.toFixed(2),
      cellGlow: null,
    };
  }

  // ── Load ──────────────────────────────────────────────────────────
  App.loadTrades = async function () {
    try {
      const resp = await fetch('/api/polymarket/trades?include_events=false');
      _tradesData = await resp.json();
      S.trades = _tradesData;
      renderTrades();
    } catch (e) {
      console.error('[TRADES] load error:', e);
    }
  };

  // ── Phase B (L24 follow-up): live-marks 1 Hz poll ─────────────────
  // Patches `_tradesData.trades[i].exit.price` + `last_price_update_ts`
  // + `mark_source` IN PLACE for open positions using /api/live-marks
  // (a cheap mtime-cached read of ws_state.json). We do NOT re-run the
  // heavy loadTrades() — this would reload history, PnL, etc. Instead
  // we only touch the Exit column fields that the freshness dot and
  // mark-source badge depend on, then let the existing 1s local ticker
  // (setInterval → renderTrades) repaint with the new values.
  //
  // Rate: 1s. CLOB headroom is not a concern — this call is local
  // Flask + DATA_DIR read, not network. ws_feed flush cadence ~100ms,
  // so at 1 Hz we get ≤10× staleness in the worst case; still well
  // under the 30s Exit SLO.
  //
  // Gated on activeTab === 'trades' AND having open positions, so
  // background tabs don't spin the poll.
  App._liveMarksTimer = null;
  App._liveMarksInFlight = false;

  // ── Auto-poke for stale marks ────────────────────────────────────
  // If WS feed stops delivering for a specific token, the normal
  // live-marks poll will show stale data (age_s > 30s). Auto-poke
  // hits REST CLOB directly through /api/poke-mark to get a fresh
  // price. Throttled to 1 poke per token per 15s.
  var _pokeThrottle = {};  // asset_id → last poke timestamp (ms)

  async function _pokeStaleToken(trade) {
    if (!trade || !trade.asset_id) return;
    try {
      var resp = await fetch(
        '/api/polymarket/poke-mark?token_id=' + encodeURIComponent(trade.asset_id),
        { cache: 'no-store' }
      );
      if (!resp.ok) return;
      var payload = await resp.json();
      var pokeMk = payload && payload.marks && payload.marks[trade.asset_id];
      if (!pokeMk) return;

      // Apply poked mark to the trade object (same logic as main poll)
      var livePrice = null;
      if (typeof pokeMk.best_bid === 'number' && pokeMk.best_bid > 0) {
        livePrice = pokeMk.best_bid;
      } else if (typeof pokeMk.mid === 'number' && pokeMk.mid > 0) {
        livePrice = pokeMk.mid;
      } else if (typeof pokeMk.last_trade === 'number' && pokeMk.last_trade > 0) {
        livePrice = pokeMk.last_trade;
      }
      if (livePrice == null) return;

      // Anomaly guard
      var entryPrice = (trade.entry && (trade.entry.fill_price || trade.entry.price)) || 0;
      if (livePrice < 0.02 && entryPrice > 0.10) return;

      if (!trade.exit || typeof trade.exit !== 'object') trade.exit = {};
      trade.exit.price = livePrice;
      if (typeof pokeMk.ts === 'number' && pokeMk.ts > 0) {
        trade.exit.last_price_update_ts = pokeMk.ts;
      }
      trade.exit.mark_source = 'rest_poke';
      renderTrades();
    } catch (e) {
      // Silently swallow — poke is best-effort
    }
  }

  async function _pollLiveMarks() {
    if (App._liveMarksInFlight) return;
    if (!_tradesData || !Array.isArray(_tradesData.trades)) return;
    var openTrades = _tradesData.trades.filter(function (t) {
      return t.status === 'open' && t.asset_id;
    });
    if (!openTrades.length) return;

    var assetIds = openTrades.map(function (t) { return t.asset_id; }).join(',');
    App._liveMarksInFlight = true;
    try {
      var resp = await fetch(
        '/api/polymarket/live-marks?asset_ids=' + encodeURIComponent(assetIds),
        { cache: 'no-store' }
      );
      if (!resp.ok) return;
      var payload = await resp.json();
      var marks = (payload && payload.marks) || {};
      var touched = false;
      for (var i = 0; i < openTrades.length; i++) {
        var trade = openTrades[i];
        var mk = marks[trade.asset_id];
        if (!mk) continue;
        // Best available live exit price: prefer bid (what we'd sell at),
        // fall back to mid, then last trade. This mirrors the marks.py
        // dual-mark contract — liquidation_mark = best bid.
        var livePrice = null;
        if (typeof mk.best_bid === 'number' && mk.best_bid > 0) {
          livePrice = mk.best_bid;
        } else if (typeof mk.mid === 'number' && mk.mid > 0) {
          livePrice = mk.mid;
        } else if (typeof mk.last_trade === 'number' && mk.last_trade > 0) {
          livePrice = mk.last_trade;
        }
        if (livePrice == null) continue;

        // ── Anomaly guard: reject near-zero marks on non-cheap entries ──
        // During WS reconnects, all tokens may simultaneously show
        // bid=0.01 (dead/stale book). If the entry price is >> 0.10
        // and the live mark is < 0.02, this is clearly anomalous —
        // keep the previous exit.price rather than flashing 0.010.
        var entryPrice = (trade.entry && (trade.entry.fill_price || trade.entry.price)) || 0;
        if (livePrice < 0.02 && entryPrice > 0.10) {
          // Mark as stale so freshness dot shows warning, but don't
          // overwrite the price — existing value is more accurate.
          if (mk.source) trade.exit.mark_source = mk.source;
          continue;
        }

        if (!trade.exit || typeof trade.exit !== 'object') trade.exit = {};
        // Only overwrite exit.price for OPEN positions. Closed trades
        // have their final exit.price locked in by the backend and
        // must not be touched here.
        trade.exit.price = livePrice;
        if (typeof mk.ts === 'number' && mk.ts > 0) {
          trade.exit.last_price_update_ts = mk.ts;
        }
        if (mk.source) {
          trade.exit.mark_source = mk.source;  // "ws_book" | "ws_price"
        }
        touched = true;
      }
      // Let the 1s local ticker pick up the patched in-memory values
      // on its next repaint. If the ticker isn't running (e.g. tab
      // was just opened and no render has happened yet), force one
      // render now so the user doesn't see a 1s gap.
      if (touched) {
        renderTrades();
      }

      // ── Auto-poke: for stale positions (age > 30s), hit REST directly ──
      // Throttle: at most 1 poke per position per 15s to avoid hammering.
      var now = Date.now();
      for (var pi = 0; pi < openTrades.length; pi++) {
        var pokeTrade = openTrades[pi];
        var pokeMk = marks[pokeTrade.asset_id];
        if (!pokeMk) continue;
        if (typeof pokeMk.age_s !== 'number' || pokeMk.age_s < 30) continue;
        var pokeKey = pokeTrade.asset_id;
        var lastPoke = _pokeThrottle[pokeKey] || 0;
        if (now - lastPoke < 15000) continue;  // 15s cooldown per token
        _pokeThrottle[pokeKey] = now;
        _pokeStaleToken(pokeTrade);
      }
    } catch (e) {
      // Swallow — this is a background enhancement, not a control
      // surface. Console warn only to avoid toast spam on ws_feed
      // restarts.
      console.warn('[TRADES] live-marks poll error:', e && e.message);
    } finally {
      App._liveMarksInFlight = false;
    }
  }

  function _startLiveMarksPoll() {
    if (App._liveMarksTimer) return;
    // 1 Hz — matches ws_feed flush cadence (~100ms) well enough and
    // halves the staleness window vs the main 2s /state poll.
    App._liveMarksTimer = setInterval(_pollLiveMarks, 1000);
  }

  function _stopLiveMarksPoll() {
    if (App._liveMarksTimer) {
      clearInterval(App._liveMarksTimer);
      App._liveMarksTimer = null;
    }
  }

  _startLiveMarksPoll();

  // ── Render Summary Strip ──────────────────────────────────────────
  function renderSummary() {
    const s = _tradesData && _tradesData.summary;
    if (!s) return;

    const pnlEl = document.getElementById('trPnl');
    const wrEl = document.getElementById('trWR');
    const durEl = document.getElementById('trDur');
    const winsEl = document.getElementById('trWins');
    const lossesEl = document.getElementById('trLosses');
    const openEl = document.getElementById('trOpen');

    if (pnlEl) {
      const pnl = s.net_pnl || 0;
      pnlEl.textContent = (pnl >= 0 ? '+' : '') + fmt$(pnl);
      pnlEl.className = 'tr-val ' + (pnl >= 0 ? 'pos' : 'neg');
    }

    if (wrEl) {
      const wr = s.win_rate || 0;
      const wins = s.wins || 0;
      const total = (s.wins || 0) + (s.losses || 0);
      wrEl.textContent = wins + '/' + total + ' (' + wr + '%)';
      wrEl.style.color = wr >= 50 ? 'var(--grn)' : wr > 0 ? 'var(--red)' : '';
    }

    if (durEl) {
      var sec = s.avg_duration_seconds || 0;
      durEl.textContent = sec > 3600 ? Math.round(sec / 3600) + 'h' : Math.round(sec / 60) + 'm';
    }

    if (winsEl) {
      winsEl.textContent = s.wins != null ? s.wins : '—';
      winsEl.className = 'tr-val pos';
    }

    if (lossesEl) {
      lossesEl.textContent = s.losses != null ? s.losses : '—';
      lossesEl.className = 'tr-val neg';
    }

    if (openEl) {
      openEl.textContent = s.open != null ? s.open : '—';
    }

    // ── Price freshness metric ─────────────────────────────────────
    _updateFreshnessMetric();
  }

  // Freshness sparkline history: ring buffer of median mark ages (one sample per render)
  // Uses server-side last_price_update_ts — measures data pipeline health,
  // NOT price-change age. Flat market with live marks = green.
  var _freshnessHistory = [];
  var _FRESHNESS_HISTORY_MAX = 150;  // ~150 samples × ~2s render = ~5 minutes window

  function _updateFreshnessMetric() {
    var freshEl = document.getElementById('trFreshness');
    var chartEl = document.getElementById('trFreshnessChart');
    if (!freshEl) return;

    // Compute median MARK age across all open positions (server ts based)
    var trades = (_tradesData && _tradesData.trades) || [];
    var ages = [];
    var now = Date.now();
    for (var i = 0; i < trades.length; i++) {
      var t = trades[i];
      if (t.status !== 'open' && t.status !== 'dry_filled') continue;
      var srvTs = (t.exit && t.exit.last_price_update_ts) || null;
      if (srvTs && srvTs > 0) {
        var srvMs = srvTs > 1e12 ? srvTs : srvTs * 1000;
        ages.push(Math.max(0, now - Math.min(srvMs, now)));
      }
    }

    if (!ages.length) {
      freshEl.textContent = '—';
      freshEl.className = 'tr-val';
      return;
    }

    // Median
    ages.sort(function (a, b) { return a - b; });
    var mid = Math.floor(ages.length / 2);
    var median = ages.length % 2 ? ages[mid] : (ages[mid - 1] + ages[mid]) / 2;
    var medianS = median / 1000;

    // Also compute max (worst position)
    var maxAge = ages[ages.length - 1] / 1000;

    // Format
    var label;
    if (medianS < 60) label = App.t('trades.time_s', {n: Math.round(medianS)});
    else label = App.t('trades.time_m_s', {m: Math.floor(medianS / 60), s: Math.round(medianS % 60)});

    // Stale count
    var staleCount = 0;
    for (var j = 0; j < ages.length; j++) {
      if (ages[j] > 30000) staleCount++;
    }

    freshEl.textContent = label;
    // Color: green <10s, amber 10-30s, red >30s
    if (medianS < 10) {
      freshEl.className = 'tr-val';
      freshEl.style.color = 'var(--grn)';
    } else if (medianS < 30) {
      freshEl.className = 'tr-val';
      freshEl.style.color = 'rgb(245,158,11)';
    } else {
      freshEl.className = 'tr-val';
      freshEl.style.color = 'var(--red)';
    }

    // Tooltip with details
    freshEl.parentElement.title = App.t('trades.freshness_title', {
      median: label, max: Math.round(maxAge), stale: staleCount, total: ages.length
    });

    // Push to sparkline history
    _freshnessHistory.push(medianS);
    if (_freshnessHistory.length > _FRESHNESS_HISTORY_MAX) {
      _freshnessHistory.shift();
    }

    // Draw sparkline
    if (chartEl) _drawFreshnessSparkline(chartEl);
  }

  function _drawFreshnessSparkline(canvas) {
    var ctx = canvas.getContext('2d');
    var w = canvas.width;
    var h = canvas.height;
    var data = _freshnessHistory;
    if (data.length < 2) { ctx.clearRect(0, 0, w, h); return; }

    ctx.clearRect(0, 0, w, h);

    // Scale: 0 to max(60, max_value) so 30s threshold line is visible
    var maxVal = 0;
    for (var i = 0; i < data.length; i++) {
      if (data[i] > maxVal) maxVal = data[i];
    }
    maxVal = Math.max(60, maxVal);

    var stepX = w / (_FRESHNESS_HISTORY_MAX - 1);

    // 30s threshold line (dashed)
    var threshY = h - (30 / maxVal) * h;
    ctx.strokeStyle = 'rgba(244,63,94,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, threshY);
    ctx.lineTo(w, threshY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Fill area under curve with gradient
    var startIdx = _FRESHNESS_HISTORY_MAX - data.length;
    ctx.beginPath();
    for (var i = 0; i < data.length; i++) {
      var x = (startIdx + i) * stepX;
      var y = h - (data[i] / maxVal) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    // Close area
    var lastX = (startIdx + data.length - 1) * stepX;
    ctx.lineTo(lastX, h);
    ctx.lineTo(startIdx * stepX, h);
    ctx.closePath();

    // Gradient fill based on last value
    var lastVal = data[data.length - 1];
    var fillColor;
    if (lastVal < 10) fillColor = 'rgba(34,197,94,0.15)';
    else if (lastVal < 30) fillColor = 'rgba(245,158,11,0.15)';
    else fillColor = 'rgba(244,63,94,0.15)';
    ctx.fillStyle = fillColor;
    ctx.fill();

    // Line
    ctx.beginPath();
    for (var i = 0; i < data.length; i++) {
      var x = (startIdx + i) * stepX;
      var y = h - (data[i] / maxVal) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (lastVal < 10) ctx.strokeStyle = 'rgb(34,197,94)';
    else if (lastVal < 30) ctx.strokeStyle = 'rgb(245,158,11)';
    else ctx.strokeStyle = 'rgb(244,63,94)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Dot on last point
    var dotX = lastX;
    var dotY = h - (lastVal / maxVal) * h;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }

  // ── Per-position PRICE HISTORY sparkline ──────────────────────────
  // Ring buffer per trade_id: stores actual exit price values each render
  // tick (~1s). 120 samples ≈ 2 min window. Shows whether the market is
  // active (price moving) or dead (flat line).
  var _posPriceHistory = {};  // tid -> number[]
  var _POS_PRICE_MAX = 180;  // ~180 samples × ~1s render = ~3 min window

  function _pushPosPriceData() {
    var trades = (_tradesData && _tradesData.trades) || [];
    var activeIds = {};
    for (var i = 0; i < trades.length; i++) {
      var t = trades[i];
      if (t.status !== 'open') continue;
      var tid = t.trade_id;
      if (!tid) continue;
      activeIds[tid] = true;

      var price = (t.exit && t.exit.price != null) ? t.exit.price : null;
      if (price == null || price <= 0) continue;

      if (!_posPriceHistory[tid]) _posPriceHistory[tid] = [];
      var buf = _posPriceHistory[tid];
      buf.push(price);
      if (buf.length > _POS_PRICE_MAX) buf.shift();
    }
    // GC closed positions
    for (var k in _posPriceHistory) {
      if (!activeIds[k]) delete _posPriceHistory[k];
    }
  }

  function _drawPosPriceSparklines() {
    var canvases = document.querySelectorAll('canvas.pos-freshness-spark');
    for (var ci = 0; ci < canvases.length; ci++) {
      var canvas = canvases[ci];
      var tid = canvas.getAttribute('data-tid');
      var entryPrice = parseFloat(canvas.getAttribute('data-entry') || '0');
      var data = _posPriceHistory[tid];
      _drawPosPriceSpark(canvas, data, entryPrice);
    }
  }

  function _drawPosPriceSpark(canvas, data, entryPrice) {
    var ctx = canvas.getContext('2d');
    var cw = canvas.width;
    var h = canvas.height;
    var labelW = 28;       // right margin reserved for age label
    var w = cw - labelW;   // chart area width

    if (!data || data.length < 2) {
      ctx.clearRect(0, 0, cw, h);
      ctx.fillStyle = 'rgba(140,140,150,0.5)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('—', cw / 2, h / 2 + 3);
      return;
    }

    ctx.clearRect(0, 0, cw, h);

    // Scale Y: tight around data range with padding
    var minVal = data[0], maxVal = data[0];
    for (var i = 1; i < data.length; i++) {
      if (data[i] < minVal) minVal = data[i];
      if (data[i] > maxVal) maxVal = data[i];
    }
    if (entryPrice > 0) {
      if (entryPrice < minVal) minVal = entryPrice;
      if (entryPrice > maxVal) maxVal = entryPrice;
    }
    var range = maxVal - minVal;
    if (range < 0.002) range = 0.002;
    var pad = range * 0.15;
    var yMin = minVal - pad;
    var yMax = maxVal + pad;
    var yRange = yMax - yMin;

    var stepX = w / (_POS_PRICE_MAX - 1);
    var startIdx = _POS_PRICE_MAX - data.length;

    // Entry price reference line (dashed, dim) — chart area only
    if (entryPrice > 0 && entryPrice >= yMin && entryPrice <= yMax) {
      var epY = h - ((entryPrice - yMin) / yRange) * h;
      ctx.strokeStyle = 'rgba(140,140,150,0.3)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, epY);
      ctx.lineTo(w, epY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    var lastVal = data[data.length - 1];
    var isUp = lastVal >= (entryPrice > 0 ? entryPrice : data[0]);

    // Fill area between line and entry price (or bottom)
    ctx.beginPath();
    for (var i = 0; i < data.length; i++) {
      var x = (startIdx + i) * stepX;
      var y = h - ((data[i] - yMin) / yRange) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    var lastX = (startIdx + data.length - 1) * stepX;
    if (entryPrice > 0) {
      var epFillY = h - ((entryPrice - yMin) / yRange) * h;
      ctx.lineTo(lastX, epFillY);
      ctx.lineTo(startIdx * stepX, epFillY);
    } else {
      ctx.lineTo(lastX, h);
      ctx.lineTo(startIdx * stepX, h);
    }
    ctx.closePath();
    ctx.fillStyle = isUp ? 'rgba(34,197,94,0.12)' : 'rgba(244,63,94,0.12)';
    ctx.fill();

    // Price line
    var lineColor = isUp ? 'rgb(34,197,94)' : 'rgb(244,63,94)';
    ctx.beginPath();
    for (var i = 0; i < data.length; i++) {
      var x = (startIdx + i) * stepX;
      var y = h - ((data[i] - yMin) / yRange) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Dot on last point
    var dotY = h - ((lastVal - yMin) / yRange) * h;
    ctx.beginPath();
    ctx.arc(lastX, dotY, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();

    // ── Age label: right of chart, vertically aligned with last dot ──
    // Use price-change age from _priceState (how long since price moved)
    var tid = canvas.getAttribute('data-tid');
    var st = _priceState[tid];
    var ageMs = (st && st.changedAt > 0) ? (Date.now() - st.changedAt) : 0;
    var ageLabel;
    if (ageMs < 1000) ageLabel = App.t('trades.time_lt_1s');
    else if (ageMs < 60000) ageLabel = App.t('trades.time_s', {n: Math.floor(ageMs / 1000)});
    else ageLabel = App.t('trades.time_m', {n: Math.floor(ageMs / 60000)});

    // Color: match freshness semantics
    var ageSec = ageMs / 1000;
    var labelColor;
    if (ageSec < 10) labelColor = 'rgb(34,197,94)';
    else if (ageSec < 30) labelColor = 'rgb(245,158,11)';
    else labelColor = 'rgb(244,63,94)';

    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = labelColor;
    // Clamp Y so text doesn't go off canvas edge
    var labelY = Math.max(9, Math.min(h - 2, dotY + 3));
    ctx.fillText(ageLabel, w + 3, labelY);
  }

  // ── Render Table ──────────────────────────────────────────────────
  function renderTrades() {
    if (!_tradesData) return;
    renderSummary();

    const tbody = document.getElementById('tradesTbody');
    if (!tbody) return;

    var trades = _tradesData.trades || [];

    // Apply filters
    if (_activeFilter === 'won') trades = trades.filter(function (t) { return t.result === 'won'; });
    if (_activeFilter === 'lost') trades = trades.filter(function (t) { return t.result === 'lost'; });
    if (_activeFilter === 'open') trades = trades.filter(function (t) { return t.status === 'open'; });
    if (_activeFilter === 'live') trades = trades.filter(function (t) { return t.mode === 'live'; });
    if (_activeFilter === 'dry') trades = trades.filter(function (t) { return t.mode !== 'live'; });

    // Apply search
    if (_searchQuery) {
      var q = _searchQuery.toLowerCase();
      trades = trades.filter(function (t) {
        return ((t.trade_id || '').toLowerCase().indexOf(q) >= 0) ||
               ((t.market || '').toLowerCase().indexOf(q) >= 0);
      });
    }

    // Tab count is rendered by App.renderTabBadges() from the always-fresh
    // S.positions + S.history, so it shows a GLOBAL count and stays live
    // even when this tab is not active. Previously this write would clobber
    // the badge with the post-filter count (e.g. "won only") and freeze it
    // whenever the user navigated away from the trades tab.

    // Render with separate headers for open and closed sections
    var html = '';
    var openTrades = trades.filter(function (t) { return t.status === 'open'; });
    var closedTrades = trades.filter(function (t) { return t.status !== 'open'; });

    // ── Open positions header + rows ──
    if (openTrades.length) {
      html += '<tr class="tr-thead"><th>' + App.t('trades.col_time') + '</th><th>Mode</th>' +
        '<th>' + App.t('trades.col_market') + '</th>' +
        '<th>Side</th>' +
        '<th data-tip="Time until market closes">Resolves</th>' +
        '<th>Entry</th><th>Exit</th>' +
        '<th data-tip="Shares vs MAX_ENTRY_SHARES">Shares</th>' +
        '<th>Cost</th><th>P&amp;L</th>' +
        '<th colspan="2">' + App.t('trades.col_chart') + '</th>' +
        '<th>Dur</th></tr>';
      html += openTrades.map(renderTradeRow).join('');
    }

    // ── Closed positions header + rows ──
    if (closedTrades.length) {
      if (openTrades.length) {
        html += '<tr class="tr-separator"><td colspan="13"><div class="tr-sep-line">' +
          '<span class="tr-sep-label">' + App.t('trades.section_closed', {count: closedTrades.length}) + '</span>' +
          '</div></td></tr>';
      }
      html += '<tr class="tr-thead"><th>' + App.t('trades.col_time') + '</th><th>Mode</th>' +
        '<th>' + App.t('trades.col_market') + '</th>' +
        '<th>Side</th>' +
        '<th data-tip="When the market resolved">Resolves</th>' +
        '<th>Entry</th><th>Exit</th>' +
        '<th data-tip="Shares vs MAX_ENTRY_SHARES">Shares</th>' +
        '<th>Cost</th><th>P&amp;L</th>' +
        '<th>Exit Reason</th>' +
        '<th>Result</th>' +
        '<th>Dur</th></tr>';
      html += closedTrades.map(renderTradeRow).join('');
    }

    tbody.innerHTML = html;

    // Прибираємо застарілі freshness-записи, яких більше немає у відкритих.
    _gcExitFreshness(openTrades.map(function (t) { return t.trade_id; }));

    // Per-position price history sparklines: push data + draw canvases
    _pushPosPriceData();
    _drawPosPriceSparklines();

    // Restore expanded detail if it was open before re-render
    if (_expandedTradeId) {
      _restoreExpanded(_expandedTradeId);
    }
  }

  // Локальний тикер: перерендерює таблицю раз на 1с для плавного
  // fade-ефекту у 30-секундному SLO-вікні (30 кадрів). Між 5-секундними
  // poll-ами даних color інтерполяція йде на клієнті. Тіче завжди коли
  // є відкриті позиції — щоб ring buffer ціни накопичувався у фоні.
  setInterval(function () {
    if (!_tradesData) return;
    var hasOpen = (_tradesData.trades || []).some(function (t) { return t.status === 'open'; });
    if (!hasOpen) return;
    renderTrades();
  }, 1000);

  // Re-expand a trade detail without re-fetching events (uses cached trade data)
  function _restoreExpanded(tradeId) {
    var trade = (_tradesData && _tradesData.trades || []).find(function (t) {
      return t.trade_id === tradeId;
    });
    if (!trade) { _expandedTradeId = null; return; }

    var row = document.querySelector('#tradesTbody tr[data-trade-id="' + tradeId + '"]');
    if (row) {
      var events = _expandedEvents.length ? _expandedEvents : ((trade && trade.recent_events) || []);
      var html = buildDetailPanel(trade, events);
      row.insertAdjacentHTML('afterend',
        '<tr class="tr-detail-row" id="detail-' + esc(tradeId) + '"><td colspan="13">' + html + '</td></tr>'
      );
      row.classList.add('tr-expanded');
    }
  }

  // ── Single Row ────────────────────────────────────────────────────
  function renderTradeRow(t) {
    var isOpen = t.status === 'open';
    var openClass = isOpen ? ' class="tr-open"' : '';
    var mode = t.mode === 'live'
      ? '<span class="b b-live">LIVE</span>'
      : '<span class="b b-dry">DRY</span>';

    // Shares — highlight over-budget
    var shares = (t.shares && t.shares.bought != null) ? t.shares.bought : 0;
    var sharesLimit = (t.shares && t.shares.limit != null) ? t.shares.limit : 6.0;
    var sharesOver = shares > sharesLimit;
    var sharesCell = sharesOver
      ? '<span class="td-mono" style="color:var(--red)">' + shares.toFixed(2) + ' <span class="tr-shares-warn">\u26a0 OVER</span></span>'
      : '<span class="td-mono">' + shares.toFixed(2) + '</span>';

    // P&L (unrealized for open, realized for closed)
    var pnl = t.pnl || 0;
    var pnlCls = pnl > 0 ? 'td-pos' : pnl < 0 ? 'td-neg' : 'td-dim';
    var pnlStr = (pnl >= 0 ? '+' : '') + fmt$(pnl);
    // Add gain % for open positions
    if (isOpen && t.exit && t.exit.gain_pct != null && t.exit.gain_pct !== 0) {
      pnlStr += ' <span style="font-size:10px;opacity:0.7">' + (t.exit.gain_pct >= 0 ? '+' : '') + t.exit.gain_pct.toFixed(1) + '%</span>';
    }
    // PnL change indicator: ▲/▼ arrow + glow on movement
    var _pnlInfo = _pnlChangeInfo(t.trade_id, pnl, isOpen);
    var _pnlExtra = '';
    var _pnlCellStyle = '';
    if (_pnlInfo) {
      _pnlExtra = ' <span style="font-size:9px;' + _pnlInfo.arrowStyle + '">' + _pnlInfo.arrow + '</span>';
      if (_pnlInfo.cellGlow) _pnlCellStyle = ';' + _pnlInfo.cellGlow;
    }

    // F10 (audit X9 UI): Exit reason badge — prefer structured closure_reason
    // over legacy exit_reason string, add unverified exit indicator.
    // L29: pass exit_reason string so exitBadge can infer actual trigger
    // when closure_reason is generic (gtd_sell_filled).
    var exitReason = exitBadge(
      (t.exit && t.exit.closure_reason) || (t.exit && t.exit.reason),
      isOpen,
      t.exit && t.exit.exit_verified,
      t.exit && t.exit.reason
    );

    // Result
    var result = isOpen
      ? '<span style="color:var(--blue)">\ud83d\udfe2 Open</span>'
      : t.result === 'won'
        ? '<span class="b b-win">Won \u2705</span>'
        : t.result === 'flat'
          ? '<span class="b" style="background:var(--panel-alt);color:var(--fg-dim);border-color:var(--brd)">Flat \u2796</span>'
          : '<span class="b b-lose">Lost \u274c</span>';

    var dur = t.duration_human || '\u2014';
    var entryPrice = (t.entry && t.entry.fill_price) ? t.entry.fill_price.toFixed(3) : '\u2014';
    var exitPriceRaw = (t.exit && t.exit.price != null) ? t.exit.price : null;
    var exitPrice = (exitPriceRaw != null) ? exitPriceRaw.toFixed(3) : '\u2014';
    var cost = (t.sizing && t.sizing.cost_usdc != null) ? fmt$(t.sizing.cost_usdc) : '\u2014';
    var timeStr = (t.entry && t.entry.timestamp) ? App.fmtUpdatedAt(t.entry.timestamp) : '\u2014';

    // Freshness підсвітка для колонки Exit (тільки у відкритих позицій).
    // L24: server-side last_price_update_ts — authoritative; client diff
    // inference залишено як fallback у _exitFreshnessStyle.
    var _srvTs = (t.exit && t.exit.last_price_update_ts) || null;
    var _fresh = _exitFreshnessStyle(t.trade_id, exitPriceRaw, isOpen, _srvTs);
    var _exitAttrs = 'class="td-mono"';
    if (_fresh) {
      if (_fresh.style) _exitAttrs += ' style="' + _fresh.style + '"';
      if (_fresh.title) _exitAttrs += ' title="' + esc(_fresh.title) + '"';
    }

    return '<tr' + openClass + ' data-trade-id="' + esc(t.trade_id || '') + '" onclick="App.toggleTradeDetail(\'' + esc(t.trade_id || '') + '\')">' +
      '<td class="td-dim">' + timeStr + '</td>' +
      '<td>' + mode + '</td>' +
      '<td class="td-main">' + (t.event_slug
        ? '<a href="https://polymarket.com/event/' + esc(t.event_slug) + '?r=moonkee" target="_blank" rel="noopener" class="mkt-link" onclick="event.stopPropagation()">' + esc(t.market || '\u2014') + '</a>'
        : esc(t.market || '\u2014')) + '</td>' +
      '<td>' + App.outcomeBadge(t.side) + '</td>' +
      '<td>' + App.fmtResolution(t) + '</td>' +
      '<td class="td-mono">' + entryPrice + '</td>' +
      '<td ' + _exitAttrs + '>' + exitPrice + '</td>' +
      '<td>' + sharesCell + '</td>' +
      '<td class="td-mono">' + cost + '</td>' +
      '<td class="' + pnlCls + '"' + (_pnlCellStyle ? ' style="' + _pnlCellStyle + '"' : '') + '>' + pnlStr + _pnlExtra + '</td>' +
      (isOpen
        ? '<td colspan="2" style="padding:2px 4px"><canvas class="pos-freshness-spark" data-tid="' + esc(t.trade_id || '') + '" data-entry="' + ((t.entry && t.entry.fill_price) || 0) + '" width="240" height="24" style="vertical-align:middle;width:100%"></canvas></td>'
        : '<td>' + exitReason + '</td><td>' + result + '</td>') +
      '<td class="td-dim">' + esc(dur) + '</td>' +
    '</tr>';
  }

  // ── Exit reason badge ─────────────────────────────────────────────
  // F10/F18 (audit X9 UI): Ukrainian labels for structured closure_reason values.
  // Keys MUST match constants in core/closure_reasons.py (F18 split
  // sl_fok umbrella into 4 SL-family variants for live-mode debug).
  var CLOSURE_LABELS_UK = {
    // ── SELL-based closures (need on-chain confirmation) ──
    'tp_fok':                { text: 'TP',           cls: 'tr-exit-tp',    icon: '\u2705' },         // ✅ take-profit
    'sl_fok':                { text: 'SL hard',      cls: 'tr-exit-sl',    icon: '\ud83d\udfe0' },   // 🟠 hard stop-loss
    'sl_emergency':          { text: 'Аварійний SL', cls: 'tr-exit-sl',    icon: '\ud83d\uded1' },   // 🛑 emergency stop (catastrophic)
    'sl_aggressive':         { text: 'Агр. SL',      cls: 'tr-exit-sl',    icon: '\u26a1' },         // ⚡ aggressive stop (age-bypass)
    'entry_mispriced':       { text: 'Mispriced',    cls: 'tr-exit-sl',    icon: '\u26a0\ufe0f' }, // ⚠️ WS bootstrap-gap, not a real SL
    'trailing_stop':         { text: 'Trail',        cls: 'tr-exit-trail', icon: '\ud83d\udcc9' },   // 📉 trailing stop (often profit!)
    'whale_exit':            { text: 'Whale exit',   cls: 'tr-exit-res',   icon: '\ud83d\udc0b' },   // 🐋 whale flipped
    'time_expiry':           { text: 'Час',          cls: 'tr-exit-res',   icon: '\u23f0' },         // ⏰ time exit
    'manual':                { text: 'Вручну',       cls: 'tr-exit-res',   icon: '\u270b' },         // ✋
    'gtd_sell_filled':       { text: 'GTD',          cls: 'tr-exit-res',   icon: '\ud83d\udcdc' },   // 📜 GTD limit filled
    'price_resolved':        { text: 'Price resolv', cls: 'tr-exit-price', icon: '\ud83c\udfc1' },   // 🏁 price-resolved
    // ── Non-sell closures (auto-verified at set time) ──
    'market_resolved_win':   { text: 'Резолв WIN',   cls: 'tr-exit-price', icon: '\ud83c\udfc6' },   // 🏆
    'market_resolved_loss':  { text: 'Резолв LOSS',  cls: 'tr-exit-price', icon: '\ud83d\udc80' },   // 💀
    'write_off':             { text: 'Write-off',    cls: 'tr-exit-res',   icon: '\u26d4' },         // ⛔
    'cancelled_offline':     { text: 'Скасовано',    cls: 'tr-exit-res',   icon: '\ud83d\udeab' },   // 🚫
    'external_sell':         { text: 'Зовнішній',    cls: 'tr-exit-res',   icon: '\ud83d\udd04' },   // 🔄 sold on Polymarket UI
    // ── Dismissals ──
    'false_positive':        { text: 'Ghost',        cls: 'tr-exit-res',   icon: '\ud83d\udc7b' },   // 👻
    'manual_dismiss':        { text: 'Скинуто',      cls: 'tr-exit-res',   icon: '\ud83d\uddd1' },   // 🗑
    'phantom_auto_close':    { text: 'Привид',       cls: 'tr-exit-res',   icon: '\ud83d\udc7b' },   // 👻
  };

  var CLOSURE_LABELS_EN = {
    'tp_fok':                { text: 'TP',            cls: 'tr-exit-tp',    icon: '\u2705' },
    'sl_fok':                { text: 'SL hard',       cls: 'tr-exit-sl',    icon: '\ud83d\udfe0' },
    'sl_emergency':          { text: 'Emergency SL',  cls: 'tr-exit-sl',    icon: '\ud83d\uded1' },
    'sl_aggressive':         { text: 'Aggr. SL',      cls: 'tr-exit-sl',    icon: '\u26a1' },
    'entry_mispriced':       { text: 'Mispriced',     cls: 'tr-exit-sl',    icon: '\u26a0\ufe0f' },
    'trailing_stop':         { text: 'Trail',         cls: 'tr-exit-trail', icon: '\ud83d\udcc9' },
    'whale_exit':            { text: 'Whale exit',    cls: 'tr-exit-res',   icon: '\ud83d\udc0b' },
    'time_expiry':           { text: 'Time',          cls: 'tr-exit-res',   icon: '\u23f0' },
    'manual':                { text: 'Manual',        cls: 'tr-exit-res',   icon: '\u270b' },
    'gtd_sell_filled':       { text: 'GTD',           cls: 'tr-exit-res',   icon: '\ud83d\udcdc' },
    'price_resolved':        { text: 'Price resolv',  cls: 'tr-exit-price', icon: '\ud83c\udfc1' },
    'market_resolved_win':   { text: 'Resolved WIN',  cls: 'tr-exit-price', icon: '\ud83c\udfc6' },
    'market_resolved_loss':  { text: 'Resolved LOSS', cls: 'tr-exit-price', icon: '\ud83d\udc80' },
    'write_off':             { text: 'Write-off',     cls: 'tr-exit-res',   icon: '\u26d4' },
    'cancelled_offline':     { text: 'Cancelled',     cls: 'tr-exit-res',   icon: '\ud83d\udeab' },
    'external_sell':         { text: 'External',      cls: 'tr-exit-res',   icon: '\ud83d\udd04' },
    'false_positive':        { text: 'Ghost',         cls: 'tr-exit-res',   icon: '\ud83d\udc7b' },
    'manual_dismiss':        { text: 'Dismissed',     cls: 'tr-exit-res',   icon: '\ud83d\uddd1' },
    'phantom_auto_close':    { text: 'Phantom',       cls: 'tr-exit-res',   icon: '\ud83d\udc7b' },
  };

  function _closureLabels() {
    return (App.locale === 'en') ? CLOSURE_LABELS_EN : CLOSURE_LABELS_UK;
  }

  // L29: Infer the actual exit trigger from the exit_reason string.
  // exit_engine writes descriptive strings like "🛑 Stop-Loss (-26%, mark=executable)",
  // "✅ Take-Profit (+15%)", "📉 Trailing Stop (-5% from peak)", etc.
  // This maps them back to CLOSURE_LABELS_UK keys so we show the real trigger
  // instead of generic "GTD" when closure_reason is gtd_sell_filled.
  function _inferTriggerFromExitReason(exitReasonStr) {
    if (!exitReasonStr) return null;
    var s = String(exitReasonStr).toLowerCase();
    // Order matters — most specific first (same as infer_closure_from_exit_reason in Python)
    if (s.indexOf('whale exit') >= 0 || s.indexOf('intent collapse') >= 0) return 'whale_exit';
    if (s.indexOf('trailing stop') >= 0 || s.indexOf('trailing_stop') >= 0) return 'trailing_stop';
    if (s.indexOf('entry mispriced') >= 0 || s.indexOf('entry_mispriced') >= 0) return 'entry_mispriced';
    if (s.indexOf('emergency stop') >= 0 || s.indexOf('emergency_stop') >= 0) return 'sl_emergency';
    if (s.indexOf('aggressive stop') >= 0 || s.indexOf('aggressive_stop') >= 0) return 'sl_aggressive';
    if (s.indexOf('ceiling tp') >= 0) return 'tp_fok';
    if (s.indexOf('take-profit') >= 0 || s.indexOf('take profit') >= 0) return 'tp_fok';
    if (s.indexOf('stop-loss') >= 0 || s.indexOf('stop loss') >= 0) return 'sl_fok';
    if (s.indexOf('time exit') >= 0 || s.indexOf('time_exit') >= 0) return 'time_expiry';
    if (s.indexOf('market resolved') >= 0) {
      return s.indexOf('win') >= 0 ? 'market_resolved_win' : 'market_resolved_loss';
    }
    if (s.indexOf('price-resolved') >= 0 || s.indexOf('price resolved') >= 0) return 'price_resolved';
    if (s.indexOf('write-off') >= 0 || s.indexOf('sell cycles') >= 0) return 'write_off';
    return null;
  }

  function exitBadge(reason, isOpen, exitVerified, exitReasonStr) {
    if (isOpen) return '<span class="tr-exit-open">\u2014 open</span>';
    if (!reason || reason === '\u2014') return '<span class="td-dim">\u2014</span>';

    // Prefer structured Ukrainian label when closure_reason matches.
    // L29: when closure_reason is generic (gtd_sell_filled), try to infer
    // the actual trigger from exit_reason string so we show "SL hard",
    // "TP", "Trail" etc. instead of uninformative "GTD".
    var label;
    var inferredKey = null;
    if (reason === 'gtd_sell_filled' && exitReasonStr) {
      inferredKey = _inferTriggerFromExitReason(exitReasonStr);
    }
    var CL = _closureLabels();
    if (inferredKey && CL[inferredKey]) {
      label = CL[inferredKey];
    } else if (CL[reason]) {
      label = CL[reason];
    } else {
      var r = String(reason).toLowerCase();
      var cls = 'tr-exit-res';
      var icon = '\ud83d\udccb';
      if (r.indexOf('take') >= 0 || r.indexOf('tp') >= 0 || r.indexOf('profit') >= 0) {
        cls = 'tr-exit-tp'; icon = '\u2705';
      } else if (r.indexOf('stop') >= 0 || r.indexOf('sl') >= 0) {
        cls = 'tr-exit-sl'; icon = '\ud83d\udfe0';
      } else if (r.indexOf('price-resolved') >= 0 || r.indexOf('write_off') >= 0) {
        cls = 'tr-exit-price'; icon = '\ud83d\udc80';
      } else if (r.indexOf('resolution') >= 0 || r.indexOf('false_positive') >= 0) {
        cls = 'tr-exit-res'; icon = '\ud83d\udccb';
      } else if (r.indexOf('emergency') >= 0) {
        cls = 'tr-exit-sl'; icon = '\ud83d\uded1';
      }
      label = { text: String(reason).replace(/_/g, ' '), cls: cls, icon: icon };
    }

    // Unverified exit indicator (hourglass) — SELL sent but not chain-confirmed
    var unverified = (exitVerified === false)
      ? ' <span title="' + App.t('trades.exit_unverified_tip') + '" style="opacity:.7">\u23f3</span>'
      : '';

    return '<span class="tr-exit-badge ' + label.cls + '">'
         + label.icon + ' ' + esc(label.text) + unverified + '</span>';
  }

  // ── Detail Panel (inline expand) ──────────────────────────────────
  App.toggleTradeDetail = async function (tradeId) {
    if (!tradeId) return;

    // Remove existing detail
    var existing = document.getElementById('detail-' + tradeId);
    if (existing) {
      existing.remove();
      // Remove expanded class
      var rows = document.querySelectorAll('#tradesTbody tr.tr-expanded');
      rows.forEach(function (r) { r.classList.remove('tr-expanded'); });
      _expandedTradeId = null;
      _expandedEvents = [];
      return;
    }

    // Remove any other open detail
    if (_expandedTradeId) {
      var prev = document.getElementById('detail-' + _expandedTradeId);
      if (prev) prev.remove();
      document.querySelectorAll('#tradesTbody tr.tr-expanded').forEach(function (r) {
        r.classList.remove('tr-expanded');
      });
    }

    _expandedTradeId = tradeId;

    // Fetch events for this trade
    var events = [];
    try {
      var evResp = await fetch('/api/polymarket/lifecycle/events?trade_id=' + encodeURIComponent(tradeId) + '&limit=50');
      if (evResp.ok) events = await evResp.json();
    } catch (e) {
      // fallback: use recent_events from cached data
    }
    _expandedEvents = events;

    var trade = (_tradesData && _tradesData.trades || []).find(function (t) {
      return t.trade_id === tradeId;
    });
    if (!trade) return;

    var html = buildDetailPanel(trade, events);

    // Insert after the clicked row
    var row = document.querySelector('#tradesTbody tr[data-trade-id="' + tradeId + '"]');
    if (row) {
      row.insertAdjacentHTML('afterend',
        '<tr class="tr-detail-row" id="detail-' + esc(tradeId) + '"><td colspan="13">' + html + '</td></tr>'
      );
      row.classList.add('tr-expanded');
    }
  };

  // ── Build Detail Panel HTML ───────────────────────────────────────
  function buildDetailPanel(trade, events) {
    var t = trade;
    var s = t.shares || {};
    var ini = t.initiator || {};
    var ex = t.exit || {};
    var ent = t.entry || {};

    var dangerClass = !s.within_budget ? ' danger' : '';

    return '<div class="tr-detail">' +
      // ─── ENTRY ───
      '<div class="tr-dsec">' +
        '<div class="tr-dsec-title">\ud83d\udce5 Entry</div>' +
        drow('Trade ID', t.trade_id ? '<span class="trade-id">' + esc(t.trade_id) + '</span>' : '\u2014') +
        drow('Whale price', fmt$(ent.whale_price)) +
        drow('Market price', ent.market_price ? fmt$(ent.market_price) : '\u2014') +
        drow('Fill price', fmt$(ent.fill_price)) +
        drow('Convergence', t.convergence && t.convergence.count ? '\u00d7' + t.convergence.count : '\u2014') +
        drow('Source', ent.source || '\u2014') +
        drow('Initiator', ini.wallet_short ? '<span class="tr-whale-badge">\ud83d\udc0b ' + esc(ini.wallet_short) + '</span>' : '\u2014') +
        drow('Trust', '<span style="color:' + App.trustColor(ini.trust_score || 50) + '">' + (ini.trust_score || 50) + '</span>') +
        drow('Classification', ini.classification || '\u2014') +
        drow('SM score', ini.sm_score != null ? ini.sm_score.toFixed(2) : '\u2014') +
      '</div>' +

      // ─── SHARES & SIZING ───
      '<div class="tr-dsec' + dangerClass + '">' +
        '<div class="tr-dsec-title">' + (!s.within_budget ? '\u26a0\ufe0f' : '\ud83d\udcca') + ' Shares & Sizing' + (!s.within_budget ? ' \u2014 OVER BUDGET' : '') + '</div>' +
        drow('Shares bought', '<span style="color:' + (s.within_budget ? 'var(--grn)' : 'var(--red)') + '">' + (s.bought != null ? s.bought.toFixed(2) : '\u2014') + '</span>' + (!s.within_budget ? ' <span class="tr-shares-warn">\u26a0 EXCEEDS</span>' : '')) +
        drow('Budget limit', s.limit != null ? s.limit.toFixed(2) : '\u2014') +
        (!s.within_budget ? drow('Overshoot', '<span style="color:var(--red);font-weight:700">+' + (s.overshoot || 0).toFixed(2) + ' shares (+' + (s.overshoot_pct || 0).toFixed(0) + '%)</span>') : '') +
        drow('Cost (USDC)', fmt$(t.sizing && t.sizing.cost_usdc)) +
        drow('Kelly fraction', t.sizing && t.sizing.kelly_fraction != null ? t.sizing.kelly_fraction.toFixed(2) : '\u2014') +
        '<div class="tr-drow tr-drow-sep">' +
          '<span class="tr-drow-label" style="font-size:10px">Shares check</span>' +
          '<span class="tr-drow-val" style="color:' + (s.within_budget ? 'var(--grn)' : 'var(--red)') + ';font-size:10px">' +
            (s.within_budget
              ? (s.bought != null ? s.bought.toFixed(2) : '?') + ' \u2264 ' + (s.limit != null ? s.limit.toFixed(2) : '?') + ' \u2713 OK'
              : (s.bought != null ? s.bought.toFixed(2) : '?') + ' > ' + (s.limit != null ? s.limit.toFixed(2) : '?') + ' \u2715 FAILED') +
          '</span>' +
        '</div>' +
      '</div>' +

      // ─── EXIT ───
      '<div class="tr-dsec">' +
        '<div class="tr-dsec-title">\ud83d\udce4 Exit</div>' +
        drow('Exit price', ex.price ? ex.price.toFixed(3) : '\u2014') +
        drow('Gain', ex.gain_pct != null ? (ex.gain_pct >= 0 ? '+' : '') + ex.gain_pct.toFixed(1) + '%' : '\u2014') +
        drow('P&L', ex.pnl_usd != null ? '<span style="color:' + (ex.pnl_usd >= 0 ? 'var(--grn)' : 'var(--red)') + '">' + (ex.pnl_usd >= 0 ? '+' : '') + fmt$(ex.pnl_usd) + '</span>' : '\u2014') +
        // PnL verification badge
        (function() {
          if (!ex.pnl_verified && !ex.pnl_verify_error) return '';
          if (ex.pnl_verify_error) {
            return drow('PnL verified', '<span style="color:var(--amber)" title="' + esc(ex.pnl_verify_error) + '">\u26a0 ' + ex.pnl_verify_error + '</span>');
          }
          if (ex.pnl_anomaly) {
            var adelta = ex.pnl_anomaly_delta ? ' ($' + ex.pnl_anomaly_delta.toFixed(2) + ')' : '';
            return drow('PnL verified', '<span style="color:var(--red)">\u26a0 \u0410\u043d\u043e\u043c\u0430\u043b\u0456\u044f' + adelta + '</span>' +
              (ex.pnl_pre_verify != null ? ' <span style="color:var(--dim);font-size:10px">(\u0431\u0443\u043b\u043e: ' + (ex.pnl_pre_verify >= 0 ? '+' : '') + ex.pnl_pre_verify.toFixed(2) + ')</span>' : ''));
          }
          var src = ex.pnl_verified_source === 'trade_reconciler' ? 'chain' : ex.pnl_verified_source === 'activity_arithmetic' ? 'activity' : 'API';
          return drow('PnL verified', '<span style="color:var(--grn)">\u2713 ' + src + '</span>' +
            (ex.pnl_pre_verify != null && ex.pnl_pre_verify !== ex.pnl_usd ? ' <span style="color:var(--dim);font-size:10px">(\u0431\u0443\u043b\u043e: ' + (ex.pnl_pre_verify >= 0 ? '+' : '') + ex.pnl_pre_verify.toFixed(2) + ')</span>' : ''));
        })() +
        drow('Exit reason', ex.reason || '\u2014') +
        drow('Duration', t.duration_human || '\u2014') +
        drow('Mark source', ex.mark_source || '\u2014') +
        drow('Mark quality', ex.mark_quality || '\u2014') +
      '</div>' +

      // ─── LIFECYCLE EVENTS TIMELINE ───
      '<div class="tr-events">' +
        '<div class="tr-dsec-title">\ud83d\udccb Lifecycle Events' +
          '<button class="tr-btn-copy" onclick="event.stopPropagation(); App.copyTradeJSON(\'' + esc(t.trade_id) + '\')">\ud83d\udccb Copy JSON</button>' +
        '</div>' +
        renderEventTimeline(events, t) +
        '<div class="tr-actions">' +
          '<button class="tr-btn-lc" onclick="event.stopPropagation(); App.openLifecycle(\'' + esc(t.trade_id) + '\')">\ud83d\udd0d \u041f\u043e\u0432\u043d\u0438\u0439 Lifecycle \u2192</button>' +
          '<button class="tr-btn-copy" onclick="event.stopPropagation(); App.copyTradeJSON(\'' + esc(t.trade_id) + '\')">\ud83d\udccb Copy Full JSON</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function drow(label, value) {
    return '<div class="tr-drow"><span class="tr-drow-label">' + label + '</span><span class="tr-drow-val">' + (value || '\u2014') + '</span></div>';
  }

  // ── Render Event Timeline ─────────────────────────────────────────
  function renderEventTimeline(events, trade) {
    if (!events || !events.length) {
      // Fallback to recent_events from trade data
      events = (trade && trade.recent_events) || [];
    }
    if (!events.length) {
      return '<div class="td-dim">\u041d\u0435\u043c\u0430\u0454 \u043f\u043e\u0434\u0456\u0439</div>';
    }

    // Sort oldest first for timeline
    var sorted = events.slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });

    return sorted.map(function (ev) {
      var time = App.fmtUpdatedAt(ev.ts || 0);
      var dotClass = evDotClass(ev.event);
      var text = renderEventText(ev, trade);

      return '<div class="tr-ev">' +
        '<span class="tr-ev-time">' + time + '</span>' +
        '<span class="tr-ev-dot ' + dotClass + '"></span>' +
        '<span class="tr-ev-text">' + text + '</span>' +
      '</div>';
    }).join('');
  }

  function evDotClass(eventName) {
    if (!eventName) return '';
    var e = eventName.toLowerCase();

    if (e === 'signal_detected' || e === 'convergence_detected') return 'whale';
    if (e === 'place_buy_start' || e === 'entry_decision') return 'entry';
    if (e === 'mark_update' || e === 'mark_fetched') return 'mark';
    if (e === 'exit_triggered' || e === 'tp_triggered' || e === 'sl_triggered') return 'trigger';
    if (e === 'exit_fill' || e === 'sell_placed' || e === 'status_transition') return 'fill';
    if (e === 'closed' || e === 'budget_exit' || e === 'position_resolved') return 'exit';

    if (e.indexOf('whale') >= 0 || e.indexOf('convergence') >= 0) return 'whale';
    if (e.indexOf('buy') >= 0 || e.indexOf('entry') >= 0) return 'entry';
    if (e.indexOf('mark') >= 0) return 'mark';
    if (e.indexOf('trigger') >= 0) return 'trigger';
    if (e.indexOf('fill') >= 0 || e.indexOf('transition') >= 0) return 'fill';
    if (e.indexOf('exit') >= 0 || e.indexOf('close') >= 0) return 'exit';
    if (e.indexOf('error') >= 0 || e.indexOf('fail') >= 0) return 'error';

    return 'state';
  }

  function renderEventText(ev, trade) {
    var e = ev.event || '';
    var html = '<strong>' + esc(e) + '</strong>';

    switch (e) {
      case 'signal_detected':
      case 'convergence_detected': {
        var w = ev.whale || ev.wallet || '';
        html += ' \u2014 <span class="tr-whale-badge">\ud83d\udc0b ' + esc(w) + '</span>';
        if (ev.whale_volume) html += ' $' + Number(ev.whale_volume).toFixed(0);
        if (ev.trust_score != null) html += ' \u00b7 Trust: <strong>' + ev.trust_score + '</strong>';
        if (ev.classification) html += ' \u00b7 ' + esc(ev.classification);
        if (ev.sm_score != null) html += ' \u00b7 SM: <strong>' + ev.sm_score + '</strong>';
        break;
      }

      case 'place_buy_start':
      case 'entry_decision':
        html += ' \u2014';
        if (ev.price) html += ' ' + ev.price + '\u00a2';
        if (ev.size) html += ' \u00d7 <strong>' + ev.size + ' shares</strong>';
        if (ev.cost) html += ' = $' + ev.cost;
        break;

      case 'status_transition':
        html += ' \u2014 ' + esc(ev.from || '?') + ' \u2192 <strong>' + esc(ev.to || '?') + '</strong>';
        if (ev.reason) html += ' \u00b7 ' + esc(ev.reason);
        break;

      case 'mark_update':
      case 'mark_fetched':
        html += ' \u2014 ' + (ev.source || '?') + ' \u2192 ' + (ev.mark || '?');
        if (ev.quality) html += ' (' + ev.quality + ')';
        break;

      case 'exit_triggered':
      case 'tp_triggered':
      case 'sl_triggered':
        html += ' \u2014 ' + esc(ev.reason || ev.trigger || '');
        if (ev.mark) html += ' \u00b7 mark=' + ev.mark;
        if (ev.threshold) html += ' \u00b7 threshold=' + ev.threshold;
        break;

      case 'exit_fill':
      case 'sell_filled':
        html += ' \u2014';
        if (ev.fill_price) html += ' @ ' + ev.fill_price;
        if (ev.pnl_amount != null) {
          var pnlColor = ev.pnl_amount >= 0 ? 'var(--grn)' : 'var(--red)';
          html += ' \u00b7 <strong style="color:' + pnlColor + '">$' + (ev.pnl_amount >= 0 ? '+' : '') + ev.pnl_amount.toFixed(2) + '</strong>';
        }
        if (ev.shares) html += ' \u00b7 ' + ev.shares + ' shares';
        break;

      case 'budget_exit':
        html += ' \u2014 cost $' + (ev.cost_returned || '?') + ' released';
        if (ev.available != null) html += ' \u00b7 available: $' + ev.available.toFixed(2);
        break;

      default: {
        var skip = { ts: 1, event: 1, trade_id: 1 };
        var parts = [];
        for (var k in ev) {
          if (skip[k]) continue;
          var val = typeof ev[k] === 'number' ? Math.round(ev[k] * 10000) / 10000 : ev[k];
          parts.push(k + '=' + val);
        }
        if (parts.length) html += ' <span style="color:var(--t3)">' + esc(parts.join(' ').substring(0, 120)) + '</span>';
      }
    }

    return html;
  }

  // ── Copy JSON ─────────────────────────────────────────────────────
  App.copyTradeJSON = async function (tradeId) {
    var trade = (_tradesData && _tradesData.trades || []).find(function (t) {
      return t.trade_id === tradeId;
    });
    if (!trade) return;

    var events = [];
    try {
      var resp = await fetch('/api/polymarket/lifecycle/events?trade_id=' + encodeURIComponent(tradeId) + '&limit=200');
      if (resp.ok) events = await resp.json();
    } catch (e) { /* ignore */ }

    var fullData = Object.assign({}, trade, { lifecycle_events: events });
    navigator.clipboard.writeText(JSON.stringify(fullData, null, 2)).then(function () {
      App.toast('\u0421\u043a\u043e\u043f\u0456\u0439\u043e\u0432\u0430\u043d\u043e ' + tradeId, 'ok', 1500);
    });
  };

  App.copyAllTradesJSON = function () {
    if (!_tradesData) return;
    navigator.clipboard.writeText(JSON.stringify(_tradesData.trades, null, 2)).then(function () {
      App.toast('\u0421\u043a\u043e\u043f\u0456\u0439\u043e\u0432\u0430\u043d\u043e ' + (_tradesData.trades && _tradesData.trades.length || 0) + ' \u0442\u0440\u0435\u0439\u0434\u0456\u0432', 'ok', 1500);
    });
  };

  // ── Open Lifecycle tab filtered ───────────────────────────────────
  App.openLifecycle = function (tradeId) {
    App.sw('lifecycle');
    var filterEl = document.getElementById('lcFilterTradeId');
    if (filterEl) {
      filterEl.value = tradeId;
      if (App.lcRefresh) App.lcRefresh();
    }
  };

  // ── Filter handlers ───────────────────────────────────────────────
  App.setTradeFilter = function (btn, filter) {
    document.querySelectorAll('.tr-btn').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    _activeFilter = filter;
    renderTrades();
  };
  window.setTradeFilter = App.setTradeFilter;

  App.tradeSearch = function (el) {
    _searchQuery = el.value.trim();
    renderTrades();
  };
  window.tradeSearch = App.tradeSearch;

})(window.App);
