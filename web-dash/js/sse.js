/* Ora et Labora — Server-Sent Events consumer
 *
 * Connects to /api/polymarket/stream and updates S.portfolio / S.positions
 * in place so the UI reflects bot-side changes in near-real-time (<1s)
 * without the 5s polling cycle that used to drive loadAll.
 *
 * Behavior:
 *   • On each `state` event, patch S and trigger a lightweight re-render.
 *   • `heartbeat` events keep the connection alive and are logged at debug.
 *   • On `error` or socket close, EventSource auto-reconnects. After two
 *     consecutive reconnect failures we fall back to the classic polling
 *     loop so the dashboard never goes dark on a broken proxy.
 *
 * See AUDIT-LIVE-MODE-TRUTH.md B2.
 */

(function (App) {
  'use strict';

  const S = App.state;

  // Feature flag — users can disable via localStorage (debug) or query string.
  // Enabled by default; if the env doesn't speak EventSource we fall back.
  const _SSE_ENABLED = (function () {
    try {
      if (typeof EventSource === 'undefined') return false;
      if (typeof window !== 'undefined' && window.location) {
        const p = new URLSearchParams(window.location.search);
        if (p.get('sse') === '0') return false;
      }
      return true;
    } catch (_e) { return false; }
  })();

  // Reconnect / fallback bookkeeping
  let _es = null;
  let _consecutiveFailures = 0;
  let _fallbackActive = false;
  let _lastStateTs = 0;
  const _MAX_FAILURES_BEFORE_FALLBACK = 2;

  function _patchState(payload) {
    if (!payload) return;
    if (payload.portfolio) S.portfolio = payload.portfolio;
    if (Array.isArray(payload.positions)) S.positions = payload.positions;
    if (payload.ts) _lastStateTs = payload.ts;
  }

  function _rerender() {
    try { if (App.renderPortfolio) App.renderPortfolio(); } catch (_e) {}
    try { if (App.renderPositions) App.renderPositions(); } catch (_e) {}
    try { if (App.colorPrices) App.colorPrices(); } catch (_e) {}
  }

  function _fallbackToPolling(reason) {
    if (_fallbackActive) return;
    _fallbackActive = true;
    console.warn('[sse] falling back to polling:', reason);
    if (typeof App.startAutoRefresh === 'function') {
      App.startAutoRefresh();
    }
  }

  function _stopPollingIfActive() {
    // F12: previously stopped the polling timer the moment the first SSE
    // state event arrived. That worked for positions/portfolio (which the
    // SSE payload patches), but the SSE stream does NOT carry filter
    // pipeline data, reject_counts, recent_rejections, profiles, or any
    // other tab-level state — so those panels froze until a full reload.
    //
    // The new behaviour: SSE acts as a *fast overlay* for positions and
    // portfolio (sub-second), while the 5s polling loop keeps refreshing
    // everything else. Polling is cheap, the dashboard is single-user,
    // and the overlap is harmless because both sources hit the same
    // adapter functions.
    //
    // We intentionally keep the function so existing call sites still
    // wire through, but it is now a no-op when SSE is healthy.
    return;
  }

  App.connectSSE = function () {
    if (!_SSE_ENABLED) {
      _fallbackToPolling('EventSource unavailable');
      return;
    }
    if (_es) {
      try { _es.close(); } catch (_e) {}
      _es = null;
    }

    const mode = S.currentMode || '';
    const url = '/api/polymarket/stream' + (mode ? '?mode=' + encodeURIComponent(mode) : '');

    let es;
    try {
      es = new EventSource(url);
    } catch (e) {
      _consecutiveFailures += 1;
      console.warn('[sse] construct failed:', e && e.message);
      if (_consecutiveFailures >= _MAX_FAILURES_BEFORE_FALLBACK) {
        _fallbackToPolling('construct threw');
      }
      return;
    }
    _es = es;

    es.addEventListener('state', function (ev) {
      try {
        const data = JSON.parse(ev.data);
        _patchState(data);
        _rerender();
        _consecutiveFailures = 0;
        _stopPollingIfActive();
      } catch (e) {
        console.warn('[sse] bad state payload:', e && e.message);
      }
    });

    es.addEventListener('heartbeat', function (ev) {
      // Heartbeats include `lifetime_reached` when the server is about to
      // close this connection; EventSource handles reconnection for us.
      try {
        const d = JSON.parse(ev.data);
        if (d && d.reason === 'lifetime_reached') {
          // Expected: server rotates the connection so proxies don't leak.
          // EventSource will reconnect automatically.
        }
      } catch (_e) {}
    });

    es.addEventListener('error', function (ev) {
      // EventSource fires onerror for both transient blips and permanent
      // failures. readyState===CLOSED means "give up, reconstruct".
      const closed = es.readyState === EventSource.CLOSED;
      _consecutiveFailures += 1;
      if (closed) {
        try { es.close(); } catch (_e) {}
        _es = null;
        if (_consecutiveFailures >= _MAX_FAILURES_BEFORE_FALLBACK) {
          _fallbackToPolling('repeated close events');
        } else {
          // Try once more after a short delay.
          setTimeout(function () { App.connectSSE(); }, 2000);
        }
      }
      // If still CONNECTING, let the browser retry transparently.
    });
  };

  App.disconnectSSE = function () {
    if (_es) {
      try { _es.close(); } catch (_e) {}
      _es = null;
    }
  };

  // Expose for debugging from the console.
  App.sseStats = function () {
    return {
      enabled: _SSE_ENABLED,
      connected: !!_es && _es.readyState === EventSource.OPEN,
      consecutiveFailures: _consecutiveFailures,
      fallbackActive: _fallbackActive,
      lastStateTs: _lastStateTs,
    };
  };

})(window.App);
