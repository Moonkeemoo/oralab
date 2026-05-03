/* Ora et Labora — API fetching + loadCore + loadTabData + auto-refresh */

(function (App) {
  'use strict';

  const $ = App.$;
  const S = App.state;

  App.fetchJSON = async function (url, opts) {
    // Auto-add Content-Type for POST/PUT/PATCH with JSON body
    if (opts && opts.body && typeof opts.body === 'string') {
      opts.headers = Object.assign({'Content-Type': 'application/json'}, opts.headers || {});
    }
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };

  function _setHealthOffline() {
    const el = $('systemHealth');
    if (!el) return;
    el.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--red);padding:3px 9px;background:var(--red-bg);border:1px solid var(--red-brd);border-radius:20px';
    el.innerHTML = '<span style="width:5px;height:5px;border-radius:50%;background:var(--red);display:inline-block"></span>OFFLINE';
  }

  // ─── Core state: single /state call replaces 4 separate fetches ───────────
  App.loadCore = async function () {
    const modeParam = S.currentMode ? '?mode=' + S.currentMode : '';
    try {
      const data = await App.fetchJSON('/api/polymarket/state' + modeParam);
      S.portfolio  = data.portfolio;
      S.positions  = data.positions;
      S.history    = data.history;
      if (!S.settingsDirty && !S._settingsSaveGrace) S.riskSettings = data.settings || S.riskSettings;
    } catch (e) {
      // Fallback to individual endpoints if consolidated /state fails
      console.warn('[loadCore] /state failed, falling back to individual endpoints:', e.message);
      const [portfolio, positions, history] = await Promise.all([
        App.fetchJSON('/api/polymarket/portfolio' + modeParam),
        App.fetchJSON('/api/polymarket/positions' + modeParam),
        App.fetchJSON('/api/polymarket/history' + modeParam),
      ]);
      S.portfolio  = portfolio;
      S.positions  = positions;
      S.history    = history;
      App.fetchJSON('/api/polymarket/settings').then(rs => { S.riskSettings = rs || {}; }).catch(e => console.warn('[loadCore] settings fallback failed:', e.message));
    }
  };

  // ─── Tab-specific lazy loading ────────────────────────────────────────────
  App.loadTabData = async function (tab) {
    tab = tab || S.activeTab;

    if (tab === 'filters') {
      try {
        const data = await App.fetchJSON('/api/polymarket/tab/filters?mode=' + (S.currentMode || ''));
        S.filters = data.filters || [];
        S.filterSavedConfig = data.config || {};
        S.rejectStats = data.reject_stats || {};
        S.convergenceStats = data.convergence_stats || {};
        S.recentRejections = data.recent_rejections || [];
        if (!S.settingsDirty && !S._settingsSaveGrace) S.riskSettings = data.settings || S.riskSettings;
        App.renderFilters();
        App.renderSettingsSections();
      } catch (e) { console.error('[loadTabData:filters]', e); }
    }

    if (tab === 'whales') {
      try {
        await Promise.all([
          App.fetchJSON('/api/polymarket/wallets').then(d => { S.wallets = Array.isArray(d) ? d : (d.wallets || []); }),
          App.fetchJSON('/api/polymarket/intents').then(d => { S.intents = Array.isArray(d) ? d : []; }),
          App.fetchJSON('/api/polymarket/leaderboard').then(d => { S.lbData = d || []; }).catch(() => { S.lbData = []; }),
          (S.profiles.length ? Promise.resolve() : App.fetchJSON('/api/polymarket/profiles').then(d => {
            S.profiles = Array.isArray(d) ? d : [];
            S.profilesMap = {};
            S.profiles.forEach(p => {
              S.profilesMap[p.wallet] = p;
              S.profilesMap[(p.wallet || '').toLowerCase()] = p;
            });
          })),
        ]);
        App.renderWhales();
      } catch (e) { console.error('[loadTabData:whales]', e); }
    }

    if (tab === 'calibration') {
      try { await App.loadCalibration(); } catch (e) { console.error('[calibration]', e); }
    }

    if (tab === 'trades') {
      App.loadTrades();
    }

    if (tab === 'timing') {
      App.loadTimingData();
    }

    // F16: positions tab removed — live reconciliation data is still loaded
    // here so that ghost/phantom badges can be shown on the trades tab.
    if (tab === 'trades' && S.currentMode === 'live' && App.loadReconciliation) {
      App.loadReconciliation();
    }

    if (tab === 'logs') {
      App.renderLogs();
    }
  };

  // ─── loadAll: backward-compatible entry point ─────────────────────────────
  App.loadAll = async function () {
    try {
      await App.loadCore();

      S.serverOnline = true;
      App.render();
      App.loadModeAndBudget();

      // Load active tab data (non-blocking)
      App.loadTabData(S.activeTab);

      // Background: profiles (needed for positions + wallets + leaderboard)
      if (!S.profiles.length) {
        App.fetchJSON('/api/polymarket/profiles').then(data => {
          S.profiles = Array.isArray(data) ? data : [];
          S.profilesMap = {};
          S.profiles.forEach(p => {
            S.profilesMap[p.wallet] = p;
            S.profilesMap[(p.wallet || '').toLowerCase()] = p;
          });
        }).catch(e => console.warn('[loadAll] profiles:', e.message));
      }

      // F16b: wallets for tab badge — fetch once in background so the
      // 🐋 Whales tab counter is live without having to click through.
      if (!Array.isArray(S.wallets) || !S.wallets.length) {
        App.fetchJSON('/api/polymarket/wallets').then(d => {
          S.wallets = Array.isArray(d) ? d : (d && d.wallets) || [];
          App.renderTabBadges();
        }).catch(e => console.warn('[loadAll] wallets:', e.message));
      }

      // Background: filters (always needed for pipeline reference)
      if (!S.filters.length) {
        App.fetchJSON('/api/polymarket/filters').then(data => {
          S.filters = Array.isArray(data) ? data : [];
        }).catch(e => console.warn('[loadAll] filters:', e.message));
      }

      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const tsEl = $('ts');
      if (tsEl) tsEl.textContent = App.t('api.updated') + now;
      const trEl = $('tr');
      if (trEl) trEl.textContent = App.t('api.updated') + now;
    } catch (err) {
      S.serverOnline = false;
      console.error('[loadAll] error', err);
      _setHealthOffline();
    }
  };

  App.startAutoRefresh = function () {
    App.stopAutoRefresh();
    // L24: 5s → 2s. Exit SLO is now 30s (position_monitor 0.5 s tick,
    // ws_state.json flush ~100 ms, mark cache TTL 2 s), so a 5s
    // dashboard poll was leaving ~10s of perceived latency between a
    // real price tick and the user seeing it. 2 s matches the REST
    // midpoint/price cache TTL exactly, so bumping poll frequency does
    // not add network cost — it just stops the UI from lagging behind
    // the bot's actual state. CLOB headroom is 150 req/s on single
    // queries, we're running ~15 open positions × 0.5 Hz = <10 req/s.
    S.refreshTimer = setInterval(App.loadAll, 2000);
  };

  App.stopAutoRefresh = function () {
    if (S.refreshTimer) {
      clearInterval(S.refreshTimer);
      S.refreshTimer = null;
    }
  };

  // L27: Browsers throttle setInterval to ~1/min in background tabs.
  // When user returns, data can be 30-60s stale. Fix: on visibility
  // change back to foreground, immediately loadAll + restart interval
  // (which resets the 2s cadence). Also reconnect SSE if it went stale.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      App.loadAll();
      App.startAutoRefresh();
      if (typeof App.connectSSE === 'function') {
        App.connectSSE();
      }
      if (typeof App.refreshHealth === 'function') {
        App.refreshHealth();
      }
      if (typeof App.loadKPIs === 'function') {
        App.loadKPIs();
      }
    }
  });

  // ─── tab badges ───────────────────────────────────────────────────────────
  // Derived from S.positions + S.history + S.wallets, which are refreshed
  // on every loadCore() tick (2s, L24). This keeps the tab counters live even
  // when the user is sitting on a tab that is NOT the one being counted
  // (previously renderTrades() / renderWhales() were the only writers, so
  // counts froze whenever the user left those tabs).
  App.renderTabBadges = function () {
    const openCount = (S.positions || []).length;
    const histCount = (S.history && Array.isArray(S.history.trades)) ? S.history.trades.length : 0;
    const tradesEl = $('tradesCount');
    if (tradesEl) tradesEl.textContent = openCount + histCount;

    const walEl = $('walCount');
    if (walEl) {
      const wl = Array.isArray(S.wallets) ? S.wallets.length : 0;
      // Only overwrite when we have data, so an initial 0 doesn't clobber
      // the value renderWhales() already wrote after a tab visit.
      if (wl > 0) walEl.textContent = wl;
    }
  };

  // ─── render dispatcher ────────────────────────────────────────────────────
  App.render = function () {
    App.renderPortfolio();
    App.renderPositions();
    if (App.renderHistory) App.renderHistory();
    App.redrawChart();
    App.renderTabBadges();
  };

})(window.App);
