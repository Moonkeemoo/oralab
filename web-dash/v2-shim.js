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

  // ─── ENDPOINT MAP ────────────────────────────────────────────────────────
  // value:
  //   string                      → forward to that v2 path (query preserved)
  //   async fn({path, query, opts}) → return a JS object → wrapped to Response
  //   null                        → UNWIRED with empty fallback
  //   {fallback, _unwired:true}   → UNWIRED with custom fallback shape
  // ─────────────────────────────────────────────────────────────────────────
  const ENDPOINT_MAP = {
    // ── Core read paths ────────────────────────────────────────────────────
    '/api/polymarket/health': '/api/health',
    '/api/polymarket/kpi': '/api/kpi',
    '/api/polymarket/positions': '/api/positions',
    '/api/polymarket/history': '/api/history',

    // /state — v1 consolidated read; reassemble from 4 v2 calls
    '/api/polymarket/state': async () => {
      const [positions, history, settings, kpi] = await Promise.allSettled([
        v2Get('/api/positions'),
        v2Get('/api/history'),
        v2Get('/api/exit_config'),
        v2Get('/api/kpi'),
      ]);
      const portfolio = await safeBuildPortfolio(kpi.value);
      return {
        portfolio,
        positions: positions.status === 'fulfilled' ? positions.value : [],
        history:   history.status === 'fulfilled'  ? history.value   : { trades: [] },
        settings:  settings.status === 'fulfilled' ? settings.value  : {},
      };
    },

    // /portfolio — v1 returned {balance, equity, pnl, ...}; map from /balance + /kpi
    '/api/polymarket/portfolio': async () => safeBuildPortfolio(await safeGet('/api/kpi')),

    '/api/polymarket/usdc-balance': async () => {
      const b = await safeGet('/api/balance');
      return { balance: b?.usdc ?? b?.balance ?? 0 };
    },

    // Settings (v1 used /settings → exit knobs); map to /exit_config
    '/api/polymarket/settings': '/api/exit_config',

    // Status / mode
    '/api/polymarket/trading-mode': async () => {
      const s = await safeGet('/api/status');
      return { mode: (s?.mode || 'DRY').toLowerCase(), kill_switch: !!s?.killSwitch };
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

    // Whales
    '/api/polymarket/wallets': async () => {
      const r = await safeGet('/api/whales?limit=2000');
      // v2 returns {items, total, ...} — v1 expects either array OR {wallets: [...]}
      return Array.isArray(r) ? r : (r?.items ?? []);
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

    // Trades — v1 endpoint distinct from /history; map to /history (already provides trades)
    '/api/polymarket/trades': async () => {
      const h = await safeGet('/api/history');
      return Array.isArray(h) ? h : (h?.trades ?? []);
    },

    // Kill-switch (POST/GET both routed)
    '/api/polymarket/kill-switch': '/api/kill_switch',

    // ── Calibration ────────────────────────────────────────────────────────
    '/api/polymarket/calibration/status': '/api/calibrator/status',
    '/api/polymarket/calibration/sports': '/api/calibrator/sport',
    '/api/polymarket/calibration/attribution': '/api/calibrator/attribution',
    '/api/polymarket/calibration/traces': '/api/calibrator/trace',
    '/api/polymarket/calibration/bayesian': '/api/calibrator/beliefs',
    '/api/polymarket/calibration/settings': '/api/calibrator/settings',
    '/api/polymarket/calibration/mode': '/api/calibrator/mode',
    '/api/polymarket/calibration/run': '/api/calibrator/run',
    '/api/polymarket/calibration/whales': async () => {
      // v1: list of whale-related calibration items.  v2 has /beliefs?dim=whale
      const b = await safeGet('/api/calibrator/beliefs?dim=whale');
      return b ?? [];
    },
    '/api/polymarket/calibration/overview': async () => {
      const [snap, recs] = await Promise.allSettled([
        v2Get('/api/calibrator/snapshot'),
        v2Get('/api/calibrator/recommendations'),
      ]);
      return {
        snapshot: snap.status === 'fulfilled' ? snap.value : {},
        recommendations: recs.status === 'fulfilled' ? recs.value : [],
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
        total_trades: 0,           // v2 doesn't aggregate yet; safe default
        confidence: w.confidence || 0,
        sm_score: w.smScore || 0,
        tracked: w.tracked,
      }));
    },

    // /budget — current budget + allocated/free + history (v1 expects history array)
    '/api/polymarket/budget': async () => {
      const bal = await safeGet('/api/balance');
      return {
        budget: bal?.totalBudgetUsd ?? 0,
        allocated: bal?.allocatedUsd ?? 0,
        free: bal?.freeUsd ?? 0,
        mode: bal?.mode ?? 'DRY',
        history: [],               // v2 doesn't track yet; safe empty
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
    '/api/polymarket/bots/':                          null,   // /bots/<name>/<action> — service controls
    '/api/polymarket/bots/reset':                     null,
    '/api/polymarket/bots/trader/restart':            null,
    '/api/polymarket/wallets/discover':               null,   // whale-discovery batch job
    '/api/polymarket/wallets/discover/status':        null,
    '/api/polymarket/wallets/discover/stop':          null,
    '/api/polymarket/wallets/reset':                  null,
    '/api/polymarket/calibration/configs':            null,   // saved cal-configs library
    '/api/polymarket/calibration/copy':               null,
    '/api/polymarket/calibration/copy-key':           null,
    '/api/polymarket/calibration/exit':               null,   // exit-knob proposals (no v2 dim yet)
    '/api/polymarket/calibration/skip':               null,
    '/api/polymarket/calibration/pause':              null,
    '/api/polymarket/calibration/reject':             null,
    '/api/polymarket/calibration/approve':            null,
    '/api/polymarket/calibration/rollback':           null,   // wired via /api/calibrator/rollback/:id (patternRouter)
    '/api/polymarket/calibration/ai':                 null,
    '/api/polymarket/calibration/clear-history':      null,
  };

  // Helpers used by adapters
  async function safeGet(path) {
    try { return await v2Get(path); } catch (_e) { return null; }
  }
  async function safeBuildPortfolio(kpi) {
    const bal = await safeGet('/api/balance');
    const usdc = bal?.usdc ?? bal?.balance ?? 0;
    return {
      balance: usdc,
      equity:  (kpi?.equity ?? usdc),
      pnl:     kpi?.pnl_total_usd ?? 0,
      pnl_pct: kpi?.pnl_total_pct ?? 0,
      trades:  kpi?.trades_total ?? 0,
      win_rate: kpi?.win_rate ?? 0,
      ...kpi,
    };
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
