/* Ora et Labora — system health card (W5-12) */

(function (App) {
  'use strict';

  const $ = App.$;

  function _dot(id, color) {
    const el = $(id);
    if (el) el.style.background = color;
  }

  function _val(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function _ageLabel(seconds) {
    if (seconds == null) return '—';
    if (seconds < 60) return Math.round(seconds) + 's ago';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
    return Math.round(seconds / 3600) + 'h ago';
  }

  function _freshColor(seconds, warnThreshold, critThreshold) {
    if (seconds == null) return 'var(--t3)';
    if (seconds < warnThreshold) return 'var(--grn)';
    if (seconds < critThreshold) return 'var(--amb)';
    return 'var(--red)';
  }

  App.refreshHealth = async function () {
    try {
      const data = await App.fetchJSON('/api/health');
      if (!data) return;

      // WS Feed
      const wsAlive = data.ws_feed && data.ws_feed.alive;
      const wsAge = data.ws_state_age_s;
      _dot('healthWsDot', wsAlive ? _freshColor(wsAge, 30, 120) : 'var(--red)');
      _val('healthWs', wsAlive ? _ageLabel(wsAge) : 'offline');

      // Price age (ws_state reflects last price update)
      _dot('healthPriceDot', _freshColor(wsAge, 30, 120));
      _val('healthPriceAge', _ageLabel(wsAge));

      // Trader
      const traderAlive = data.trader && data.trader.alive;
      _dot('healthTraderDot', traderAlive ? 'var(--grn)' : 'var(--red)');
      _val('healthTrader', traderAlive ? 'running' : 'stopped');

      // Decisions activity
      const decAge = data.decisions_age_s;
      _dot('healthDecisionsDot', _freshColor(decAge, 300, 900));
      _val('healthDecisions', _ageLabel(decAge));

      // Also update the header health pill using the richer /api/health status
      const healthEl = $('systemHealth');
      if (healthEl) {
        const st = data.status;
        const dotStyle = 'width:5px;height:5px;border-radius:50%;display:inline-block;background:';
        if (st === 'healthy') {
          healthEl.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--grn);padding:3px 9px;background:var(--grn-bg);border:1px solid var(--grn-brd);border-radius:20px';
          healthEl.innerHTML = '<span style="' + dotStyle + 'var(--grn)"></span>HEALTHY';
        } else if (st === 'degraded') {
          healthEl.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--amb);padding:3px 9px;background:var(--amb-bg);border:1px solid var(--amb-brd);border-radius:20px';
          healthEl.innerHTML = '<span style="' + dotStyle + 'var(--amb)"></span>DEGRADED';
        } else {
          healthEl.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--red);padding:3px 9px;background:var(--red-bg);border:1px solid var(--red-brd);border-radius:20px';
          healthEl.innerHTML = '<span style="' + dotStyle + 'var(--red)"></span>DOWN';
        }
      }
    } catch (e) {
      // Health fetch failed — show unknown state
      _dot('healthWsDot', 'var(--t3)');
      _dot('healthPriceDot', 'var(--t3)');
      _dot('healthTraderDot', 'var(--t3)');
      _dot('healthDecisionsDot', 'var(--t3)');
    }

    // F10 (audit D5 UI): freshness pill driven by /api/polymarket/meta.
    // Shows bot-alive + data age next to the header timestamp. Green when
    // bot alive and data fresh, amber when bot alive but data stale,
    // red when bot is down.
    try {
      const meta = await App.fetchJSON('/api/polymarket/meta');
      const pill = $('hdrFresh');
      const dot = $('hdrFreshDot');
      const text = $('hdrFreshText');
      if (meta && pill && dot && text) {
        const alive = !!meta.bot_alive;
        const hb = meta.last_bot_heartbeat_s_ago;
        const fresh = meta.data_freshness_s;
        pill.style.display = 'inline-flex';
        let cls = 'hdr-fresh';
        let label = '';
        if (!alive) {
          cls += ' bad';
          label = App.t('hdr.fresh_bot_offline');
          if (hb != null) label += ' · ' + _ageLabel(hb);
        } else if (fresh != null && fresh > 60) {
          cls += ' warn';
          label = App.t('hdr.fresh_data_stale', {age: _ageLabel(fresh)});
        } else {
          cls += ' ok';
          label = fresh != null ? _ageLabel(fresh) : App.t('hdr.fresh_ok');
        }
        pill.className = cls;
        text.textContent = label;
        const warnings = (meta.warnings || []).join(' · ');
        pill.title = warnings
          ? ('Warnings: ' + warnings)
          : ('Heartbeat: ' + _ageLabel(hb) + ' · Data: ' + _ageLabel(fresh));
      }
    } catch (e) {
      // silent — leave pill as is
    }

    // B1: Thread-level health from /api/polymarket/health. Drives the
    // bot-alive banner at the top of the page — only visible when at
    // least one required thread is stale/dead/unknown.
    try {
      const th = await App.fetchJSON('/api/polymarket/health');
      if (th && th.threads) {
        const banner = $('botAliveBanner');
        const bText = $('botAliveBannerText');
        const bThreads = $('botAliveBannerThreads');
        const problems = [];
        const niceName = {
          main_loop: 'trader',
          position_monitor: 'monitor',
          ws_feed: 'ws-feed',
          trade_reconciler: 'reconciler',
          chain_listener: 'chain',
        };
        Object.keys(th.threads).forEach(function (name) {
          const slot = th.threads[name];
          if (slot.state !== 'fresh') {
            const label = (niceName[name] || name);
            const age = slot.age_s == null ? '—' : Math.round(slot.age_s) + 's';
            problems.push(label + ' (' + slot.state + ', ' + age + ')');
          }
        });
        if (banner) {
          if (problems.length === 0 && th.status === 'healthy') {
            banner.style.display = 'none';
          } else {
            banner.style.display = 'flex';
            let msg = App.t('health.bot_online');
            if (th.status === 'down') {
              msg = App.t('health.bot_down');
              banner.className = 'bot-alive-banner bot-alive-banner-down';
            } else if (th.status === 'degraded') {
              msg = App.t('health.bot_degraded');
              banner.className = 'bot-alive-banner bot-alive-banner-warn';
            } else if (th.status === 'unknown') {
              msg = App.t('health.bot_unknown');
              banner.className = 'bot-alive-banner bot-alive-banner-warn';
            } else {
              banner.className = 'bot-alive-banner';
            }
            if (bText) bText.textContent = msg;
            if (bThreads) bThreads.textContent = problems.length
              ? problems.join(' · ')
              : '';
          }
        }
      }
    } catch (e) {
      // leave banner as-is on transient errors
    }

    // D3.3: Chain listener stats
    try {
      const chain = await App.fetchJSON('/api/polymarket/chain/stats');
      if (chain) {
        const connected = chain.connected;
        const mode = (chain.mode || 'http').toUpperCase();
        const evts = chain.events_received || 0;
        const whales = chain.whale_matches || 0;
        const reconnects = chain.reconnections || 0;
        const lastEvtAgo = chain.last_event_ago_s;
        const uptime = chain.uptime_s || 0;

        _dot('healthChainDot', connected
          ? _freshColor(lastEvtAgo, 30, 120)
          : 'var(--red)');
        _val('healthChain', connected
          ? mode + ' · ' + _ageLabel(lastEvtAgo)
          : 'disconnected');
        _val('healthChainEvents', evts + ' events · ' + whales + ' whales');
        _val('healthChainReconnects', reconnects + ' reconnects · ' + Math.round(uptime / 60) + 'm uptime');
      }
    } catch (e) {
      _dot('healthChainDot', 'var(--t3)');
      _val('healthChain', '—');
    }
  };

  // Auto-refresh health every 10 seconds
  setInterval(App.refreshHealth, 10000);
  // Initial fetch
  setTimeout(App.refreshHealth, 500);

})(window.App);
