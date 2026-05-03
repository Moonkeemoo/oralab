(function (App) {
  'use strict';

  const $ = App.$;
  const S = App.state;
  const esc = App.esc;

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
      setTimeout(() => App.loadAll(), 1200);
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
    if (refreshBtn) refreshBtn.addEventListener('click', App.loadAll);

    // Top Up button
    const topUpBtn = $('topUpBtn');
    if (topUpBtn) {
      topUpBtn.addEventListener('click', async () => {
        if (S.currentMode === 'live') {
          window.open('https://polymarket.com/?r=moonkee', '_blank');
          return;
        }
        topUpBtn.disabled = true;
        try {
          await fetch('/api/polymarket/topup', { method: 'POST' });
          await App.loadAll();
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
        restartBtn.textContent = App.t('hdr.restarting');
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
          if (attempts > 20) { clearInterval(poll); restartBtn.disabled = false; restartBtn.textContent = App.t('hdr.restart'); }
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
        resetAllBtn.textContent = App.t('hdr.resetting');
        try {
          const resp = await fetch('/api/polymarket/bots/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
          });
          const data = await resp.json();
          if (data.error) { App.toast(data.error, 'err'); return; }
          const label = data.mode === 'hard' ? 'Hard reset' : 'Soft reset';
          App.toast(App.t('controls.reset_ok', {label: label, deleted: data.deleted || 0}), 'ok', 5000);
          App.clearLeaderboardCache();
          // Reset calibrator lazy-load cache so tabs re-fetch fresh data
          if (App.state.calLoaded) App.state.calLoaded = {};
          App.loadAll();
        } catch (err) {
          App.toast(App.t('controls.reset_err', {error: err.message}), 'err');
        } finally {
          resetAllBtn.disabled = false;
          resetAllBtn.textContent = App.t('hdr.reset');
        }
      }

      $('resetSoft').addEventListener('click', () => doReset(
        'soft',
        App.t('controls.reset_soft_confirm')
      ));

      $('resetHard').addEventListener('click', () => {
        if (!confirm(App.t('controls.reset_hard_confirm1'))) return;
        if (!confirm(App.t('controls.reset_hard_confirm2'))) return;
        doReset('hard', null);
      });
    }

    // Filter buttons
    const filterApplyBtn = $('filterApplyBtn');
    const filterSaveBtn  = $('filterSaveBtn');
    if (filterApplyBtn) filterApplyBtn.addEventListener('click', () => App._saveFilterConfig(true));
    if (filterSaveBtn)  filterSaveBtn.addEventListener('click',  () => App._saveFilterConfig(true));

    // Filter bot selector
    const filterBotSel = $('filterBotSel');
    if (filterBotSel) {
      filterBotSel.addEventListener('change', () => {
        S.selectedBotName = filterBotSel.value;
        App.renderFilters();
      });
    }

    // Filter preset selector
    const filterPresetSel = $('filterPresetSel');
    if (filterPresetSel) {
      filterPresetSel.addEventListener('change', () => {
        const preset = filterPresetSel.value;
        if (preset) App._applyPreset(preset);
      });
    }
    const savePresetBtn = $('filterSavePresetBtn');
    if (savePresetBtn) savePresetBtn.addEventListener('click', App._savePreset);
    const restoreBtn = $('filterRestoreBtn');
    if (restoreBtn) restoreBtn.addEventListener('click', async () => {
      if (!confirm(App.t('filters.restore_confirm'))) return;
      try {
        const mode = App.getFilterMode();
        const resp = await fetch('/api/polymarket/filters/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        S.filterSavedConfig = data.config || {};
        S.filterEdits = {};
        const filtersData = await App.fetchJSON('/api/polymarket/filters');
        S.filters = filtersData;
        App.renderFilters();
        App.flashBtn(restoreBtn, App.t('filters.restored'));
      } catch (e) { App.toast(App.t('filters.restore_err', {error: e.message}), 'err'); }
    });

    // Wallet discovery button — with live progress polling
    const discoverBtn  = $('discoverBtn');
    const discoverStop = $('discoverStopBtn');
    if (discoverBtn) {
      let _discoverPoll = null;

      function _discoverLabel(st) {
        if (!st || !st.running) return App.t('disco.btn');
        if (st.phase === 'enriching' && st.total > 0)
          return App.t('disco.progress', {progress: st.progress, total: st.total});
        if (st.phase === 'saving') return App.t('disco.saving');
        return App.t('disco.running');
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
          const st = await App.fetchJSON('/api/polymarket/wallets/discover/status');
          discoverBtn.textContent = _discoverLabel(st);
          if (!st.running) {
            _stopDiscoverPoll();
            _setRunning(false);
            if (st.phase === 'done') {
              discoverBtn.textContent = App.t('disco.done', {new_wallets: st.new_wallets, total_wallets: st.total_wallets});
              setTimeout(() => { discoverBtn.textContent = App.t('disco.btn'); }, 4000);
              App.loadAll();
            } else if (st.phase === 'stopped') {
              discoverBtn.textContent = App.t('disco.stopped');
              setTimeout(() => { discoverBtn.textContent = App.t('disco.btn'); }, 3000);
            } else if (st.phase === 'error') {
              discoverBtn.textContent = App.t('disco.error');
              setTimeout(() => { discoverBtn.textContent = App.t('disco.btn'); }, 4000);
            }
          }
        } catch { _stopDiscoverPoll(); _setRunning(false); discoverBtn.textContent = App.t('disco.btn'); }
      }

      // Check if already running on page load
      (async () => {
        try {
          const st = await App.fetchJSON('/api/polymarket/wallets/discover/status');
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
        discoverBtn.textContent = App.t('disco.running');
        try {
          const resp = await fetch('/api/polymarket/wallets/discover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ count, source, category }),
          });
          const data = await resp.json();
          if (resp.status === 409) {
            discoverBtn.textContent = App.t('disco.already_running');
            _stopDiscoverPoll();
            _discoverPoll = setInterval(_pollDiscoverStatus, 2000);
            return;
          }
          if (data.error) { App.toast(data.error, 'err'); _setRunning(false); discoverBtn.textContent = App.t('disco.btn'); return; }
          _stopDiscoverPoll();
          _discoverPoll = setInterval(_pollDiscoverStatus, 2000);
        } catch (err) {
          App.toast(App.t('disco.err_toast', {error: err.message}), 'err');
          _setRunning(false);
          discoverBtn.textContent = App.t('disco.btn');
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
            discoverBtn.textContent = App.t('disco.stopped');
            setTimeout(() => { discoverBtn.textContent = App.t('disco.btn'); }, 3000);
          } catch { /* ignore */ } finally {
            discoverStop.disabled = false;
          }
        });
      }
    }

    // Calibration controls are wired via onclick in HTML (calTogglePause, calRunNow, calRunAi)

    // Start All / Stop All
    const ALL_BOTS = ['trader', 'ws_feed', 'rtds_feed', 'calibrator'];
    const startAllBtn = $('startAllBots');
    const stopAllBtn = $('stopAllBots');
    if (startAllBtn) {
      startAllBtn.addEventListener('click', async () => {
        startAllBtn.disabled = true;
        for (const bot of ALL_BOTS) {
          try { await fetch('/api/polymarket/bots/' + bot + '/start', { method: 'POST' }); } catch {}
        }
        setTimeout(() => { App.loadAll(); startAllBtn.disabled = false; }, 2000);
      });
    }
    if (stopAllBtn) {
      stopAllBtn.addEventListener('click', async () => {
        if (!confirm(App.t('controls.stop_all_confirm'))) return;
        stopAllBtn.disabled = true;
        for (const bot of ALL_BOTS) {
          try { await fetch('/api/polymarket/bots/' + bot + '/stop', { method: 'POST' }); } catch {}
        }
        setTimeout(() => { App.loadAll(); stopAllBtn.disabled = false; }, 2000);
      });
    }
  }

  App.botAction = botAction;
  App.wireAll = wireAll;

})(window.App);
