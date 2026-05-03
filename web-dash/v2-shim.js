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

    // ── UNWIRED — v1 features without v2 backend support yet ──────────────
    '/api/polymarket/profiles':                       null,   // bulk whale profile dump → use per-whale /api/whales/:addr/profile
    '/api/polymarket/leaderboard':                    null,   // whale leaderboard view
    '/api/polymarket/intents':                        null,   // pre-trade intents queue
    '/api/polymarket/intents/stats':                  null,
    '/api/polymarket/budget':                         null,   // budget guardrails view
    '/api/polymarket/budget/reset':                   null,
    '/api/polymarket/exposure':                       null,   // sector exposure tracker
    '/api/polymarket/exposure/reset':                 null,
    '/api/polymarket/conviction_stats':               null,   // whale conviction histogram
    '/api/polymarket/diagnostic/groups':              null,   // diagnostic groupings
    '/api/polymarket/lifecycle':                      null,   // position lifecycle dashboard
    '/api/polymarket/lifecycle/events':               null,
    '/api/polymarket/live-marks':                     null,   // mark refresh dashboard
    '/api/polymarket/poke-mark':                      null,   // manual mark refresh
    '/api/polymarket/logs':                           null,   // log tail (v2 logs go to stdout/OTEL)
    '/api/polymarket/logs/clear':                     null,
    '/api/polymarket/trade-decisions':                null,   // explainable trade-decision log
    '/api/polymarket/trade-decisions/clear':          null,
    '/api/polymarket/decision-log':                   null,   // legacy decision log
    '/api/polymarket/decision-log/clear':             null,
    '/api/polymarket/rejects/recent':                 null,   // covered partly by tab/filters adapter (recent_rejections=[])
    '/api/polymarket/reconciliation':                 null,   // ghost / phantom reconciliation report
    '/api/polymarket/chain/stats':                    null,   // RPC + WS health card
    '/api/polymarket/stream':                         null,   // SSE event stream (best-effort gracefully off)
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

    // /api/polymarket/bots/<name>/<action> → UNWIRED
    if (/^\/api\/polymarket\/bots\//.test(pathOnly)) {
      return Promise.resolve(unwiredResponse(pathOnly, { ok: false, reason: 'unwired' }));
    }
    // /api/polymarket/calibration/<unknown> → UNWIRED
    if (/^\/api\/polymarket\/calibration\//.test(pathOnly)) {
      return Promise.resolve(unwiredResponse(pathOnly, []));
    }
    return null;   // not handled here — caller falls through to default unwired
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

  console.info('[v2-shim] active — intercepting /api/polymarket/* → v2 REST');
})();
