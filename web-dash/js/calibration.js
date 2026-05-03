(function (App) {
  'use strict';

  const S = App.state;

  // Active sub-tab state
  S.calActiveTab = 'overview';
  S.calLoaded = {};  // track which tabs have loaded data

  const CalShell = {
    switchTab(name, btn) {
      S.calActiveTab = name;

      // Update tab buttons
      document.querySelectorAll('.cal-sub-tab').forEach(t => t.classList.remove('active'));
      if (btn) btn.classList.add('active');
      else {
        const el = document.querySelector(`.cal-sub-tab[data-tab="${name}"]`);
        if (el) el.classList.add('active');
      }

      // Show/hide content panes
      document.querySelectorAll('.cal-tab-content').forEach(c => c.style.display = 'none');
      const pane = document.getElementById('calTab' + name.charAt(0).toUpperCase() + name.slice(1));
      if (pane) pane.style.display = '';

      // Lazy load data for tab on first visit
      if (!S.calLoaded[name]) {
        S.calLoaded[name] = true;
        this._loadTab(name);
      }
    },

    async _loadTab(name) {
      const loaders = {
        overview: () => window.CalOverview && CalOverview.load(),
        analytics: () => window.CalAnalytics && CalAnalytics.load(),
        exit: () => window.CalExit && CalExit.load(),
        whales: () => window.CalWhales && CalWhales.load(),
        sports: () => window.CalSports && CalSports.load(),
        log: () => window.CalLog && CalLog.load(),
        settings: () => window.CalSettings && CalSettings.load(),
      };
      const fn = loaders[name];
      if (fn) {
        try { await fn(); } catch (e) { console.error('[cal] load', name, e); }
      }
    },

    async setMode(mode) {
      try {
        const resp = await App.fetchJSON('/api/polymarket/calibration/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
        if (resp.success) {
          App.toast(App.t('cal.mode_set', {mode}), 'ok');
          this._updateModeBadge(mode);
          // Reload overview if active
          if (S.calActiveTab === 'overview') {
            S.calLoaded.overview = false;
            this.switchTab('overview');
          }
        } else {
          App.toast(resp.error || App.t('cal.error'), 'err');
        }
      } catch (e) {
        App.toast(App.t('cal.mode_change_err'), 'err');
      }
    },

    async runNow() {
      try {
        App.toast(App.t('cal.run_starting'), 'info');
        const resp = await App.fetchJSON('/api/polymarket/calibration/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (resp.success) {
          App.toast(App.t('cal.run_done'), 'ok');
          // Reload current tab
          S.calLoaded[S.calActiveTab] = false;
          this.switchTab(S.calActiveTab);
        } else {
          App.toast(resp.error || App.t('cal.run_err'), 'err');
        }
      } catch (e) {
        App.toast(App.t('cal.run_start_err'), 'err');
      }
    },

    _updateModeBadge(mode) {
      const badge = document.getElementById('calModeBadge');
      if (!badge) return;
      badge.textContent = mode.toUpperCase();
      badge.className = 'cal-mode-badge';
      if (mode === 'auto') badge.classList.add('cal-mode-auto');
      else if (mode === 'watch') badge.classList.add('cal-mode-watch');
      else badge.classList.add('cal-mode-manual');

      // Update mode buttons
      document.querySelectorAll('.cal-mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
      });
    },

    updateStatusBar(data) {
      const kpi = data.kpi || {};
      const history = data.history || [];
      const recs = data.recommendations || [];

      const tsEl = document.getElementById('calLastTs');
      if (tsEl) {
        const ts = data.ts;
        if (ts) {
          const agoMin = Math.round((Date.now() / 1000 - ts) / 60);
          const agoStr = agoMin < 1 ? App.t('cal.just_now')
            : agoMin < 60 ? App.t('cal.min_ago', {min: agoMin})
            : App.t('cal.hours_ago', {h: Math.round(agoMin / 60)});
          const interval = data.cycle_interval_s || 0;
          let nextStr = '';
          if (interval > 0) {
            const nextTs = ts + interval;
            const diffMin = Math.max(0, Math.round((nextTs - Date.now() / 1000) / 60));
            const nextTime = new Date(nextTs * 1000).toLocaleTimeString('uk-UA', {hour:'2-digit', minute:'2-digit'});
            nextStr = ' · ' + App.t('cal.next_at', {time: nextTime});
          }
          tsEl.textContent = agoStr + nextStr;
        } else {
          tsEl.textContent = '—';
        }
      }

      const dpEl = document.getElementById('calDataPoints');
      if (dpEl) dpEl.textContent = kpi.total_trades || 0;

      const histEl = document.getElementById('calHistoryCount');
      if (histEl) histEl.textContent = history.length;

      // Recommendations badge
      const badge = document.getElementById('calRecsBadge');
      if (badge) {
        if (recs.length > 0) {
          badge.textContent = recs.length;
          badge.style.display = '';
        } else {
          badge.style.display = 'none';
        }
      }

      this._updateModeBadge(data.mode || 'manual');
    },
  };

  // Make globally accessible
  window.CalShell = CalShell;

  // Auto-refresh active calibrator tab every 15s
  let _calRefreshTimer = null;
  function _startCalRefresh() {
    if (_calRefreshTimer) return;
    _calRefreshTimer = setInterval(() => {
      // Only refresh if calibration tab is visible
      const calPane = document.getElementById('calibration');
      if (!calPane || calPane.style.display === 'none') return;
      const tab = S.calActiveTab || 'overview';
      S.calLoaded[tab] = false;
      CalShell._loadTab(tab);
      S.calLoaded[tab] = true;
    }, 15000);
  }

  // Register with App for tab activation
  const origLoad = App.loadCalibration || function(){};
  App.loadCalibration = function () {
    // Load overview on first activation
    CalShell.switchTab(S.calActiveTab || 'overview');
    _startCalRefresh();
  };

  // Also handle when calibration tab becomes active via sw()
  const origSw = window.sw;
  if (origSw) {
    window.sw = function(pane, btn) {
      origSw(pane, btn);
      if (pane === 'calibration') {
        CalShell.switchTab(S.calActiveTab || 'overview');
        _startCalRefresh();
      }
    };
  }

})(window.App);
