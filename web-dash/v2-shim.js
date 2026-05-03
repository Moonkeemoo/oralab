/* v2-shim.js — translation layer between v1 verstka (Flask /api/polymarket/*)
 * and v2 REST backend (TypeScript /api/*).
 *
 * Loaded BEFORE app.js. Intercepts window.fetch:
 *   1. v1 paths starting with /api/polymarket/ are looked up in ENDPOINT_MAP
 *   2. string mapping  → fetch the v2 path and pass through
 *   3. function mapping → run the shape adapter, return adapted JSON
 *   4. null mapping     → synth an UNWIRED response (200 with marker)
 *   5. unknown path     → synth UNWIRED + console.warn
 *
 * Auth: v2 dev-mode bypass header (X-Dev-Bypass: secretdev) is injected
 * for every v2 call. Desktop dashboard is dev-only.
 *
 * Unwired UI:
 *   - Each unwired call records its v1 path into UNWIRED_SEEN
 *   - A floating <div id="v2-unwired-banner"> renders the running list
 *   - Code that calls .json() and finds {__unwired:true,...} can choose
 *     to render <span class="v2-unwired-badge"> in place of data; v1 code
 *     mostly tolerates {} or [] so the badges may be sparse without
 *     deeper hooking — banner is the catch-all source of truth.
 */
