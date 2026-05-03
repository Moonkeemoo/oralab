/* Ora et Labora — Lifecycle diagnostic tab */

(function (App) {
  'use strict';

  let _lcData = null;
  let _lcInterval = null;

  // ── Public API ─────────────────────────────────────────────────────────────

  App.initLifecycleTab = function () {
    App.lcRefresh();
    if (!_lcInterval) {
      _lcInterval = setInterval(App.lcRefresh, 3000);
    }
  };

  App.stopLifecycleTab = function () {
    if (_lcInterval) {
      clearInterval(_lcInterval);
      _lcInterval = null;
    }
  };

  App.lcRefresh = async function () {
    try {
      const resp = await fetch('/api/polymarket/lifecycle');
      _lcData = await resp.json();
      _renderLifecycle(_lcData);
    } catch (e) {
      console.error('[LC] fetch failed:', e);
    }
  };

  App.lcCopyAll = function () {
    if (!_lcData || !_lcData.positions || !_lcData.positions.length) {
      App.toast(App.t('lc.copy_empty'), 'warn');
      return;
    }
    var lines = _lcData.positions.map(function (p) {
      var w = (p.warnings || []).map(function (x) { return '  \u26a0 ' + x; }).join('\n');
      return [
        '[' + (p.trade_id || '?') + '] ' + (p.market || '?') + ' \u00b7 ' + (p.outcome || '') + ' \u00b7 ' + (p.mode || ''),
        '  Mark: ' + _fmt(p.mark_price) + ' (' + (p.mark_quality || '?') + '/' + (p.mark_source || '?') + ', age=' + _fmt(p.mark_age_s) + 's)',
        '  P&L: ' + _fmt(p.pnl_pct) + '% ($' + _fmt(p.pnl_usd) + ') \u00b7 Entry: ' + _fmt(p.entry_price) + ' \u00b7 Peak: ' + _fmt(p.peak_price) + ' (' + _fmt(p.peak_pnl_pct) + '%)',
        '  Exit: ' + (p.exit_check_result || '\u2014') + (p.exit_detail ? ' \u00b7 ' + p.exit_detail : ''),
        p.nearest_exit ? '  Next: ' + p.nearest_exit : null,
        p.sell_attempted ? '  Sell: ' + (p.sell_result || '?') + (p.sell_error ? ' \u00b7 ' + p.sell_error : '') : null,
        p.persisted === false ? '  PERSIST FAILED: ' + (p.persist_error || 'unknown') : null,
        w || null,
      ].filter(Boolean).join('\n');
    });

    var header = 'Lifecycle \u00b7 Cycle ' + (_lcData.cycle || '?') + ' \u00b7 ' + new Date((_lcData.ts || 0) * 1000).toISOString();
    var text = header + '\n\n' + lines.join('\n\n');

    navigator.clipboard.writeText(text).then(function () {
      App.toast(App.t('lc.copied_positions', { count: _lcData.positions.length }), 'ok', 1500);
    });
  };

  App.lcCopyOne = function (tradeId) {
    if (!_lcData) return;
    var pos = _lcData.positions.find(function (p) { return p.trade_id === tradeId; });
    if (!pos) return;
    navigator.clipboard.writeText(JSON.stringify(pos, null, 2)).then(function () {
      App.toast(App.t('lc.copied_trade', { trade: tradeId }), 'ok', 1200);
    });
  };

  // ── Event color helper ──────────────────────────────────────────────────────

  function _eventColor(eventName) {
    if (!eventName) return 'var(--t2)';
    // State machine transitions — cyan
    if (eventName === 'status_transition') return 'var(--cyan)';
    // Blocked / invalid transitions — red
    if (eventName === 'invalid_transition' || eventName === 'invalid_transition_blocked') return 'var(--red)';
    // Unknown legacy mapping — amber
    if (eventName === 'unknown_status_mapped') return 'var(--amb)';
    // General patterns
    if (eventName.indexOf('failed') >= 0 || eventName.indexOf('error') >= 0) return 'var(--red)';
    if (eventName.indexOf('success') >= 0 || eventName.indexOf('passed') >= 0) return 'var(--grn)';
    if (eventName.indexOf('triggered') >= 0) return 'var(--amb)';
    return 'var(--t2)';
  }

  // ── Events viewer ──────────────────────────────────────────────────────────

  App.lcShowEvents = async function (tradeId, btn) {
    // Toggle: if events panel already visible for this trade, remove it
    var existing = document.getElementById('lc-events-' + tradeId);
    if (existing) { existing.remove(); return; }

    try {
      var resp = await fetch('/api/polymarket/lifecycle/events?trade_id=' + encodeURIComponent(tradeId) + '&limit=100');
      var events = await resp.json();

      var html = '<div id="lc-events-' + _esc(tradeId) + '" style="font-family:var(--fm);font-size:11px;'
               + 'background:var(--bg1);border:1px solid var(--brd2);border-radius:var(--r-sm);'
               + 'padding:10px 12px;margin-top:6px;max-height:300px;overflow-y:auto;line-height:1.5">';

      if (!events.length) {
        html += '<span style="color:var(--t3)">' + App.t('lc.no_events_for') + _esc(tradeId) + '</span>';
      } else {
        for (var i = events.length - 1; i >= 0; i--) {
          var ev = events[i];
          var ts = new Date((ev.ts || 0) * 1000).toLocaleTimeString();
          var color = _eventColor(ev.event || '');

          var ctx = [];
          for (var k in ev) {
            if (k === 'ts' || k === 'event' || k === 'trade_id') continue;
            var v = ev[k];
            if (typeof v === 'number') v = Math.round(v * 10000) / 10000;
            ctx.push(k + '=' + v);
          }

          html += '<div style="margin-bottom:1px">';
          html += '<span style="color:var(--t3)">' + ts + '</span> ';
          html += '<span style="color:' + color + ';font-weight:600">' + _esc(ev.event || '') + '</span> ';
          html += '<span style="color:var(--t3)">' + _esc(ctx.join(' ')) + '</span>';
          html += '</div>';
        }
      }
      html += '</div>';

      // Insert after the button row in the card
      if (btn) {
        var card = btn.closest('div[style*="border-left"]');
        if (card) {
          card.insertAdjacentHTML('beforeend', html);
          return;
        }
      }
      // Fallback: append to positions container
      var posEl = document.getElementById('lcPositions');
      if (posEl) posEl.insertAdjacentHTML('beforeend', html);
    } catch (e) {
      App.toast(App.t('lc.events_load_err'), 'error');
      console.error('[LC] events fetch error:', e);
    }
  };

  App.lcCopyEvents = async function (tradeId) {
    try {
      var resp = await fetch('/api/polymarket/lifecycle/events?trade_id=' + encodeURIComponent(tradeId) + '&limit=200');
      var events = await resp.json();

      var lines = events.reverse().map(function (ev) {
        var ts = new Date((ev.ts || 0) * 1000).toISOString();
        var ctx = [];
        for (var k in ev) {
          if (k === 'ts' || k === 'event' || k === 'trade_id') continue;
          ctx.push(k + '=' + ev[k]);
        }
        return ts + ' ' + (ev.event || '') + ' ' + ctx.join(' ');
      });

      navigator.clipboard.writeText(lines.join('\n')).then(function () {
        App.toast(App.t('lc.copied_events', { count: events.length }), 'ok', 1500);
      });
    } catch (e) {
      App.toast(App.t('lc.copy_err'), 'error');
    }
  };

  App.lcRefreshRecentEvents = async function () {
    var el = document.getElementById('lcRecentEvents');
    if (!el) return;
    try {
      var resp = await fetch('/api/polymarket/lifecycle/events?limit=50');
      var events = await resp.json();
      if (!events.length) {
        el.textContent = App.t('lc.no_events');
        return;
      }
      var html = '';
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var ts = new Date((ev.ts || 0) * 1000).toLocaleTimeString();
        var tid = (ev.trade_id || '').substring(0, 8);
        var color = _eventColor(ev.event || '');
        var ctx = [];
        for (var k in ev) {
          if (k === 'ts' || k === 'event' || k === 'trade_id') continue;
          var v = ev[k];
          if (typeof v === 'number') v = Math.round(v * 10000) / 10000;
          ctx.push(k + '=' + v);
        }
        html += '<div style="margin-bottom:1px">';
        html += '<span style="color:var(--t3)">' + ts + '</span> ';
        html += '<span style="color:var(--t1);font-weight:600">[' + _esc(tid) + ']</span> ';
        html += '<span style="color:' + color + '">' + _esc(ev.event || '') + '</span> ';
        html += '<span style="color:var(--t3)">' + _esc(ctx.join(' ').substring(0, 120)) + '</span>';
        html += '</div>';
      }
      el.innerHTML = html;
    } catch (e) {
      el.textContent = App.t('lc.events_load_err');
      console.error('[LC] recent events error:', e);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  function _fmt(v) {
    return v != null ? v : '\u2014';
  }

  function _renderLifecycle(data) {
    var positions = data.positions || [];

    var cycleEl = document.getElementById('lcCycle');
    var ageEl = document.getElementById('lcAge');
    if (cycleEl) cycleEl.textContent = 'Cycle: ' + (data.cycle || '\u2014');
    var age = data.ts ? Math.round(Date.now() / 1000 - data.ts) : null;
    if (ageEl) {
      ageEl.textContent = age != null ? 'Updated: ' + age + 's ago' : 'Updated: \u2014';
      ageEl.style.color = (age != null && age > 10) ? 'var(--amb)' : 'var(--t3)';
    }

    var emptyEl = document.getElementById('lcEmpty');
    var posEl = document.getElementById('lcPositions');
    if (!posEl) return;

    if (!positions.length) {
      posEl.innerHTML = '';
      if (emptyEl) emptyEl.style.display = '';
    } else {
      if (emptyEl) emptyEl.style.display = 'none';
      var html = '';
      for (var i = 0; i < positions.length; i++) {
        html += _renderCard(positions[i], false);
      }
      posEl.innerHTML = html;
    }

    // ── Closed positions history ──────────────────────────────────────────
    var closed = data.closed || [];
    var closedEl = document.getElementById('lcClosed');
    if (!closedEl) {
      // Create closed section dynamically if not in HTML
      closedEl = document.createElement('div');
      closedEl.id = 'lcClosed';
      posEl.parentNode.appendChild(closedEl);
    }
    if (closed.length) {
      var ch = '<div style="margin-top:16px;margin-bottom:8px;color:var(--t2);font-size:13px;font-weight:600">'
             + '\ud83d\udcdc \u0406\u0441\u0442\u043e\u0440\u0456\u044f \u0437\u0430\u043a\u0440\u0438\u0442\u0438\u0445 (' + closed.length + ')</div>';
      for (var j = closed.length - 1; j >= 0; j--) {
        ch += _renderCard(closed[j], true);
      }
      closedEl.innerHTML = ch;
    } else {
      closedEl.innerHTML = '';
    }
  }

  function _renderCard(pos, isClosed) {
    var warnings = pos.warnings || [];
    var hasWarning = warnings.length > 0;
    var isTriggered = pos.exit_check_result && pos.exit_check_result !== 'no_trigger' && pos.exit_check_result !== 'skipped';
    var borderColor = isClosed ? 'var(--t4)'
                    : hasWarning ? 'var(--red-brd)'
                    : isTriggered ? 'var(--amb-brd)'
                    : 'var(--brd2)';
    var bgColor = isClosed ? 'var(--bg1)'
                : hasWarning ? 'var(--red-bg)'
                : isTriggered ? 'var(--amb-bg)'
                : 'var(--bg2)';

    var h = '<div style="border-left:3px solid ' + borderColor + ';'
          + 'background:' + bgColor + ';border-radius:var(--r-sm);'
          + 'padding:12px 16px;margin-bottom:8px;font-family:var(--fm);font-size:12px;line-height:1.6">';

    // Header
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
    h += '<span style="color:var(--t1);font-weight:600;font-size:13px">'
       + _esc((pos.trade_id || '?').substring(0, 8)) + ' \u00b7 ' + _esc((pos.market || '?').substring(0, 50))
       + '</span>';
    h += '<span style="color:var(--t3)">' + _esc(pos.mode || '?') + ' \u00b7 ' + _esc(pos.outcome || '?')
       + (pos.status ? ' \u00b7 ' + _esc(pos.status) : '');
    if (isClosed && pos.closed_at) {
      h += ' \u00b7 \u274c ' + new Date(pos.closed_at * 1000).toLocaleTimeString();
    }
    h += '</span>';
    h += '</div>';

    // Mark row
    var markColor = pos.mark_quality === 'executable' ? 'var(--grn)'
                  : pos.mark_quality === 'cached' ? 'var(--cyan)'
                  : pos.mark_quality === 'indicative' ? 'var(--amb)'
                  : 'var(--red)';
    h += '<div style="display:flex;flex-wrap:wrap;gap:16px;margin-bottom:4px;color:var(--t2)">';
    h += '<span>Mark: <span style="color:' + markColor + '">' + _fmt(pos.mark_price) + '</span></span>';
    h += '<span>Quality: <span style="color:' + markColor + '">' + _esc(pos.mark_quality || '\u2014') + '</span></span>';
    h += '<span>Source: ' + _esc(pos.mark_source || '\u2014') + '</span>';
    var ageStyle = (pos.mark_age_s || 0) > 60 ? 'color:var(--red)' : '';
    h += '<span>Age: <span style="' + ageStyle + '">' + _fmt(pos.mark_age_s) + 's</span></span>';
    h += '</div>';

    // P&L row
    var pnlColor = (pos.pnl_pct || 0) >= 0 ? 'var(--grn)' : 'var(--red)';
    h += '<div style="display:flex;flex-wrap:wrap;gap:16px;margin-bottom:4px;color:var(--t2)">';
    h += '<span>Entry: ' + _fmt(pos.entry_price) + '</span>';
    h += '<span>P&L: <span style="color:' + pnlColor + ';font-weight:600">'
       + _fmt(pos.pnl_pct) + '% ($' + _fmt(pos.pnl_usd) + ')</span></span>';
    h += '<span>Peak: ' + _fmt(pos.peak_price) + ' (' + _fmt(pos.peak_pnl_pct) + '%)</span>';
    h += '</div>';

    // Exit evaluation
    var exitColor = pos.exit_check_result === 'no_trigger' ? 'var(--t3)'
                  : pos.exit_check_result === 'skipped' ? 'var(--t4)'
                  : 'var(--amb)';
    h += '<div style="margin-bottom:4px;color:var(--t2)">';
    h += 'Exit: <span style="color:' + exitColor + ';font-weight:600">' + _esc(pos.exit_check_result || '\u2014') + '</span>';
    if (pos.exit_detail) h += ' <span style="color:var(--t3)">\u00b7 ' + _esc(pos.exit_detail) + '</span>';
    h += '</div>';

    // Nearest exits
    if (pos.nearest_exit) {
      h += '<div style="color:var(--t3);margin-bottom:4px;font-size:11px">' + _esc(pos.nearest_exit) + '</div>';
    }

    // Sell result
    if (pos.sell_attempted) {
      var sellColor = pos.sell_result === 'success' ? 'var(--grn)' : 'var(--red)';
      h += '<div style="color:var(--t2)">Sell: <span style="color:' + sellColor + '">' + _esc(pos.sell_result || '?') + '</span>';
      if (pos.sell_error) h += ' \u00b7 <span style="color:var(--red)">' + _esc(pos.sell_error) + '</span>';
      h += '</div>';
    }

    // Persist failure
    if (pos.sell_attempted && pos.persisted === false) {
      h += '<div style="color:var(--red);font-weight:600">PERSIST FAILED: ' + _esc(pos.persist_error || 'unknown') + '</div>';
    }

    // Warnings
    for (var w = 0; w < warnings.length; w++) {
      h += '<div style="color:var(--red);margin-top:2px">\u26a0 ' + _esc(warnings[w]) + '</div>';
    }

    // Action buttons
    h += '<div style="margin-top:6px;text-align:right;display:flex;gap:4px;justify-content:flex-end">';
    h += '<button class="hdr-btn" onclick="App.lcShowEvents(\'' + _esc(pos.trade_id || '') + '\',this)" '
       + 'style="font-size:10px;padding:2px 8px">Events</button>';
    h += '<button class="hdr-btn" onclick="App.lcCopyEvents(\'' + _esc(pos.trade_id || '') + '\')" '
       + 'style="font-size:10px;padding:2px 8px">Copy Events</button>';
    h += '<button class="hdr-btn" onclick="App.lcCopyOne(\'' + _esc(pos.trade_id || '') + '\')" '
       + 'style="font-size:10px;padding:2px 8px">Copy JSON</button>';
    h += '</div>';

    h += '</div>';
    return h;
  }

  function _esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

})(window.App);
