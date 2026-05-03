(function (App) {
  'use strict';
  const $ = App.$;
  const S = App.state;
  const esc = App.esc;
  const fmt$ = App.fmt$;

  // ─── Sprint 5: Mode + Budget + Kill + Logs + Settings ──────────────────────

  async function loadModeAndBudget() {
    try {
      const [mode, budget, kill] = await Promise.all([
        App.fetchJSON('/api/polymarket/trading-mode'),
        App.fetchJSON('/api/polymarket/budget').catch(() => null),
        App.fetchJSON('/api/polymarket/kill-switch').catch(() => ({active: false})),
      ]);
      S.currentMode = mode.mode || 'dry_run';
      S.budgetData = budget;
      S.killActive = kill.active || false;

      // Mode toggle in header
      const dryBtn = $('modeDryBtn');
      const liveBtn = $('modeLiveBtn');
      if (dryBtn && liveBtn) {
        if (S.currentMode === 'live') {
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
      const isLive = S.currentMode === 'live';
      if (isLive) {
        App.fetchJSON('/api/polymarket/usdc-balance').then(u => {
          const portfolio = u.portfolio_value || u.balance || 0;
          const cash = u.cash || 0;
          S.usdcBalance = portfolio;
          S.usdcCash = cash;
          const usdcEl = $('usdcBal');
          if (usdcEl) usdcEl.textContent = portfolio.toFixed(2);
          const chainEl = $('chainUsdc');
          if (chainEl) chainEl.textContent = '$' + cash.toFixed(2);
          App.renderPortfolio();
        }).catch(() => {});
      } else {
        S.usdcBalance = 0;
        S.usdcCash = 0;
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
        killBtn.className = S.killActive ? 'kill-btn active' : 'kill-btn';
        killBtn.textContent = S.killActive ? 'KILL ON' : 'KILL';
      }
      if (onchainCard) onchainCard.style.display = isLive ? '' : 'none';
      if (statsRow) {
        statsRow.classList.toggle('stats-4', isLive);
      }

      // Budget section: hide in live mode (wallet IS the budget)
      const budgetSec = $('budgetSection');
      if (budgetSec) budgetSec.style.display = isLive ? 'none' : '';

      // Safety section: always visible — Max entry shares, max positions,
      // exposure limits all apply to DRY mode too. The CRITICAL badge stays
      // because these caps still matter for simulated capital integrity.
      const safetySec = $('liveSafetySection');
      if (safetySec) safetySec.style.display = '';

      // Update settings sections if visible (skip if user has unsaved edits)
      if (S.activeTab === 'filters') {
        renderSettingsMode();
        renderSettingsBudget();
        if (!S.settingsDirty) {
          renderSettingsDrawdown();
          renderSettingsLiveSafety();
          renderSettingsExits();
        }
        _loadExposure();
        renderCalibrationProfiles();
      }
    } catch (e) {
      console.error('[loadModeAndBudget]', e);
    }
  }

  async function switchMode(newMode) {
    if (newMode === S.currentMode) return;
    const msg = newMode === 'live'
      ? App.t('settings.confirm_to_live')
      : App.t('settings.confirm_to_dry');
    if (!confirm(msg)) return;
    try {
      const r = await App.fetchJSON('/api/polymarket/trading-mode', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({mode: newMode}),
      });
      if (r.error) { App.toast(r.error, 'err'); return; }
      S.currentMode = newMode;
      App.toast(newMode === 'live' ? App.t('settings.mode_switched_live') : App.t('settings.mode_switched_dry'), 'ok');
      loadModeAndBudget();
      App.loadAll();
    } catch (e) { App.toast(App.t('settings.mode_switch_err', {error: e.message}), 'err'); }
  }
  window.switchMode = switchMode;

  function switchModeFromSettings() {
    const newMode = S.currentMode === 'live' ? 'dry_run' : 'live';
    switchMode(newMode);
  }
  window.switchModeFromSettings = switchModeFromSettings;

  async function toggleKillSwitch() {
    const action = S.killActive ? App.t('settings.confirm_kill_off') : App.t('settings.confirm_kill_on');
    if (!confirm(action)) return;
    try {
      const r = await App.fetchJSON('/api/polymarket/kill-switch', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: '{}',
      });
      S.killActive = r.active;
      const killBtn = $('killBtn');
      if (killBtn) {
        killBtn.className = S.killActive ? 'kill-btn active' : 'kill-btn';
        killBtn.textContent = S.killActive ? App.t('hdr.kill_on') : App.t('hdr.kill');
      }
    } catch (e) { App.toast(App.t('settings.kill_err', {error: e.message}), 'err'); }
  }
  window.toggleKillSwitch = toggleKillSwitch;

  async function saveBudget() {
    const input = $('settingsBudgetInput');
    if (!input) return;
    const val = parseFloat(input.value);
    if (isNaN(val) || val <= 0) { App.toast(App.t('settings.budget_err_positive'), 'warn'); return; }
    try {
      await App.fetchJSON('/api/polymarket/budget', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({budget_usd: val}),
      });
      // Restart trader so it picks up new budget
      await fetch('/api/polymarket/bots/trader/restart', { method: 'POST' }).catch(e => console.warn('[saveBudget] restart:', e.message));
      App.toast(App.t('settings.budget_save_ok'), 'ok');
      setTimeout(() => { loadModeAndBudget(); App.loadAll(); }, 2000);
    } catch (e) { App.toast(App.t('settings.budget_save_err', {error: e.message}), 'err'); }
  }
  window.saveBudget = saveBudget;

  async function resetBudget() {
    const input = $('settingsBudgetInput');
    const budgetVal = input ? parseFloat(input.value) : 0;
    if (!confirm(App.t('settings.budget_confirm_reset', {budget: budgetVal}))) return;
    try {
      await App.fetchJSON('/api/polymarket/budget/reset', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({budget_usd: budgetVal}),
      });
      App.toast(App.t('settings.budget_reset_ok'), 'ok');
      setTimeout(() => { loadModeAndBudget(); App.loadAll(); }, 500);
    } catch (e) { App.toast(App.t('settings.budget_reset_err', {error: e.message}), 'err'); }
  }
  window.resetBudget = resetBudget;

  // ─── Logs (structured events) ───────────────────────────────────────────────

  let _logLevel = '';
  let _logSource = '';
  let _logData = [];

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

  App.renderLogs = async function () {
    const body = $('logBody');
    if (!body) return;
    const search = ($('logSearch') || {}).value || '';

    try {
      const params = new URLSearchParams({ limit: '200' });
      if (_logLevel) params.set('level', _logLevel);
      if (_logSource) params.set('source', _logSource);
      if (search) params.set('search', search);
      const entries = await App.fetchJSON('/api/polymarket/logs?' + params);
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

  App.filterLogByTrade = function (tradeId) {
    var searchEl = $('logSearch');
    if (searchEl) {
      searchEl.value = tradeId;
      App.renderLogs();
    }
  };

  App.copyLogs = function () {
    if (!_logData.length) { App.toast(App.t('logs.copy_nothing'), 'warn'); return; }
    var text = JSON.stringify(_logData, null, 2);
    navigator.clipboard.writeText(text).then(function () {
      App.toast(App.t('logs.copied', {count: _logData.length}), 'ok', 1500);
    });
  };

  App.clearLogs = async function () {
    if (!confirm(App.t('logs.clear_confirm'))) return;
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
    const head = $('decHead');
    const info = $('decInfo');
    if (!body) return;

    const source = ($('decSource') || {}).value || 'trade';

    try {
      if (source === 'trade') {
        // ── Trade decisions (entries + exits) ──────────────────────────
        if (head) head.innerHTML = App.t('settings.decisions_trade_hdr');
        const resp = await fetch('/api/polymarket/trade-decisions');
        const data = await resp.json();
        if (!Array.isArray(data)) return;
        const countEl = $('decCount');
        if (countEl) countEl.textContent = data.length;
        if (info) info.textContent = App.t('settings.decisions_records', {count: data.length});
        data.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        body.innerHTML = data.map(d => {
          const isEntry = d.type === 'entry';
          const ts = d.ts ? new Date(d.ts * 1000) : null;
          const timeStr = ts ? ts.toLocaleDateString('uk-UA', {day:'numeric',month:'short'}) + ' ' + ts.toLocaleTimeString('uk-UA', {hour:'2-digit',minute:'2-digit'}) : '—';
          const typeBadge = isEntry
            ? '<span style="color:#4ecdc4;font-weight:700">ENTRY</span>'
            : '<span style="color:#ff6b6b;font-weight:700">EXIT</span>';
          const market = (d.market || '').length > 50 ? d.market.slice(0, 50) + '…' : (d.market || '—');
          const whale = d.whale_price != null ? d.whale_price.toFixed(3) : '—';
          const mkt = d.market_price != null ? d.market_price.toFixed(3) : '—';
          const fill = isEntry
            ? (d.fill_price || d.entry_price)
            : (d.exit_price || d.fill_price);
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
            <td>${timeStr}</td><td>${typeBadge}</td>
            <td title="${d.market || ''}">${market}</td>
            <td>${whale}</td><td>${mkt}</td><td>${fillStr}</td>
            <td style="${edgeColor}">${edge}</td>
            <td style="font-size:0.85em">${isEntry ? '—' : reason}</td>
            <td style="${pnlColor}">${isEntry ? '—' : pnl}</td>
            <td>${isEntry ? '—' : dur}</td>
            <td style="font-size:0.8em;opacity:0.7">${detailStr}</td>
          </tr>`;
        }).join('');

      } else {
        // ── Pipeline decision log (all / skipped only) ─────────────────
        if (head) head.innerHTML = App.t('settings.decisions_pipe_hdr');
        const decFilter = source === 'skipped' ? '?decision=skipped&limit=300' : '?limit=300';
        const resp = await fetch('/api/polymarket/decision-log' + decFilter);
        const data = await resp.json();
        if (!Array.isArray(data)) return;
        const countEl = $('decCount');
        if (countEl) countEl.textContent = data.length;
        const skippedCount = data.filter(d => d.decision === 'skipped').length;
        const acceptedCount = data.filter(d => d.decision === 'accepted').length;
        if (info) info.textContent = App.t('settings.decisions_records_split', {count: data.length, accepted: acceptedCount, skipped: skippedCount});

        body.innerHTML = data.map(d => {
          const ts = d.ts ? new Date(d.ts * 1000) : null;
          const timeStr = ts ? ts.toLocaleDateString('uk-UA', {day:'numeric',month:'short'}) + ' ' + ts.toLocaleTimeString('uk-UA', {hour:'2-digit',minute:'2-digit'}) : '—';
          const isAccepted = d.decision === 'accepted';
          const decBadge = isAccepted
            ? '<span style="color:#4ecdc4;font-weight:700">✓</span>'
            : '<span style="color:#ff6b6b;font-weight:700">✗</span>';
          const whale = d.whale || '—';
          const market = (d.market || '').length > 45 ? d.market.slice(0, 45) + '…' : (d.market || '—');
          const side = d.side || '—';
          const sideColor = side === 'BUY' ? 'color:#4ecdc4' : side === 'SELL' ? 'color:#ff6b6b' : '';
          const price = d.whale_price != null ? Number(d.whale_price).toFixed(3) : '—';
          const blockReason = d.skip_reason || '—';
          const blockColor = d.skip_reason ? 'color:#fab387;font-weight:600' : 'opacity:0.4';
          const conv = d.conviction_score != null ? Number(d.conviction_score).toFixed(2) : '—';
          const cls = d.whale_classification || '—';
          const clsColor = (cls || '').toUpperCase() === 'NOISE' ? 'color:#ff6b6b;font-weight:700' : '';
          const intent = d.intent_level || '—';
          return `<tr style="${isAccepted ? '' : 'opacity:0.85'}">
            <td>${timeStr}</td><td>${decBadge}</td>
            <td style="font-size:0.8em" title="${d.whale_wallet || ''}">${whale}</td>
            <td title="${d.market || ''}">${market}</td>
            <td style="${sideColor}">${side}</td>
            <td>${price}</td>
            <td style="${blockColor};font-size:0.85em">${blockReason}</td>
            <td>${conv}</td>
            <td style="${clsColor}">${cls}</td>
            <td>${intent}</td>
          </tr>`;
        }).join('');
      }
    } catch (e) {
      body.innerHTML = '<tr><td colspan="11">' + App.t('settings.decisions_load_err') + '</td></tr>';
      console.error('[decisions] render error:', e);
    }
  }

  // ─── Settings sections ─────────────────────────────────────────────────────

  async function renderSettingsSections() {
    renderSettingsMode();
    renderSettingsBudget();
    // Skip re-rendering editable sections when user has unsaved changes —
    // innerHTML destroys input focus and pending edits
    if (!S.settingsDirty) {
      renderSettingsDrawdown();
      renderSettingsLiveSafety();
      renderSettingsExits();
    }
    _loadExposure();
    _updateDirtyState();
  }

  // ─── Drawdown & Position Sizing (was static HTML risk card) ───────────────
  function renderSettingsDrawdown() {
    const body = $('drawdownBody');
    if (!body) return;
    const rs = S.riskSettings || {};
    const reduceAt  = ((rs.DRAWDOWN_REDUCE_AT  ?? 0.15) * 100).toFixed(0);
    const minimalAt = ((rs.DRAWDOWN_MINIMAL_AT ?? 0.25) * 100).toFixed(0);
    const fullStop  = ((rs.DRAWDOWN_FULL_STOP  ?? 0.35) * 100).toFixed(0);
    const maxBetPct = (rs.MAX_BET_PERCENT ?? 5).toFixed(1);
    body.innerHTML = `
      <div class="f-grid">
        <div>
          <div class="f-row"><span class="f-label">Reduce bets at<small>Reduce bet size at this drawdown</small></span><div class="f-input-wrap"><input class="f-input settings-input" id="ddReduceAt" value="${reduceAt}"><span class="f-unit">%</span></div></div>
          <div class="f-row"><span class="f-label">Minimal bets at<small>Minimal bet mode at this drawdown</small></span><div class="f-input-wrap"><input class="f-input settings-input" id="ddMinimalAt" value="${minimalAt}"><span class="f-unit">%</span></div></div>
          <div class="f-row"><span class="f-label">Full stop at<small>Stop all new positions</small></span><div class="f-input-wrap"><input class="f-input settings-input" id="ddFullStop" value="${fullStop}"><span class="f-unit">%</span></div></div>
        </div>
        <div>
          <div class="f-row"><span class="f-label">Max bet size<small>% of balance before drawdown reduction</small></span><div class="f-input-wrap"><input class="f-input settings-input" id="ddMaxBetPct" value="${maxBetPct}"><span class="f-unit">%</span></div></div>
        </div>
      </div>`;
    body.querySelectorAll('.settings-input').forEach(inp => {
      inp.addEventListener('input', _markDirty);
    });
  }

  function renderSettingsMode() {
    const badge = $('settingsModeBadge');
    const body = $('settingsModeBody');
    const switchBtn = $('switchModeBtn');
    if (!body) return;

    const isLive = S.currentMode === 'live';
    if (badge) {
      badge.textContent = isLive ? 'LIVE' : 'DRY RUN';
      badge.style.cssText = isLive
        ? 'background:var(--grn-bg);color:var(--grn);border:1px solid rgba(34,197,94,0.2)'
        : 'background:var(--ind-bg);color:var(--ind);border:1px solid rgba(99,102,241,0.22)';
    }
    if (switchBtn) {
      switchBtn.textContent = isLive ? App.t('settings.mode_to_dry') : App.t('settings.mode_to_live');
      switchBtn.className = isLive ? 'btn btn-primary' : 'btn btn-green';
    }

    body.innerHTML = `
      <div class="mode-cards">
        <div class="mode-card ${isLive ? '' : 'active-dry'}">
          ${isLive ? '' : '<span class="mode-card-check">✓</span>'}
          <div class="mode-card-title"><span class="mode-card-dot" style="background:var(--ind)"></span>${App.t('settings.mode_dry_title')}</div>
          <div class="mode-card-desc">${App.t('settings.mode_dry_desc')}</div>
        </div>
        <div class="mode-card ${isLive ? 'active-live' : ''}">
          ${isLive ? '<span class="mode-card-check">✓</span>' : ''}
          <div class="mode-card-title"><span class="mode-card-dot" style="background:var(--grn)"></span>Live</div>
          <div class="mode-card-desc">${App.t('settings.mode_live_desc')}</div>
        </div>
      </div>
      <div class="cred-grid" id="credGrid"></div>`;

    // Load credential status
    App.fetchJSON('/api/polymarket/trading-mode').then(m => {
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
    if (!S.budgetData) return;
    const isLive = S.currentMode === 'live';

    if (isLive) {
      // LIVE: budget limits how much the bot can risk from the wallet
      const walletTotal = S.usdcBalance || 0;
      const budgetUsd = S.budgetData.budget_usd || 0;
      const histPnl = S.history && S.history.summary ? S.history.summary.net_pnl || 0 : 0;
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
      if (info) info.textContent = '$' + (S.budgetData.remaining_budget || 0).toFixed(0) + ' total · $' + (S.budgetData.available || 0).toFixed(0) + ' avail';
      if (input) input.value = (S.budgetData.budget_usd || 50).toFixed(0);
      if (status) {
        const dryHint = (S.budgetData.budget_usd || 0) <= 0
          ? '<div style="font-size:10px;color:var(--amb);margin-top:4px">⚠️ Set a budget for DRY RUN to work</div>' : '';
        status.innerHTML = `
          <div style="font-size:12px;font-family:var(--fm);color:var(--t1)">$${(S.budgetData.available || 0).toFixed(2)} available</div>
          <div style="font-size:11px;color:var(--grn);font-family:var(--fm)">+$${(S.budgetData.profit || 0).toFixed(2)} profit</div>${dryHint}`;
      }
    }
  }

  function renderSettingsLiveSafety() {
    const body = $('liveSafetyBody');
    if (!body) return;
    const rs = S.riskSettings || {};
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
          <div class="f-row"><span class="f-label">Max entry shares<small>Hard cap on shares per trade</small></span><div class="f-input-wrap"><input class="f-input settings-input" id="safetyMaxEntry" value="${maxEntry}"><span class="f-unit">shares</span></div></div>
          <div class="f-row"><span class="f-label">Max open positions</span><div class="f-input-wrap"><input class="f-input settings-input" id="safetyMaxPos" value="${maxPos}"></div></div>
          <div class="f-row"><span class="f-label">Max total exposure<small>% of budget</small></span><div class="f-input-wrap"><input class="f-input settings-input" id="safetyMaxExp" value="${maxExp}"><span class="f-unit">%</span></div></div>
        </div>
        <div>
          <div class="f-row"><span class="f-label">Daily loss limit</span><div class="f-input-wrap"><input class="f-input settings-input" id="safetyDailyLoss" value="${dailyLoss}"><span class="f-unit">%</span></div></div>
          <div class="f-row"><span class="f-label">Order timeout</span><div class="f-input-wrap"><input class="f-input settings-input" id="safetyTimeout" value="${timeout}"><span class="f-unit">sec</span></div></div>
          <div class="f-row"><span class="f-label">Reconciliation interval</span><div class="f-input-wrap"><input class="f-input" value="300" disabled><span class="f-unit">sec</span></div></div>
        </div>
      </div>
      <div class="kill-section">
        <div><div class="kill-label-title">Emergency Kill Switch</div><div class="kill-label-desc">Halts all trading instantly.</div></div>
        <button class="kill-big-btn" onclick="toggleKillSwitch()">${S.killActive ? 'DEACTIVATE' : 'ACTIVATE'}</button>
      </div>`;
    body.querySelectorAll('.settings-input').forEach(inp => {
      inp.addEventListener('input', _markDirty);
    });
  }

  // ─── Dirty state management ──────────────────────────────────────────────
  function _markDirty() {
    S.settingsDirty = true;
    _updateDirtyState();
  }

  function _updateDirtyState() {
    const dot   = $('settingsDirtyDot');
    const label = $('settingsDirtyLabel');
    const btn   = $('settingsSaveAllBtn');
    if (S.settingsDirty) {
      if (dot)   dot.style.display = 'block';
      if (label) { label.textContent = App.t('settings.dirty_label'); label.style.color = 'var(--amb)'; }
      if (btn)   btn.classList.add('pulse');
    } else {
      if (dot)   dot.style.display = 'none';
      if (label) { label.textContent = App.t('settings.no_dirty_label'); label.style.color = 'var(--t3)'; }
      if (btn)   btn.classList.remove('pulse');
    }
  }

  // ─── Unified save: drawdown + safety + exit → single POST ─────────────────
  async function _saveAllSettings() {
    const btn    = $('settingsSaveAllBtn');
    const status = $('settingsSaveStatus');
    if (btn) btn.disabled = true;
    if (status) { status.style.color = 'var(--grn)'; status.textContent = App.t('settings.saving'); }
    try {
      const num = id => { const el = $(id); return el ? parseFloat(el.value) : null; };
      const intNum = id => { const el = $(id); return el ? parseInt(el.value, 10) : null; };

      const updates = {};

      // Drawdown section
      const ddReduce  = num('ddReduceAt');
      const ddMinimal = num('ddMinimalAt');
      const ddStop    = num('ddFullStop');
      const ddBet     = num('ddMaxBetPct');
      if (ddReduce  != null) updates.DRAWDOWN_REDUCE_AT  = ddReduce / 100;
      if (ddMinimal != null) updates.DRAWDOWN_MINIMAL_AT = ddMinimal / 100;
      if (ddStop    != null) updates.DRAWDOWN_FULL_STOP  = ddStop / 100;
      if (ddBet     != null) updates.MAX_BET_PERCENT     = ddBet;

      // Safety section
      const safeEntry = num('safetyMaxEntry');
      const safePos   = intNum('safetyMaxPos');
      const safeExp   = num('safetyMaxExp');
      const safeLoss  = num('safetyDailyLoss');
      const safeTime  = intNum('safetyTimeout');
      if (safeEntry != null) updates.MAX_ENTRY_SHARES           = safeEntry;
      if (safePos   != null) updates.FILTER_MAX_OPEN_POSITIONS = safePos;
      if (safeExp   != null) updates.MAX_EXPOSURE_PCT          = safeExp / 100;
      if (safeLoss  != null) updates.DAILY_LOSS_LIMIT_PCT      = safeLoss / 100;
      if (safeTime  != null) updates.ORDER_TIMEOUT_S           = safeTime;

      // Exit section
      const eTP    = num('exitTP');
      const eSL    = num('exitSL');
      const eEmSL  = num('exitEmSL');
      const eCeil  = num('exitCeil');
      const eTrAct = num('exitTrailAct');
      const eTrStp = num('exitTrailStp');
      const eTimeH = num('exitTimeH');
      const eSlAge = num('exitSlAge');
      if (eTP    != null) updates.EXIT_TAKE_PROFIT           = eTP / 100;
      if (eSL    != null) updates.EXIT_STOP_LOSS             = eSL / 100;
      if (eEmSL  != null) updates.EXIT_STOP_LOSS_EMERGENCY   = eEmSL / 100;
      if (eCeil  != null) updates.EXIT_CEILING_TP_PRICE      = eCeil;
      if (eTrAct != null) updates.EXIT_TRAIL_ACTIVATE        = eTrAct / 100;
      if (eTrStp != null) updates.EXIT_TRAIL_STOP            = eTrStp / 100;
      if (eTimeH != null) updates.EXIT_TIME_BEFORE_RESOLUTION_H = eTimeH;
      if (eSlAge != null) updates.MIN_STOP_LOSS_AGE_S        = eSlAge;

      const resp = await fetch('/api/polymarket/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);

      S.riskSettings = data;
      S.settingsDirty = false;
      // Grace period: ignore stale poll responses for 5s after save.
      // loadCore() poll may return cached/in-flight data from BEFORE the
      // save completed, which would overwrite the freshly saved values.
      S._settingsSaveGrace = true;
      setTimeout(() => { S._settingsSaveGrace = false; }, 5000);
      _updateDirtyState();

      if (status) { status.style.color = 'var(--grn)'; status.textContent = App.t('settings.saved_ok'); }
      if (btn) {
        btn.textContent = App.t('settings.saved');
        btn.style.background = 'var(--grn)';
        btn.style.borderColor = 'var(--grn)';
        btn.style.color = '#000';
        setTimeout(() => {
          btn.textContent = App.t('settings.save_all');
          btn.style.background = '';
          btn.style.borderColor = '';
          btn.style.color = '';
        }, 2000);
      }
      setTimeout(() => { if (status) status.textContent = ''; }, 3000);
    } catch (err) {
      if (status) { status.style.color = 'var(--red)'; status.textContent = App.t('settings.save_err', {error: err.message}); }
      if (btn) {
        btn.textContent = App.t('settings.save_err_label');
        btn.style.background = 'var(--red)';
        btn.style.borderColor = 'var(--red)';
        btn.style.color = '#000';
        setTimeout(() => {
          btn.textContent = App.t('settings.save_all');
          btn.style.background = '';
          btn.style.borderColor = '';
          btn.style.color = '';
        }, 2000);
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  window._saveAllSettings = _saveAllSettings;

  async function _loadExposure() {
    try {
      const data = await App.fetchJSON('/api/polymarket/exposure?mode=' + (S.currentMode || 'dry_run'));
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
    if (!confirm(App.t('settings.exposure_reset_confirm'))) return;
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
        btn.textContent = App.t('settings.exposure_reset_ok');
        setTimeout(() => { btn.textContent = App.t('settings.exposure_reset_btn'); }, 1500);
      }
    } catch (err) {
      if (btn) {
        btn.textContent = App.t('settings.exposure_reset_err');
        setTimeout(() => { btn.textContent = App.t('settings.exposure_reset_btn'); }, 1500);
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  window._resetExposure = _resetExposure;

  function renderSettingsExits() {
    const body = $('exitSettingsBody');
    if (!body) return;
    const rs = S.riskSettings || {};
    const tp   = ((rs.EXIT_TAKE_PROFIT ?? 0.40) * 100).toFixed(0);
    const sl   = ((rs.EXIT_STOP_LOSS ?? -0.25) * 100).toFixed(0);
    const emsl = ((rs.EXIT_STOP_LOSS_EMERGENCY ?? -0.50) * 100).toFixed(0);
    const ceil = (rs.EXIT_CEILING_TP_PRICE ?? 0.97).toFixed(2);
    const trAct = ((rs.EXIT_TRAIL_ACTIVATE ?? 0.15) * 100).toFixed(0);
    const trStp = ((rs.EXIT_TRAIL_STOP ?? 0.10) * 100).toFixed(0);
    const timeH = String(rs.EXIT_TIME_BEFORE_RESOLUTION_H ?? 6);
    const slAge = (rs.MIN_STOP_LOSS_AGE_S ?? 300).toFixed(0);
    body.innerHTML = `
      <div class="f-grid">
        <div>
          <div class="f-row"><span class="f-label">Take profit</span><div class="f-input-wrap"><input class="f-input settings-input" id="exitTP" value="${tp}"><span class="f-unit">%</span></div></div>
          <div class="f-row"><span class="f-label">Stop loss</span><div class="f-input-wrap"><input class="f-input settings-input" id="exitSL" value="${sl}"><span class="f-unit">%</span></div></div>
          <div class="f-row"><span class="f-label">Emergency stop</span><div class="f-input-wrap"><input class="f-input settings-input" id="exitEmSL" value="${emsl}"><span class="f-unit">%</span></div></div>
          <div class="f-row"><span class="f-label">Ceiling TP price</span><div class="f-input-wrap"><input class="f-input settings-input" id="exitCeil" value="${ceil}"></div></div>
        </div>
        <div>
          <div class="f-row"><span class="f-label">Trail activate</span><div class="f-input-wrap"><input class="f-input settings-input" id="exitTrailAct" value="${trAct}"><span class="f-unit">%</span></div></div>
          <div class="f-row"><span class="f-label">Trail stop</span><div class="f-input-wrap"><input class="f-input settings-input" id="exitTrailStp" value="${trStp}"><span class="f-unit">%</span></div></div>
          <div class="f-row"><span class="f-label">Time before resolution</span><div class="f-input-wrap"><input class="f-input settings-input" id="exitTimeH" type="number" step="0.5" min="0" value="${timeH}"><span class="f-unit">hrs</span></div></div>
          <div class="f-row"><span class="f-label">Min SL age</span><div class="f-input-wrap"><input class="f-input settings-input" id="exitSlAge" value="${slAge}"><span class="f-unit">sec</span></div></div>
        </div>
      </div>`;
    body.querySelectorAll('.settings-input').forEach(inp => {
      inp.addEventListener('input', _markDirty);
    });
  }

  // _saveExitSettings removed — merged into _saveAllSettings

  async function renderCalibrationProfiles() {
    const body = $('calProfilesBody');
    const footer = $('calProfilesFooter');
    const info = $('calProfilesInfo');
    if (!body) return;

    try {
      const data = await App.fetchJSON('/api/polymarket/calibration/configs');
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
        body.innerHTML = '<div style="padding:16px;color:var(--t3);text-align:center">' + App.t('settings.profiles_empty') + '</div>';
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
      body.innerHTML = '<div style="padding:16px;color:var(--t3);text-align:center">' + App.t('settings.profiles_load_err') + '</div>';
    }
  }

  async function copyCalKey(key, source, target) {
    try {
      await App.fetchJSON('/api/polymarket/calibration/copy-key', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({key, source, target}),
      });
      renderCalibrationProfiles();
    } catch (e) { App.toast(App.t('settings.copy_err', {error: e.message}), 'err'); }
  }
  window.copyCalKey = copyCalKey;

  async function copyCalAll(source, target) {
    if (!confirm(App.t('settings.copy_all_confirm', {source: source, target: target}))) return;
    try {
      await App.fetchJSON('/api/polymarket/calibration/copy', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source, target}),
      });
      renderCalibrationProfiles();
    } catch (e) { App.toast(App.t('settings.copy_err', {error: e.message}), 'err'); }
  }
  window.copyCalAll = copyCalAll;

  // ─── Expose on App ────────────────────────────────────────────────────────────

  App.loadModeAndBudget = loadModeAndBudget;
  App.clearDecisions = async function () {
    const source = ($('decSource') || {}).value || 'trade';
    const label = source === 'trade' ? App.t('settings.decisions_entry_exit') : App.t('settings.decisions_pipeline');
    if (!confirm(App.t('settings.decisions_clear_confirm', {label: label}))) return;
    try {
      const url = source === 'trade'
        ? '/api/polymarket/trade-decisions/clear'
        : '/api/polymarket/decision-log/clear';
      const resp = await fetch(url, { method: 'POST' });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      App.toast(App.t('settings.decisions_cleared'), 'ok');
      renderDecisions();
    } catch (e) {
      App.toast(App.t('settings.decisions_err', {error: e.message}), 'err');
    }
  };

  App.renderDecisions = renderDecisions;
  App.renderSettingsSections = renderSettingsSections;
  App.renderSettingsLiveSafety = renderSettingsLiveSafety;
  App.renderSettingsDrawdown = renderSettingsDrawdown;
  App.saveAllSettings = _saveAllSettings;
  App.loadExposure = _loadExposure;

})(window.App);