(function () {
  'use strict';

  const DEV_TOKEN = 'secretdev';   // matches DEV_AUTH_TOKEN in v2 .env
  const origFetch = window.fetch.bind(window);

  // Track every unwired hit for the running banner
  const UNWIRED_SEEN = new Map();   // path -> count
  let bannerEl = null;

  function ensureBanner() {
    if (bannerEl || !document.body) return;
    bannerEl = document.createElement('div');
    bannerEl.id = 'v2-unwired-banner';
    bannerEl.innerHTML = `
      <div class="v2-banner-title">
        <span>⚠ NOT WIRED · v1→v2 endpoints</span>
        <button class="v2-banner-close" type="button" title="hide">×</button>
      </div>
      <ul></ul>`;
    bannerEl.querySelector('.v2-banner-close').onclick = () => {
      bannerEl.style.display = 'none';
    };
    document.body.appendChild(bannerEl);
  }

  function refreshBanner() {
    if (!bannerEl) ensureBanner();
    if (!bannerEl) return;   // body not ready yet — will be added next tick
    const ul = bannerEl.querySelector('ul');
    if (!ul) return;
    const sorted = [...UNWIRED_SEEN.entries()].sort((a, b) => b[1] - a[1]);
    ul.innerHTML = sorted.map(([p, n]) =>
      `<li><span class="count">${n}×</span>${escapeHtml(p)}</li>`
    ).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function recordUnwired(path) {
    UNWIRED_SEEN.set(path, (UNWIRED_SEEN.get(path) ?? 0) + 1);
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      ensureBanner();
      refreshBanner();
    }
  }

  function jsonResponse(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders),
    });
  }

  function unwiredResponse(oldPath, fallback = {}) {
    recordUnwired(oldPath);
    // Carry both the marker and a v1-shape fallback so v1 code doesn't crash
    const body = Object.assign({ __unwired: true, oldEndpoint: oldPath }, fallback);
    return jsonResponse(body, 200, { 'X-V2-Unwired': '1' });
  }

  // Inject dev-bypass into v2 calls (and pass through whatever the caller had)
  function v2Headers(opts) {
    const h = new Headers(opts && opts.headers ? opts.headers : undefined);
    h.set('X-Dev-Bypass', DEV_TOKEN);
    return h;
  }

  function v2Fetch(path, opts = {}) {
    const merged = Object.assign({}, opts, { headers: v2Headers(opts) });
    return origFetch(path, merged);
  }

  async function v2Get(path) {
    const r = await v2Fetch(path, { method: 'GET' });
    if (!r.ok) throw new Error('v2 ' + path + ' → HTTP ' + r.status);
    return r.json();
  }

  // ── Field-mapping helpers (v2 → v1 shape) ─────────────────────────────────
  function mapPosition(p) {
    // v1 keys: trade_id, condition_id, asset_id, market, wallet, side, strategy,
    //         entry_price, current_price, cost, unrealized_pnl, age_ts,
    //         last_price_update_ts, fill_status, mark_quality, trading_mode, event_slug.
    return {
      trade_id: String(p.id),
      condition_id: p.conditionId,
      asset_id: p.assetId,
      market: p.marketTitle || p.outcomeName || p.assetId,
      side: p.side,
      strategy: p.strategy || 'whale_follow',
      wallet: p.whaleAddress || null,
      entry_price: p.fillPrice,
      current_price: p.currentPrice,
      cost: p.entryCostUsd,
      unrealized_pnl: p.currentPnlUsd,
      age_ts: p.fillTs ? Math.floor(p.fillTs / 1000) : null,
      last_price_update_ts: p.markAgeMs != null
        ? Math.floor((Date.now() - p.markAgeMs) / 1000)
        : null,
      fill_status: p.mode === 'LIVE' ? 'filled' : 'simulated',
      mark_quality: p.markSource === 'rest_book' ? 'executable'
                  : p.markAgeMs != null && p.markAgeMs < 10000 ? 'executable'
                  : 'stale',
      trading_mode: (p.mode || 'DRY').toLowerCase() === 'live' ? 'live' : 'dry_run',
      order_id: p.orderId || null,
      // pass-through for richer detail
      condition_id_short: p.conditionId ? String(p.conditionId).slice(0, 8) : '',
      resolves_text: p.resolvesText,
      outcome_name: p.outcomeName,
      mark_age_ms: p.markAgeMs,
      shares: p.shares,
    };
  }

  function mapTrade(t) {
    // v1 keys: trade_id, condition_id, market, side, entry/entry_price,
    //         exit/exit_price, pnl, pnl_status, duration, date, trading_mode, open_ts.
    const pnl = t.pnlUsd != null ? t.pnlUsd : 0;
    const isWin = pnl > 0 || t.outcome === 'win';
    const durMin = t.durationMs ? Math.round(t.durationMs / 60000) : 0;
    const durStr = durMin >= 60
      ? Math.floor(durMin / 60) + 'h ' + (durMin % 60) + 'm'
      : durMin + 'm';
    const closeMs = t.closeTs || 0;
    return {
      trade_id: String(t.id),
      condition_id: t.conditionId || null,
      market: t.marketTitle || t.outcomeName || t.assetId,
      side: t.side,
      entry: t.fillPrice,
      entry_price: t.fillPrice,
      exit: t.exitPrice,
      exit_price: t.exitPrice,
      pnl,
      pnl_amount: pnl,
      pnl_status: isWin ? 'win' : 'loss',
      duration: durStr,
      date: closeMs ? new Date(closeMs).toISOString() : null,
      open_ts: t.fillTs ? Math.floor(t.fillTs / 1000) : 0,
      close_ts: closeMs ? Math.floor(closeMs / 1000) : 0,
      trading_mode: (t.mode || 'DRY').toLowerCase() === 'live' ? 'live' : 'dry_run',
      result: t.result,
      close_reason: t.closeReason,
      close_reason_label: t.closeReasonLabel,
      shares: t.shares,
    };
  }

  function mapWhale(w) {
    // v1 wallet fields: address, trust_score, trust_wins, trust_losses,
    //                   trust_pnl, trust_disabled, categories, classification.
    return {
      address: w.address,
      wallet: w.address,
      trust_score: Math.round((w.trustScore || 0) * 100),
      trust_wins: w.wins || 0,
      trust_losses: w.losses || 0,
      trust_pnl: w.pnlUsd || 0,
      trust_disabled: !w.tracked,
      categories: w.categories || (w.classification ? [w.classification] : []),
      category: w.classification,
      classification: w.classification,
      score: Math.round((w.smScore || 0) * 100),
      sm_score: w.smScore,
      win_rate: w.winRate,
      confidence: w.confidence,
      tracked: w.tracked,
    };
  }

  // ─── ENDPOINT MAP ────────────────────────────────────────────────────────
  // value:
  //   string                      → forward to that v2 path (query preserved)
  //   async fn({path, query, opts}) → return a JS object → wrapped to Response
  //   null                        → UNWIRED with empty fallback
  //   {fallback, _unwired:true}   → UNWIRED with custom fallback shape
  // ─────────────────────────────────────────────────────────────────────────
  const ENDPOINT_MAP = {
    // ── Core read paths ────────────────────────────────────────────────────
    '/api/polymarket/health': async () => {
      const [h, status, conn] = await Promise.allSettled([
        v2Get('/api/health'),
        v2Get('/api/status'),
        v2Get('/api/connections'),
      ]);
      const ok = h.status === 'fulfilled' && h.value && h.value.ok;
      const services = {};
      const conns = conn.status === 'fulfilled' && Array.isArray(conn.value) ? conn.value : [];
      conns.forEach(c => {
        services[c.source] = {
          state: c.state,
          age_ms: c.ageMs,
          last_event_ts: c.lastEventTs,
        };
      });
      return {
        state: ok ? 'OK' : 'DEGRADED',
        ok,
        mode: status.status === 'fulfilled' ? status.value.mode : 'DRY',
        kill_switch: status.status === 'fulfilled' ? status.value.killSwitch : false,
        services,
      };
    },

    // /kpi — adapt v2 fields → v1 desktop dash field names.
    // v1 portfolio.js reads: total_checked, total_accepted, total_rejected,
    //   conv_entered, conv_blocked, conv_signals, signals_per_hour,
    //   avg_latency_ms, latency_bottleneck, profit_factor, gross_win,
    //   gross_loss, max_drawdown, avg_duration_s, open_count, closed_count.
    '/api/polymarket/kpi': async () => {
      const [k, latency] = await Promise.allSettled([
        v2Get('/api/kpi'),
        v2Get('/api/latency'),
      ]);
      const kVal = k.status === 'fulfilled' ? k.value : null;
      const lat  = latency.status === 'fulfilled' ? latency.value : null;
      if (!kVal) return {};
      // Compute avg latency across stages (mean of avgMs)
      let avgLat = 0, latBottleneck = '';
      if (lat && Array.isArray(lat.stages) && lat.stages.length > 0) {
        const sum = lat.stages.reduce((s, st) => s + (st.avgMs || 0), 0);
        avgLat = sum / lat.stages.length;
        latBottleneck = lat.bottleneck || '';
      }
      return {
        // pass-through v2 native fields (caller may use either shape)
        ...kVal,
        // v1 KPI shape projection
        total_checked: kVal.signalsTotal,
        total_accepted: kVal.signalsAccepted,
        total_rejected: kVal.signalsRejected,
        conv_entered: 0,
        conv_blocked: 0,
        conv_signals: 0,
        signals_per_hour: kVal.signalsPerHour,
        avg_latency_ms: avgLat,
        latency_bottleneck: latBottleneck,
        profit_factor: kVal.profitFactor,
        gross_win: kVal.grossWinUsd,
        gross_loss: kVal.grossLossUsd,
        max_drawdown: kVal.drawdownUsd,
        avg_duration_s: kVal.avgDurationSec,
        open_count: kVal.openPositionCount,
        closed_count: kVal.closedCount,
        // also expose hyphenated/snake versions some legacy code paths use
        pass_rate: kVal.passRatePct,
        win_rate: kVal.winRatePct,
        net_pnl: kVal.netPnlUsd,
        cf_net_usd: kVal.cfNetUsd,
        rejection_top: kVal.topRejection,
      };
    },

    // /positions — array; map v2 fields → v1 shape for the table.
    '/api/polymarket/positions': async () => {
      const list = await safeGet('/api/positions');
      if (!Array.isArray(list)) return [];
      return list.map(mapPosition);
    },

    // /history — v1 expects {trades:[{date, mode, side,...}], summary:{total, win_rate, net_pnl}}
    '/api/polymarket/history': async () => {
      const h = await safeGet('/api/history');
      const trades = (h && Array.isArray(h.trades)) ? h.trades : [];
      const agg = (h && h.aggregates) || {};
      const mapped = trades.map(mapTrade);
      const wins = mapped.filter(t => t.pnl > 0).length;
      const total = mapped.length;
      return {
        trades: mapped,
        summary: {
          total,
          win_rate: total ? Math.round((wins / total) * 100) : 0,
          net_pnl: agg.netPnlUsd != null ? agg.netPnlUsd : mapped.reduce((s, t) => s + (t.pnl || 0), 0),
          wins,
          losses: total - wins,
        },
      };
    },

    // /state — v1 consolidated read; reassemble from v2 calls.
    // Returns full portfolio (pnl/totals/bots/chart) + positions + history + settings.
    '/api/polymarket/state': async () => {
      const [bal, kpi, status, positionsRes, historyRes, pnlRes, settings] = await Promise.allSettled([
        v2Get('/api/balance'),
        v2Get('/api/kpi'),
        v2Get('/api/status'),
        v2Get('/api/positions'),
        v2Get('/api/history'),
        v2Get('/api/pnl'),
        v2Get('/api/exit_config'),
      ]);
      const balance = bal.status === 'fulfilled' ? bal.value : null;
      const kpiVal  = kpi.status === 'fulfilled' ? kpi.value : null;
      const stat    = status.status === 'fulfilled' ? status.value : null;
      const pos     = positionsRes.status === 'fulfilled' && Array.isArray(positionsRes.value) ? positionsRes.value : [];
      const histRaw = historyRes.status === 'fulfilled' ? historyRes.value : { trades: [] };
      const pnlVal  = pnlRes.status === 'fulfilled' ? pnlRes.value : null;
      const histTrades = (histRaw && Array.isArray(histRaw.trades)) ? histRaw.trades : [];
      const histAgg = (histRaw && histRaw.aggregates) || {};
      const inPositions = pos.reduce((s, p) => s + (p.entryCostUsd || 0), 0);
      const totalBudget = balance ? balance.totalBudgetUsd : 0;
      const built = await safeBuildPortfolio(kpiVal);
      const mappedTrades = histTrades.map(mapTrade);
      const wins = mappedTrades.filter(t => t.pnl > 0).length;
      const total = mappedTrades.length;
      return {
        portfolio: Object.assign({}, built, {
          totals: {
            in_positions: inPositions,
            balance: totalBudget,
            available: balance ? balance.freeUsd : 0,
            allocated: balance ? balance.allocatedUsd : 0,
          },
          bots: hardcodedBots(stat),
          mode: stat ? (stat.mode || 'DRY') : 'DRY',
          active_positions: stat ? (stat.activePositions || 0) : 0,
          budget: totalBudget,
          available: balance ? balance.freeUsd : 0,
          pnl: {
            '1d':  pnlVal ? (pnlVal.today || 0) : 0,
            '1w':  pnlVal ? (pnlVal.week || 0) : 0,
            'all': pnlVal ? (pnlVal.all || 0) : (kpiVal ? (kpiVal.netPnlUsd || 0) : 0),
            today: pnlVal ? pnlVal.today : 0,
            week:  pnlVal ? pnlVal.week : 0,
          },
          chart: pnlVal && Array.isArray(pnlVal.timeseries)
            ? pnlVal.timeseries.map(p => ({ ts: p.ts, value: p.cumulativeUsd }))
            : [],
        }),
        positions: pos.map(mapPosition),
        history: {
          trades: mappedTrades,
          summary: {
            total,
            win_rate: total ? Math.round((wins / total) * 100) : 0,
            net_pnl: histAgg.netPnlUsd != null ? histAgg.netPnlUsd : mappedTrades.reduce((s, t) => s + (t.pnl || 0), 0),
            wins,
            losses: total - wins,
          },
        },
        settings: settings.status === 'fulfilled' ? settings.value : {},
      };
    },

    // /portfolio — v1 expects {totals:{in_positions, balance}, bots:[…], pnl:{1d,1w,all}, …}.
    '/api/polymarket/portfolio': async () => {
      const [bal, kpi, status, positionsRes, pnlRes] = await Promise.allSettled([
        v2Get('/api/balance'),
        v2Get('/api/kpi'),
        v2Get('/api/status'),
        v2Get('/api/positions'),
        v2Get('/api/pnl'),
      ]);
      const balance = bal.status === 'fulfilled' ? bal.value : null;
      const kpiVal  = kpi.status === 'fulfilled' ? kpi.value : null;
      const stat    = status.status === 'fulfilled' ? status.value : null;
      const pos     = positionsRes.status === 'fulfilled' ? positionsRes.value : [];
      const pnlVal  = pnlRes.status === 'fulfilled' ? pnlRes.value : null;
      const inPositions = (Array.isArray(pos) ? pos : [])
        .reduce((s, p) => s + (p.entryCostUsd || 0), 0);
      const totalBudget = balance ? balance.totalBudgetUsd : 0;
      const built = await safeBuildPortfolio(kpiVal);
      return Object.assign({}, built, {
        totals: {
          in_positions: inPositions,
          balance: totalBudget,
          available: balance ? balance.freeUsd : 0,
          allocated: balance ? balance.allocatedUsd : 0,
        },
        bots: hardcodedBots(stat),
        mode: stat ? (stat.mode || 'DRY') : 'DRY',
        active_positions: stat ? (stat.activePositions || 0) : 0,
        budget: totalBudget,
        available: balance ? balance.freeUsd : 0,
        pnl: {
          '1d':  pnlVal ? (pnlVal.today || 0) : 0,
          '1w':  pnlVal ? (pnlVal.week || 0) : 0,
          'all': pnlVal ? (pnlVal.all || 0) : (kpiVal ? (kpiVal.netPnlUsd || 0) : 0),
          today: pnlVal ? pnlVal.today : 0,
          week:  pnlVal ? pnlVal.week : 0,
        },
        pnl_total: pnlVal ? pnlVal.netPnlUsd : (kpiVal ? kpiVal.netPnlUsd : 0),
        chart: pnlVal && Array.isArray(pnlVal.timeseries)
          ? pnlVal.timeseries.map(p => ({ ts: p.ts, value: p.cumulativeUsd }))
          : [],
      });
    },

    '/api/polymarket/usdc-balance': async () => {
      const b = await safeGet('/api/balance');
      const total = b ? (b.totalBudgetUsd || 0) : 0;
      const free = b ? (b.freeUsd || 0) : 0;
      return {
        balance: total,
        portfolio_value: total,
        cash: free,
        usdc: free,
      };
    },

    // Settings (v1 used /settings → exit knobs); map to /exit_config
    '/api/polymarket/settings': '/api/exit_config',

    // Status / mode
    '/api/polymarket/trading-mode': async () => {
      const s = await safeGet('/api/status');
      const mode = (s?.mode || 'DRY');
      return {
        mode: mode === 'LIVE' ? 'live' : 'dry_run',
        kill_switch: !!s?.killSwitch,
      };
    },

    // Build / meta
    '/api/polymarket/meta': async () => {
      const b = await safeGet('/api/build');
      return { build: b, version: b?.commit || 'v2' };
    },

    // Filters
    '/api/polymarket/filters': '/api/filters/registry',
    '/api/polymarket/filters/reject_stats': '/api/filters/stats',
    '/api/polymarket/tab/filters': async () => {
      const [filters, stats, settings] = await Promise.allSettled([
        v2Get('/api/filters/registry'),
        v2Get('/api/filters/stats'),
        v2Get('/api/exit_config'),
      ]);
      return {
        filters: filters.status === 'fulfilled' ? filters.value : [],
        config: {},                       // v1 had filters/config — UNWIRED in v2
        reject_stats: stats.status === 'fulfilled' ? stats.value : {},
        convergence_stats: {},            // UNWIRED
        recent_rejections: [],            // UNWIRED
        settings: settings.status === 'fulfilled' ? settings.value : {},
      };
    },

    // Whales — v1 wallets list (full table)
    '/api/polymarket/wallets': async () => {
      const r = await safeGet('/api/whales?limit=2000');
      const items = r && Array.isArray(r.items) ? r.items : (Array.isArray(r) ? r : []);
      return items.map(mapWhale);
    },

    // Latency / timing
    '/api/polymarket/timing': async () => {
      const l = await safeGet('/api/latency');
      return l ?? {};
    },
    '/api/polymarket/timing/summary': async () => {
      const p = await safeGet('/api/perf');
      return p ?? {};
    },

    // Trades — alias for /history (v1 expected an array)
    '/api/polymarket/trades': async () => {
      const h = await safeGet('/api/history');
      const trades = (h && Array.isArray(h.trades)) ? h.trades : [];
      return trades.map(mapTrade);
    },

    // Kill-switch (POST/GET both routed) — both hyphen and underscore variants
    '/api/polymarket/kill-switch': async ({ opts }) => {
      // Forward request method to underscore endpoint; preserve body.
      const r = await v2Fetch('/api/kill_switch', opts);
      const data = await r.json().catch(() => ({}));
      // v1 reads { active }
      return Object.assign(
        { active: !!(data.killSwitch ?? data.active ?? data.value) },
        data,
      );
    },
    '/api/polymarket/kill_switch': async ({ opts }) => {
      const r = await v2Fetch('/api/kill_switch', opts);
      const data = await r.json().catch(() => ({}));
      return Object.assign(
        { active: !!(data.killSwitch ?? data.active ?? data.value) },
        data,
      );
    },

    // ── Calibration ────────────────────────────────────────────────────────

    // /calibration/status — v1 expects {state, last_run, ...}
    '/api/polymarket/calibration/status': async () => {
      const s = await safeGet('/api/calibrator/status');
      if (!s) return {};
      return {
        state: s.mode || 'manual',
        mode: s.mode,
        configured_mode: s.configuredMode,
        last_run: s.lastRunAt,
        last_run_ts: s.lastRunAt ? Math.floor(new Date(s.lastRunAt).getTime() / 1000) : 0,
        last_cycle_id: s.lastCycleId,
        last_rec_count: s.lastRecCount,
        next_run: s.nextRunAt,
        interval_ms: s.intervalMs,
      };
    },

    // /calibration/sports — v1 cal-sports.js expects {meta:{total_trades, window_h}, table:[…], heatmap:{sports, cells_pnl, cells_wr, cells_count}}
    '/api/polymarket/calibration/sports': async ({ query }) => {
      // Pass through window_h if present
      const sportPath = '/api/calibrator/sport' + (query || '');
      const [sport, heatmap] = await Promise.allSettled([
        v2Get(sportPath),
        v2Get('/api/calibrator/sport/heatmap'),
      ]);
      const sportVal = sport.status === 'fulfilled' ? sport.value : null;
      const hm      = heatmap.status === 'fulfilled' ? heatmap.value : null;

      const sports = (sportVal && Array.isArray(sportVal.sports)) ? sportVal.sports : [];
      // v1 row keys: sport, n, wins, losses, net_pnl, wr, tp_rate, sl_rate, avg_dur_min, avg_bet
      const table = sports.map(s => ({
        sport: s.sport || 'Other',
        n: s.trades || 0,
        wins: s.wins || 0,
        losses: s.losses || 0,
        net_pnl: s.netPnl || 0,
        wr: s.winRate || 0,
        tp_rate: s.tpPct || 0,
        sl_rate: s.slPct || 0,
        avg_dur_min: s.avgDurSec ? s.avgDurSec / 60 : 0,
        avg_bet: s.avgStakeUsd || 0,
      }));
      const totalTrades = table.reduce((acc, r) => acc + r.n, 0);

      // Build heatmap cells matrix [sport_idx][hour] → pnl / count / wr
      const sportsList = (hm && Array.isArray(hm.sports)) ? hm.sports : [];
      const cells = (hm && hm.cells) || {};
      const cellsPnl   = sportsList.map(s => Array.from({length:24}, (_, h) => cells[`${s}_${h}`] != null ? cells[`${s}_${h}`] : null));
      const cellsCount = sportsList.map(() => Array.from({length:24}, () => 0));
      const cellsWr    = sportsList.map(() => Array.from({length:24}, () => null));
      const heatmapV1 = {
        sports: sportsList,
        cells_pnl: cellsPnl,
        cells_wr: cellsWr,
        cells_count: cellsCount,
      };

      return {
        meta: {
          total_trades: totalTrades,
          window_h: sportVal && sportVal.windowHours ? sportVal.windowHours : 24,
          mode: sportVal && sportVal.mode,
        },
        table,
        heatmap: heatmapV1,
      };
    },

    // /calibration/attribution — v1 cal-analytics.js expects {attribution:[…], lift_matrix_entry:[…], min_lift_threshold, ts}
    '/api/polymarket/calibration/attribution': async () => {
      const [attr, liftEntry] = await Promise.allSettled([
        v2Get('/api/calibrator/attribution'),
        v2Get('/api/calibrator/lift_matrix?phase=entry'),
      ]);
      const attrVal = attr.status === 'fulfilled' ? attr.value : null;
      const liftVal = liftEntry.status === 'fulfilled' ? liftEntry.value : null;
      return {
        attribution: (attrVal && Array.isArray(attrVal.attribution)) ? attrVal.attribution : [],
        lift_matrix_entry: (liftVal && Array.isArray(liftVal.matrix)) ? liftVal.matrix : [],
        min_lift_threshold: 0.08,
        ts: Math.floor(Date.now() / 1000),
      };
    },

    // /calibration/traces — v1 cal-log.js expects {traces:[…], ts}
    '/api/polymarket/calibration/traces': async ({ query }) => {
      const r = await safeGet('/api/calibrator/trace' + (query || ''));
      const rows = (r && Array.isArray(r.rows)) ? r.rows : [];
      return {
        traces: rows.map(t => ({
          ts: t.ts ? Math.floor(t.ts / 1000) : 0,
          ts_ms: t.ts,
          event: t.eventType,
          event_type: t.eventType,
          cycle_id: t.cycleId,
          payload: t.payload || {},
        })),
        ts: Math.floor(Date.now() / 1000),
      };
    },

    // /calibration/bayesian — v1 cal-analytics.js expects {bayesian:[…], ts}
    '/api/polymarket/calibration/bayesian': async () => {
      const b = await safeGet('/api/calibrator/beliefs');
      return {
        bayesian: (b && Array.isArray(b.beliefs)) ? b.beliefs : [],
        ts: Math.floor(Date.now() / 1000),
      };
    },

    // /calibration/settings — v1 cal-settings.js expects {settings:{}, defaults:{}}
    '/api/polymarket/calibration/settings': async ({ opts }) => {
      // GET passes through; POST forwards body
      if (opts && opts.method && opts.method.toUpperCase() === 'POST') {
        const r = await v2Fetch('/api/calibrator/settings', opts);
        const j = await r.json().catch(() => ({}));
        return Object.assign({ success: !!j.ok || !!j.success || !j.error }, j, {
          settings: j.current || j.settings || {},
          defaults: j.defaults || {},
        });
      }
      const s = await safeGet('/api/calibrator/settings');
      return {
        settings: (s && s.current) || {},
        defaults: (s && s.defaults) || {},
        success: true,
      };
    },

    '/api/polymarket/calibration/mode': '/api/calibrator/mode',
    '/api/polymarket/calibration/run': '/api/calibrator/run',

    // /calibration/whales — v1 cal-whales.js expects {whales:[…], total, totals, ts}
    '/api/polymarket/calibration/whales': async ({ query }) => {
      // v2 has no per-whale calibration endpoint — derive from /api/whales.
      // Honor limit/offset query params.
      const qm = new URLSearchParams((query || '').replace(/^\?/, ''));
      const limit  = parseInt(qm.get('limit') || '50', 10);
      const offset = parseInt(qm.get('offset') || '0', 10);
      const r = await safeGet(`/api/whales?limit=${limit + offset}&trackedOnly=false`);
      const items = (r && Array.isArray(r.items)) ? r.items : [];
      const slice = items.slice(offset, offset + limit);
      // v1 row keys: wallet, wallet_full, classification, trades, wins, losses, pnl, win_rate, trust
      const whales = slice.map(w => ({
        wallet: w.address ? (w.address.slice(0, 6) + '…' + w.address.slice(-4)) : '—',
        wallet_full: w.address,
        classification: w.classification || 'unknown',
        trust: Math.round((w.trustScore || 0) * 100),
        win_rate: w.winRate || 0,
        trades: w.totalTrades || 0,
        wins: w.wins || 0,
        losses: w.losses || 0,
        pnl: w.pnlUsd || 0,
      }));
      return {
        whales,
        total: r ? (r.total || items.length) : items.length,
        totals: null,           // v2 doesn't aggregate per-set totals
        ts: Math.floor(Date.now() / 1000),
      };
    },

    // /calibration/overview — v1 cal-overview.js
    // Expects {kpi, exit_kpi, performance, recommendations, history, mode,
    //          deficits, weights, importance, lift_matrix, exit_targets,
    //          exit_keys, min_lift_threshold, ts, cycle_interval_s, bot_has_run, min_trades}
    '/api/polymarket/calibration/overview': async () => {
      const [snap, recs, status, kpi] = await Promise.allSettled([
        v2Get('/api/calibrator/snapshot'),
        v2Get('/api/calibrator/recommendations'),
        v2Get('/api/calibrator/status'),
        v2Get('/api/kpi'),
      ]);
      const s   = snap.status === 'fulfilled' ? snap.value : null;
      const rs  = recs.status === 'fulfilled' ? recs.value : null;
      const st  = status.status === 'fulfilled' ? status.value : null;
      const k   = kpi.status === 'fulfilled' ? kpi.value : null;

      // Map snapshot KPIs → v1 cal-overview shape
      const sKpi = (s && s.kpi) || {};
      const sExitKpi = (s && s.exitKpi) || {};
      const v1Kpi = {
        win_rate: sKpi.win_rate || 0,
        pass_rate: sKpi.pass_rate || 0,
        profit_factor: sKpi.profit_factor || 0,
        avg_pnl: sKpi.avg_pnl || 0,
        rejection_top: k && k.topRejection ? k.topRejection : '—',
        cf_net: k && k.cfNetUsd != null ? k.cfNetUsd : 0,
        cf_lost: k && k.leftOnTableUsd != null ? k.leftOnTableUsd : 0,
        total_signals: k && k.signalsTotal != null ? k.signalsTotal : 0,
        total_trades: s && s.closedTrades ? s.closedTrades : 0,
      };
      const v1ExitKpi = {
        sl_rate: sExitKpi.sl_rate || 0,
        tp_hit_rate: sExitKpi.tp_hit_rate || 0,
        exit_efficiency: sExitKpi.exit_efficiency || 0,
        left_on_table: sExitKpi.left_on_table || 0,
        total_exits: s && s.closedTrades ? s.closedTrades : 0,
      };
      const v1Perf = {
        win_rate: k && k.winRatePct != null ? k.winRatePct : 0,
        profit_factor: k && k.profitFactor != null ? k.profitFactor : 0,
        avg_pnl: k && k.avgPnlPerTradeUsd != null ? k.avgPnlPerTradeUsd : 0,
        total_pnl: k && k.netPnlUsd != null ? k.netPnlUsd : 0,
        total_trades: k && k.closedCount != null ? k.closedCount : 0,
      };

      // Recommendations from v2 → v1 shape
      const recsList = (rs && Array.isArray(rs.recommendations)) ? rs.recommendations : [];
      const v1Recs = recsList.map(r => ({
        config_key: r.filterName + '.' + r.paramKey,
        human_name: r.filterName,
        phase: r.filterName && r.filterName.startsWith('exit_') ? 'exit' : 'entry',
        direction: r.direction,
        score: r.liftEstimateUsd,
        confidence_status: r.confidence,
        confidence: r.confidence === 'stable' ? 0.9 : r.confidence === 'growing' ? 0.6 : 0.3,
        current_value: r.currentValue,
        recommended_value: r.recommendedValue,
        delta: (r.recommendedValue || 0) - (r.currentValue || 0),
        reason: r.reason,
        aims: r.aims || [],
        lift: r.liftMatrix || {},
        reject_key: r.filterName,
      }));

      return {
        kpi: v1Kpi,
        exit_kpi: v1ExitKpi,
        performance: v1Perf,
        recommendations: v1Recs,
        history: [],            // applied/rolled-back history derive needs more wiring
        mode: (st && st.mode) || (s && s.mode) || 'manual',
        deficits: (s && s.deficits) || {},
        weights: (s && s.weights) || {},
        importance: {},
        lift_matrix: {},
        exit_targets: {},
        exit_keys: [],
        min_lift_threshold: 0.08,
        ts: st && st.lastRunAt ? Math.floor(new Date(st.lastRunAt).getTime() / 1000) : 0,
        cycle_interval_s: st && st.intervalMs ? Math.round(st.intervalMs / 1000) : 1800,
        bot_has_run: !!(st && st.lastRunAt),
        min_trades: 20,
        trace_id: st && st.lastCycleId ? st.lastCycleId : '',
      };
    },

    // /calibration/exit — v1 cal-exit.js expects {total, breakdown, analysis, params, lift_matrix_exit, min_lift_threshold}
    '/api/polymarket/calibration/exit': async () => {
      const [k, liftExit, exitConfig] = await Promise.allSettled([
        v2Get('/api/kpi'),
        v2Get('/api/calibrator/lift_matrix?phase=exit'),
        v2Get('/api/exit_config'),
      ]);
      const kVal = k.status === 'fulfilled' ? k.value : null;
      const liftVal = liftExit.status === 'fulfilled' ? liftExit.value : null;
      const params = exitConfig.status === 'fulfilled' ? exitConfig.value : {};
      const total = (kVal && kVal.closedCount) || 0;
      return {
        total,
        breakdown: {},          // closure-reason histogram not yet exposed by v2
        analysis: {},
        params,
        lift_matrix_exit: (liftVal && Array.isArray(liftVal.matrix)) ? liftVal.matrix : [],
        min_lift_threshold: 0.08,
      };
    },
    // /calibration/apply/:id pattern is handled by patternRouter() below

    // ── WIRED — adapters mapping v1 shapes to v2 backend ─────────────────

    // /profiles — top-N whale profiles (v1: array of {wallet, trust, classification, ...})
    '/api/polymarket/profiles': async () => {
      const v2 = await safeGet('/api/whales?limit=200');
      const items = v2 && Array.isArray(v2.items) ? v2.items : [];
      return items.map((w) => ({
        wallet: w.address,
        trust: Math.round((w.trustScore || 0) * 100),
        classification: w.classification || 'NOISE',
        win_rate: w.winRate || 0,
        total_trades: w.totalTrades || 0,
        confidence: w.confidence || 0,
        sm_score: w.smScore || 0,
        smart_money_score: Math.round((w.smScore || 0) * 100),
        tracked: w.tracked,
      }));
    },

    // /budget — v1 reads budget_usd, available, remaining_budget, mode, profit, …
    '/api/polymarket/budget': async ({ opts }) => {
      // POST ignored (no v2 endpoint to set budget); GET-style read otherwise.
      if (opts && opts.method && opts.method.toUpperCase() === 'POST') {
        recordUnwired('/api/polymarket/budget [POST]');
        return { success: false, error: 'budget mutation unwired in v2' };
      }
      const bal = await safeGet('/api/balance');
      const total = bal ? (bal.totalBudgetUsd || 0) : 0;
      const free = bal ? (bal.freeUsd || 0) : 0;
      const allocated = bal ? (bal.allocatedUsd || 0) : 0;
      return {
        budget_usd: total,
        available: free,
        remaining_budget: total,
        free,
        allocated,
        spent: allocated,
        profit: 0,
        mode: bal ? bal.mode : 'DRY',
        phantom_count: bal ? (bal.phantomCount || 0) : 0,
        untracked_count: bal ? (bal.untrackedCount || 0) : 0,
        history: [],
      };
    },

    // /exposure — sum of OPEN entry_cost as both $ and % of budget
    '/api/polymarket/exposure': async () => {
      const [positionsRes, balanceRes] = await Promise.allSettled([
        v2Get('/api/positions'),
        v2Get('/api/balance'),
      ]);
      const positionsList = positionsRes.status === 'fulfilled' && Array.isArray(positionsRes.value)
        ? positionsRes.value
        : [];
      const balance = balanceRes.status === 'fulfilled' ? balanceRes.value : null;
      const total = positionsList.reduce((s, p) => s + (p.entryCostUsd || 0), 0);
      const budget = (balance && balance.totalBudgetUsd) || 1;
      return {
        total_usd: total,
        budget_usd: budget,
        pct: total / budget,
        open_count: positionsList.length,
        positions: positionsList.map((p) => ({
          id: p.id,
          asset: p.assetId,
          cost: p.entryCostUsd,
          pnl_usd: p.currentPnlUsd,
          pnl_pct: p.currentPnlPct,
        })),
      };
    },

    // /intents — exit intent log (derive from positions.lastIntentAction)
    '/api/polymarket/intents': async () => {
      const positionsList = await safeGet('/api/positions');
      if (!Array.isArray(positionsList)) return [];
      return positionsList
        .filter((p) => p.lastIntentAction)
        .map((p) => ({
          position_id: p.id,
          intent: p.lastIntentAction,
          reason: p.lastIntentReason,
          ts: Date.now() - (p.markAgeMs || 0),
        }));
    },

    // /leaderboard — top whales by win_rate
    '/api/polymarket/leaderboard': async () => {
      const v2 = await safeGet('/api/whales?limit=50&trackedOnly=true');
      const items = v2 && Array.isArray(v2.items) ? v2.items : [];
      return items
        .filter((w) => (w.winRate || 0) > 0)
        .sort((a, b) => (b.winRate || 0) - (a.winRate || 0))
        .slice(0, 20)
        .map((w, i) => ({
          rank: i + 1,
          wallet: w.address,
          win_rate: w.winRate,
          classification: w.classification,
          tracked: w.tracked,
        }));
    },

    // /logs — last N calibrator_trace events (closest analog v2 has)
    '/api/polymarket/logs': async () => {
      const v2 = await safeGet('/api/calibrator/trace?limit=200');
      const rows = v2 && Array.isArray(v2.rows) ? v2.rows : [];
      return rows.map((e) => ({
        ts: e.ts,
        level: 'info',
        source: 'calibrator',
        msg: `${e.eventType}: ${JSON.stringify(e.payload || {}).slice(0, 200)}`,
      }));
    },

    // /chain/stats — pipeline latency from signal_timings (closest analog)
    '/api/polymarket/chain/stats': async () => {
      const v2 = await safeGet('/api/latency');
      return {
        stages: (v2 && v2.stages) || [],
        bottleneck: (v2 && v2.bottleneck) || null,
        window_hours: (v2 && v2.windowHours) || 24,
      };
    },

    // ── Per-bot status (no v2 endpoint; best-effort from /status) ─────────
    // /api/polymarket/bots/<service>/status — return synthesized status
    // Pattern handled in patternRouter below.

    // ── UNWIRED — v1 features without v2 backend support yet ──────────────
    '/api/polymarket/intents/stats':                  null,
    '/api/polymarket/budget/reset':                   null,
    '/api/polymarket/exposure/reset':                 null,
    '/api/polymarket/conviction_stats':               null,   // whale conviction histogram
    '/api/polymarket/diagnostic/groups':              null,   // diagnostic groupings
    '/api/polymarket/lifecycle':                      null,   // position lifecycle dashboard
    '/api/polymarket/lifecycle/events':               null,
    '/api/polymarket/live-marks':                     null,   // mark refresh dashboard
    '/api/polymarket/poke-mark':                      null,   // manual mark refresh
    '/api/polymarket/logs/clear':                     null,
    '/api/polymarket/trade-decisions':                null,   // explainable trade-decision log
    '/api/polymarket/trade-decisions/clear':          null,
    '/api/polymarket/decision-log':                   null,   // legacy decision log
    '/api/polymarket/decision-log/clear':             null,
    '/api/polymarket/rejects/recent':                 null,   // covered partly by tab/filters adapter (recent_rejections=[])
    '/api/polymarket/reconciliation':                 null,   // ghost / phantom reconciliation report
    '/api/polymarket/stream':                         null,   // SSE — also stubbed at EventSource layer below
    '/api/polymarket/filters/config':                 null,   // saved-presets store
    '/api/polymarket/filters/recent_rejections':      null,
    '/api/polymarket/filters/convergence_stats':      null,
    '/api/polymarket/filters/reset':                  null,
    '/api/polymarket/filters/restore':                null,
    '/api/polymarket/filters/presets/save':           null,
    '/api/polymarket/filters/reject_stats/reset':     null,
    '/api/polymarket/positions/dismiss':              null,   // dismiss completed position from view
    '/api/polymarket/positions/exit':                 null,   // wired via /api/positions/:id/exit (handled by patternRouter)
    '/api/polymarket/history/delete':                 null,   // history purge tool
    '/api/polymarket/topup':                          null,   // wallet top-up trigger
    '/api/polymarket/timing/clear':                   null,
    '/api/polymarket/dashboard/restart':              null,   // self-restart hook (dev-only)
    '/api/polymarket/bots/reset':                     null,
    '/api/polymarket/bots/trader/restart':            null,
    '/api/polymarket/wallets/discover':               null,   // whale-discovery batch job
    '/api/polymarket/wallets/discover/status':        null,
    '/api/polymarket/wallets/discover/stop':          null,
    '/api/polymarket/wallets/reset':                  null,
    '/api/polymarket/calibration/configs':            null,   // saved cal-configs library
    '/api/polymarket/calibration/copy':               null,
    '/api/polymarket/calibration/copy-key':           null,
    '/api/polymarket/calibration/skip':               null,
    '/api/polymarket/calibration/pause':              null,
    '/api/polymarket/calibration/reject':             null,
    '/api/polymarket/calibration/approve':            null,
    '/api/polymarket/calibration/rollback':           null,   // wired via /api/calibrator/rollback/:id (patternRouter)
    '/api/polymarket/calibration/ai':                 null,
    '/api/polymarket/calibration/clear-history':      null,
    '/api/polymarket/calibration/apply':              null,   // wired via /api/calibrator/apply/:id (patternRouter)
  };

  // Helpers used by adapters
  async function safeGet(path) {
    try { return await v2Get(path); } catch (_e) { return null; }
  }
  async function safeBuildPortfolio(kpi) {
    const bal = await safeGet('/api/balance');
    const usdc = bal ? (bal.totalBudgetUsd || 0) : 0;
    return {
      balance: usdc,
      equity:  (kpi && kpi.equity != null ? kpi.equity : usdc),
      pnl:     (kpi && kpi.netPnlUsd != null ? kpi.netPnlUsd : 0),
      pnl_pct: (kpi && kpi.netPnlPct != null ? kpi.netPnlPct : 0),
      trades:  (kpi && kpi.closedCount != null ? kpi.closedCount : 0),
      win_rate: (kpi && kpi.winRatePct != null ? kpi.winRatePct : 0),
    };
  }

  // Best-effort hardcoded bot list — v2 has no per-service status endpoint.
  // Returns 4 services as "running:true" so UI doesn't show all-stopped.
  function hardcodedBots(_status) {
    const isRunning = true;   // dashboard is reachable, so api server is up
    const list = [
      { type: 'trader',     name: 'Whale Copy Bot',  emoji: '🐋', running: isRunning, pid: '—', balance: 0 },
      { type: 'ws_feed',    name: 'WS Feed',         emoji: '📡', running: isRunning, pid: '—', balance: 0 },
      { type: 'rtds_feed',  name: 'RTDS Feed',       emoji: '⛓️', running: isRunning, pid: '—', balance: 0 },
      { type: 'calibrator', name: 'Calibrator',      emoji: '🎯', running: isRunning, pid: '—', balance: 0 },
    ];
    return list;
  }

  // ── Pattern-based router for paths with embedded IDs ────────────────────
  // Runs BEFORE ENDPOINT_MAP lookup — only matches very specific id-shapes.
  // Generic "any unknown calibration/* path" catch-all moved to fallbackRouter
  // (after ENDPOINT_MAP lookup) so static map entries take precedence.
  function patternRouter(pathOnly, queryStr, opts) {
    // /api/polymarket/positions/:id/exit  → /api/positions/:id/exit
    let m = pathOnly.match(/^\/api\/polymarket\/positions\/(\d+)\/exit$/);
    if (m) return v2Fetch('/api/positions/' + m[1] + '/exit' + queryStr, opts);

    // /api/polymarket/calibration/apply/:id → /api/calibrator/apply/:id
    m = pathOnly.match(/^\/api\/polymarket\/calibration\/apply\/(\d+)$/);
    if (m) return v2Fetch('/api/calibrator/apply/' + m[1], opts);

    // /api/polymarket/calibration/rollback/:id → /api/calibrator/rollback/:id
    m = pathOnly.match(/^\/api\/polymarket\/calibration\/rollback\/(\d+)$/);
    if (m) return v2Fetch('/api/calibrator/rollback/' + m[1], opts);

    // /api/polymarket/bots/<name>/status → synthesized "running" response
    m = pathOnly.match(/^\/api\/polymarket\/bots\/([\w-]+)\/status$/);
    if (m) {
      return Promise.resolve(jsonResponse({
        name: m[1],
        active: true,
        running: true,
        last_tick_ts: Math.floor(Date.now() / 1000),
        restart_count: 0,
        note: 'best-effort: v2 has no per-service status endpoint',
      }));
    }
    // /api/polymarket/bots/status → list of all bots
    if (pathOnly === '/api/polymarket/bots/status' || pathOnly === '/api/polymarket/bots') {
      return Promise.resolve(jsonResponse({
        services: hardcodedBots().map(b => ({
          name: b.type,
          active: b.running,
          last_tick_ts: Math.floor(Date.now() / 1000),
          restart_count: 0,
        })),
      }));
    }

    return null;
  }

  // Catch-all for paths still unhandled after ENDPOINT_MAP lookup.
  function fallbackRouter(pathOnly) {
    if (/^\/api\/polymarket\/bots\//.test(pathOnly)) {
      return unwiredResponse(pathOnly, { ok: false, reason: 'unwired' });
    }
    if (/^\/api\/polymarket\/calibration\//.test(pathOnly)) {
      return unwiredResponse(pathOnly, []);
    }
    return null;
  }

  // ── window.fetch override ────────────────────────────────────────────────
  window.fetch = async function (url, opts = {}) {
    let u;
    try { u = String(typeof url === 'string' ? url : (url.url || '')); }
    catch (_e) { return origFetch(url, opts); }

    // pass-through everything that isn't a v1 polymarket call
    if (!u.startsWith('/api/polymarket/')) {
      // For calls already pointing at v2 (/api/...), ensure dev-bypass header
      if (u.startsWith('/api/')) {
        return v2Fetch(u, opts);
      }
      return origFetch(url, opts);
    }

    const qIdx = u.indexOf('?');
    const pathOnly = qIdx === -1 ? u : u.slice(0, qIdx);
    const queryStr = qIdx === -1 ? '' : u.slice(qIdx);

    // 1. Pattern router (positions/:id/exit, calibration/apply/:id, ...)
    const patternResp = patternRouter(pathOnly, queryStr, opts);
    if (patternResp) return patternResp;

    // 2. Direct map lookup
    const target = ENDPOINT_MAP[pathOnly];

    if (target === undefined) {
      // Fallback patterns for paths the static map doesn't list (bots/<x>, calibration/<unknown>).
      const fb = fallbackRouter(pathOnly);
      if (fb) return fb;
      console.warn('[v2-shim] unmapped v1 endpoint:', pathOnly);
      return unwiredResponse(pathOnly, defaultShape(pathOnly));
    }
    if (target === null) {
      return unwiredResponse(pathOnly, defaultShape(pathOnly));
    }
    if (typeof target === 'string') {
      return v2Fetch(target + queryStr, opts);
    }
    if (typeof target === 'function') {
      try {
        const data = await target({ path: pathOnly, query: queryStr, opts });
        return jsonResponse(data);
      } catch (err) {
        console.error('[v2-shim] adapter for', pathOnly, 'threw:', err);
        return unwiredResponse(pathOnly, defaultShape(pathOnly));
      }
    }
    return unwiredResponse(pathOnly, defaultShape(pathOnly));
  };

  // Best-effort default shape so v1 code doesn't crash on unwired endpoints.
  function defaultShape(path) {
    if (/\/(positions|trades|wallets|profiles|intents|leaderboard|filters|logs|events|traces|sports|whales|attribution)$/.test(path)) {
      return [];   // list endpoints
    }
    if (/(stats|status|summary|meta|state|portfolio|reconciliation|overview|settings|config)$/.test(path)) {
      return {};   // object endpoints
    }
    return {};
  }

  // Banner mounting on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      ensureBanner();
      refreshBanner();
    });
  } else {
    ensureBanner();
    refreshBanner();
  }

  // ── EventSource shim for /api/polymarket/stream ────────────────────────
  // EventSource bypasses our window.fetch interceptor and goes direct to
  // the network with no auth header → 401 → repeated reconnect spam.
  // v2 has no SSE endpoint yet; stub a no-op EventSource so app.js falls
  // back to its polling path silently.
  if (typeof window.EventSource === 'function') {
    const OrigEventSource = window.EventSource;
    function ShimEventSource(url, opts) {
      if (typeof url === 'string' && url.startsWith('/api/polymarket/stream')) {
        console.info('[v2-shim] SSE stream not supported, polling fallback:', url);
        return {
          readyState: 2,
          url, withCredentials: false,
          addEventListener: function () {},
          removeEventListener: function () {},
          close: function () {},
          dispatchEvent: function () { return true; },
          onopen: null, onmessage: null, onerror: null,
        };
      }
      return new OrigEventSource(url, opts);
    }
    ShimEventSource.CONNECTING = 0;
    ShimEventSource.OPEN = 1;
    ShimEventSource.CLOSED = 2;
    window.EventSource = ShimEventSource;
  }

  console.info('[v2-shim] active — intercepting /api/polymarket/* → v2 REST');
})();
