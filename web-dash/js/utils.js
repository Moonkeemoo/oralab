/* Ora et Labora — utility / formatting helpers */

(function (App) {
  'use strict';

  App.fmt$ = function (n) {
    if (n == null) return '—';
    const abs = Math.abs(n);
    const s = abs >= 1_000_000 ? (abs / 1_000_000).toFixed(2) + 'M'
            : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? '-$' : '$') + s;
  };

  App.fmtUpdatedAt = function (ts) {
    const d = new Date(ts * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  };

  App.fmtAge = function (ts) {
    const secs = Date.now() / 1000 - ts;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  App.esc = function (s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  App.trustColor = function (score) {
    if (score >= 70) return 'var(--grn)';
    if (score >= 50) return 'var(--amb)';
    return 'var(--red)';
  };

  App.strategyBadge = function (strategy) {
    const map = {
      'volume_spike':   ['b-strategy-vs',  'vol spike'],
      'arbitrage':      ['b-strategy-arb', 'arbitrage'],
      'mean_reversion': ['b-strategy-mr',  'mean rev'],
      'ws_signal':      ['b-strategy-ws',  'ws signal'],
      'gtc_fallback':   ['b-strategy-ws',  'gtc_fallback'],
      'convergence':    ['b-strategy-arb', 'convergence'],
      'copy':           ['b-strategy-vs',  'copy'],
    };
    if (!strategy) return '';
    const [cls, label] = map[strategy] || ['b-strategy-vs', strategy];
    return `<span class="b ${cls}">${App.esc(label)}</span>`;
  };

  // Outcome badge: YES/NO for binary markets (green/red), candidate name for multi-outcome (purple).
  // Full text shown in tooltip when truncated.
  App.outcomeBadge = function (outcome) {
    if (!outcome) return '<span class="td-dim">—</span>';
    const o = String(outcome).trim();
    const upper = o.toUpperCase();
    if (upper === 'YES') return '<span class="b b-yes">YES</span>';
    if (upper === 'NO')  return '<span class="b b-no">NO</span>';
    return `<span class="b b-multi" title="${App.esc(o)}">${App.esc(o)}</span>`;
  };

  App.shortWallet = function (addr) {
    if (!addr) return '—';
    if (addr.length <= 12) return addr;
    return addr.slice(0, 6) + '…' + addr.slice(-4);
  };

  App.fmtDate = function (iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  App.fmtTs = function (ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  App.fmtExpiry = function (ts) {
    if (!ts) return '—';
    const now = Date.now() / 1000;
    const diff = ts - now;
    if (diff <= 0) return '<span style="color:var(--red)">expired</span>';
    const days = Math.floor(diff / 86400);
    const hours = Math.floor((diff % 86400) / 3600);
    return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
  };

  // Resolution time cell for trades table.
  // Shows "resolved Xh ago" for closed trades and "in Xh Ym" countdown for open.
  // Amber when <30m to close (low liquidity zone), red if overdue.
  App.fmtResolution = function (trade) {
    const resolved = trade.resolved_at;
    const endTs = trade.market_end_ts || trade.resolution_ts;
    const now = Date.now() / 1000;

    if (resolved) {
      const ago = now - resolved;
      if (ago < 60) return '<span class="td-dim">just resolved</span>';
      if (ago < 3600) return `<span class="td-dim">resolved ${Math.floor(ago / 60)}m ago</span>`;
      if (ago < 86400) return `<span class="td-dim">resolved ${Math.floor(ago / 3600)}h ago</span>`;
      return `<span class="td-dim">resolved ${Math.floor(ago / 86400)}d ago</span>`;
    }
    if (!endTs) return '<span class="td-dim">—</span>';

    const diff = endTs - now;
    if (diff <= 0) return '<span style="color:var(--red)">overdue</span>';

    const mins = Math.floor(diff / 60);
    const hours = Math.floor(diff / 3600);
    const days = Math.floor(diff / 86400);

    let label;
    if (days > 0) label = `${days}d ${hours % 24}h`;
    else if (hours > 0) label = `${hours}h ${mins % 60}m`;
    else label = `${mins}m`;

    const color = diff < 1800 ? 'var(--amb)' : diff < 7200 ? 'var(--fg)' : 'var(--fg-dim)';
    return `<span style="color:${color}" title="closes at ${new Date(endTs * 1000).toLocaleString()}">in ${label}</span>`;
  };

  App.colorPrices = function () {
    document.querySelectorAll('.cur-price').forEach(el => {
      const entry   = parseFloat(el.dataset.entry);
      const current = parseFloat(el.dataset.current);
      if (isNaN(entry) || isNaN(current)) return;
      const diff = current - entry;
      const pct  = entry !== 0 ? (diff / entry * 100) : 0;
      const threshold = 0.001;
      if (diff > threshold) {
        el.className = 'price-up td-mono';
        el.title = `+${pct.toFixed(2)}% from entry`;
        el.innerHTML = `<span class="price-arrow">▲</span>${current.toFixed(3)}`;
      } else if (diff < -threshold) {
        el.className = 'price-down td-mono';
        el.title = `${pct.toFixed(2)}% from entry`;
        el.innerHTML = `<span class="price-arrow">▼</span>${current.toFixed(3)}`;
      } else {
        el.className = 'price-flat td-mono';
        el.title = 'No change';
        el.textContent = current.toFixed(3);
      }
    });
  };

  App.flashBtn = function (btn, successText, ms) {
    if (!btn) return;
    ms = ms || 1800;
    const orig = btn.textContent;
    btn.textContent = successText;
    btn.classList.add('flash-ok');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('flash-ok'); }, ms);
  };

  // ── Toast notification system ──────────────────────────────────────────
  let _toastContainer = null;
  function _ensureToastContainer() {
    if (_toastContainer) return _toastContainer;
    _toastContainer = document.createElement('div');
    _toastContainer.id = 'toastContainer';
    _toastContainer.style.cssText = 'position:fixed;top:60px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none';
    document.body.appendChild(_toastContainer);
    return _toastContainer;
  }

  /**
   * Show a toast notification.
   * @param {string} msg - Message text (HTML allowed)
   * @param {'ok'|'err'|'warn'|'info'} type - Toast type
   * @param {number} ms - Duration in ms (default 3000)
   */
  App.toast = function (msg, type, ms) {
    type = type || 'info';
    ms = ms || 3000;
    const c = _ensureToastContainer();
    const el = document.createElement('div');
    const colors = {
      ok:   'background:var(--grn-bg,#0d2818);border:1px solid var(--grn-brd,#22c55e33);color:var(--grn,#22c55e)',
      err:  'background:var(--red-bg,#2a0f0f);border:1px solid var(--red-brd,#ef444433);color:var(--red,#ef4444)',
      warn: 'background:var(--amb-bg,#2a1f0a);border:1px solid var(--amb-brd,#f59e0b33);color:var(--amb,#f59e0b)',
      info: 'background:var(--bg3,#1e293b);border:1px solid var(--brd2,#334155);color:var(--t1,#e2e8f0)',
    };
    el.style.cssText = (colors[type] || colors.info) + ';padding:10px 16px;border-radius:8px;font-size:12px;font-family:var(--fs);pointer-events:auto;opacity:0;transition:opacity .2s;max-width:360px';
    el.innerHTML = msg;
    c.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 200);
    }, ms);
  };

  /**
   * Run an async action with button loading state.
   * Disables button, adds .loading class, runs fn, restores button.
   * Shows toast on error.
   * @param {HTMLElement} btn - Button element
   * @param {Function} fn - Async function to execute
   * @param {string} [successText] - Flash text on success (optional)
   */
  App.withLoading = async function (btn, fn, successText) {
    if (!btn) return fn();
    const origText = btn.textContent;
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      const result = await fn();
      if (successText) App.flashBtn(btn, successText);
      return result;
    } catch (e) {
      App.toast(App.t('utils.err_generic', { error: e.message || e }), 'err');
      throw e;
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  };

  /**
   * Show a confirmation dialog, then run async action with loading state.
   * @param {string} msg - Confirmation message (Ukrainian)
   * @param {HTMLElement|null} btn - Optional button for loading state
   * @param {Function} fn - Async function to execute if confirmed
   * @param {string} [successText] - Flash text on success
   * @returns {Promise<*>} Result of fn, or undefined if cancelled
   */
  App.confirmAction = async function (msg, btn, fn, successText) {
    if (!confirm(msg)) return;
    return App.withLoading(btn, fn, successText);
  };

  /**
   * Lookup whale profile from cached profilesMap (case-insensitive).
   * @param {string} wallet - Wallet address
   * @returns {object|null}
   */
  App.getProfile = function (wallet) {
    if (!wallet || !App.state.profilesMap) return null;
    return App.state.profilesMap[wallet.toLowerCase()] || App.state.profilesMap[wallet] || null;
  };

})(window.App);
