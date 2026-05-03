/* Ora et Labora — history rendering */

(function (App) {
  'use strict';

  const $ = App.$;
  const S = App.state;
  const fmt$ = App.fmt$;
  const esc = App.esc;

  // F10/L29 (audit X9 UI): readable labels for closure_reason values.
  // Keep in sync with core/closure_reasons.py constants AND trades.js CLOSURE_LABELS_*.
  const CLOSURE_LABELS_UK = {
    'tp_fok':                { text: 'TP',           cls: 'b-win'  },
    'sl_fok':                { text: 'SL hard',      cls: 'b-lose' },
    'sl_emergency':          { text: 'Аварійний SL', cls: 'b-lose' },
    'sl_aggressive':         { text: 'Агр. SL',      cls: 'b-lose' },
    'trailing_stop':         { text: 'Trail',        cls: 'b-win'  },
    'whale_exit':            { text: 'Whale exit',   cls: 'b-dim'  },
    'time_expiry':           { text: 'Час',          cls: 'b-dim'  },
    'manual':                { text: 'Вручну',       cls: 'b-dim'  },
    'gtd_sell_filled':       { text: 'GTD',          cls: 'b-dim'  },
    'price_resolved':        { text: 'Price resolv', cls: 'b-dim'  },
    'external_sell':         { text: 'Зовнішній',    cls: 'b-dim'  },
    'market_resolved_win':   { text: 'Резолв WIN',   cls: 'b-win'  },
    'market_resolved_loss':  { text: 'Резолв LOSS',  cls: 'b-lose' },
    'write_off':             { text: 'Write-off',    cls: 'b-dim'  },
    'cancelled_offline':     { text: 'Скасовано',    cls: 'b-dim'  },
    'false_positive':        { text: 'Ghost',        cls: 'b-dim'  },
    'manual_dismiss':        { text: 'Скинуто',      cls: 'b-dim'  },
    'phantom_auto_close':    { text: 'Привид',       cls: 'b-dim'  },
    'tp_hit':           { text: 'TP',          cls: 'b-win'  },
    'sl_hit':           { text: 'SL',          cls: 'b-lose' },
    'time_exit':        { text: 'Час',         cls: 'b-dim'  },
    'margin_call':      { text: 'Маржа',       cls: 'b-lose' },
    'emergency_exit':   { text: 'Аварійний',   cls: 'b-lose' },
    'market_resolved':  { text: 'Резолв',      cls: 'b-dim'  },
    'expired':          { text: 'Експіред',    cls: 'b-dim'  },
  };

  const CLOSURE_LABELS_EN = {
    'tp_fok':                { text: 'TP',            cls: 'b-win'  },
    'sl_fok':                { text: 'SL hard',       cls: 'b-lose' },
    'sl_emergency':          { text: 'Emergency SL',  cls: 'b-lose' },
    'sl_aggressive':         { text: 'Aggr. SL',      cls: 'b-lose' },
    'trailing_stop':         { text: 'Trail',         cls: 'b-win'  },
    'whale_exit':            { text: 'Whale exit',    cls: 'b-dim'  },
    'time_expiry':           { text: 'Time',          cls: 'b-dim'  },
    'manual':                { text: 'Manual',        cls: 'b-dim'  },
    'gtd_sell_filled':       { text: 'GTD',           cls: 'b-dim'  },
    'price_resolved':        { text: 'Price resolv',  cls: 'b-dim'  },
    'external_sell':         { text: 'External',      cls: 'b-dim'  },
    'market_resolved_win':   { text: 'Resolved WIN',  cls: 'b-win'  },
    'market_resolved_loss':  { text: 'Resolved LOSS', cls: 'b-lose' },
    'write_off':             { text: 'Write-off',     cls: 'b-dim'  },
    'cancelled_offline':     { text: 'Cancelled',     cls: 'b-dim'  },
    'false_positive':        { text: 'Ghost',         cls: 'b-dim'  },
    'manual_dismiss':        { text: 'Dismissed',     cls: 'b-dim'  },
    'phantom_auto_close':    { text: 'Phantom',       cls: 'b-dim'  },
    'tp_hit':           { text: 'TP',          cls: 'b-win'  },
    'sl_hit':           { text: 'SL',          cls: 'b-lose' },
    'time_exit':        { text: 'Time',        cls: 'b-dim'  },
    'margin_call':      { text: 'Margin',      cls: 'b-lose' },
    'emergency_exit':   { text: 'Emergency',   cls: 'b-lose' },
    'market_resolved':  { text: 'Resolved',    cls: 'b-dim'  },
    'expired':          { text: 'Expired',     cls: 'b-dim'  },
  };

  function CLOSURE_LABELS() {
    return (App.locale === 'en') ? CLOSURE_LABELS_EN : CLOSURE_LABELS_UK;
  }

  // L29: Infer actual exit trigger from exit_reason string.
  // Mirrors _inferTriggerFromExitReason in trades.js and
  // infer_closure_from_exit_reason in core/closure_reasons.py.
  function _inferTrigger(exitReasonStr) {
    if (!exitReasonStr) return null;
    const s = String(exitReasonStr).toLowerCase();
    if (s.indexOf('whale exit') >= 0 || s.indexOf('intent collapse') >= 0) return 'whale_exit';
    if (s.indexOf('trailing stop') >= 0 || s.indexOf('trailing_stop') >= 0) return 'trailing_stop';
    if (s.indexOf('emergency stop') >= 0 || s.indexOf('emergency_stop') >= 0) return 'sl_emergency';
    if (s.indexOf('aggressive stop') >= 0 || s.indexOf('aggressive_stop') >= 0) return 'sl_aggressive';
    if (s.indexOf('ceiling tp') >= 0) return 'tp_fok';
    if (s.indexOf('take-profit') >= 0 || s.indexOf('take profit') >= 0) return 'tp_fok';
    if (s.indexOf('stop-loss') >= 0 || s.indexOf('stop loss') >= 0) return 'sl_fok';
    if (s.indexOf('time exit') >= 0 || s.indexOf('time_exit') >= 0) return 'time_expiry';
    if (s.indexOf('market resolved') >= 0) {
      return s.indexOf('win') >= 0 ? 'market_resolved_win' : 'market_resolved_loss';
    }
    if (s.indexOf('price-resolved') >= 0 || s.indexOf('price resolved') >= 0) return 'price_resolved';
    if (s.indexOf('write-off') >= 0 || s.indexOf('sell cycles') >= 0) return 'write_off';
    return null;
  }

  App.closureLabel = function (trade) {
    // Prefer new closure_reason, fallback to legacy exit_reason
    const cr = trade.closure_reason;
    const er = trade.exit_reason;

    // L29: when closure_reason is generic gtd_sell_filled, infer actual
    // trigger from exit_reason so we show "SL hard", "TP", "Trail", etc.
    const CL = CLOSURE_LABELS();
    if (cr === 'gtd_sell_filled' && er) {
      const inferred = _inferTrigger(er);
      if (inferred && CL[inferred]) return CL[inferred];
    }

    if (cr && CL[cr]) return CL[cr];
    if (cr) return { text: String(cr).replace(/_/g, ' '), cls: 'b-dim' };
    if (!er) return null;
    const low = String(er).toLowerCase();
    if (low.indexOf('tp') >= 0 || low.indexOf('take') >= 0) return { text: 'TP', cls: 'b-win' };
    if (low.indexOf('sl') >= 0 || low.indexOf('stop') >= 0) return { text: 'SL', cls: 'b-lose' };
    if (low.indexOf('trail') >= 0) return { text: 'Trail', cls: 'b-win' };
    return { text: er.replace(/_/g, ' '), cls: 'b-dim' };
  };

  App.renderHistory = function () {
    const tbody = $('historyTbody');
    const footer = $('historyFooter');
    const countEl = $('histCount');
    if (!tbody || !S.history) return;

    const trades = S.history.trades || [];
    if (countEl) countEl.textContent = trades.length;

    if (!trades.length) {
      tbody.innerHTML = '<tr><td colspan="13" class="td-dim" style="text-align:center;padding:32px">' + App.t('hist.empty') + '</td></tr>';
      if (footer) footer.innerHTML = '';
      return;
    }

    tbody.innerHTML = trades.map(t => {
      const mode = t.trading_mode === 'live' ? '<span class="b b-live">LIVE</span>' : '<span class="b b-dry">DRY</span>';
      const tradeId = t.trade_id ? `<span class="trade-id">${esc((t.trade_id || '').slice(0, 4))}</span>` : '<span class="td-dim">—</span>';

      const mktUrl = t.event_slug
        ? `https://polymarket.com/event/${esc(t.event_slug)}?r=moonkee`
        : '';
      const mktCell = mktUrl
        ? `<a href="${mktUrl}" target="_blank" class="mkt-link">${esc(t.market)}</a>`
        : esc(t.market || '—');

      const sideBadge = App.outcomeBadge(t.side);

      const pnlRaw = t.pnl ?? t.pnl_amount ?? 0;
      const isWin = pnlRaw > 0 || t.pnl_status === 'win' || t.pnl_status === 'won';
      const isLoss = pnlRaw < 0 || t.pnl_status === 'lost';
      const resultBadge = isWin
        ? '<span class="b b-win">Won ✅</span>'
        : isLoss
          ? '<span class="b b-lose">Lost ❌</span>'
          : '<span class="b b-dim">BE</span>';

      const pnl = pnlRaw;
      const pnlCls = pnl > 0 ? 'td-pos' : pnl < 0 ? 'td-neg' : 'td-dim';
      const pnlStr = (pnl >= 0 ? '+' : '') + fmt$(pnl);

      const entryPrice = t.entry ?? t.entry_price;
      const exitPrice  = t.exit  ?? t.exit_price;

      // F10 (audit X9 UI): prefer structured closure_reason, render Ukrainian
      // label, and mark unverified exits with a small indicator.
      const closure = App.closureLabel(t);
      const unverified = (t.exit_verified === false)
        ? ' <span class="td-dim" style="font-size:9px" title="' + App.t('hist.exit_unverified') + '">⏳</span>'
        : '';
      const exitReasonBadge = closure
        ? `<span class="b ${closure.cls}" style="font-size:9px">${esc(closure.text)}</span>${unverified}`
        : '<span class="td-dim">—</span>';

      return `<tr>
        <td class="td-dim">${App.fmtDate(t.date)}</td>
        <td>${mode}</td>
        <td>${tradeId}</td>
        <td class="td-main">${mktCell}</td>
        <td>${sideBadge}</td>
        <td class="td-mono">${entryPrice != null ? Number(entryPrice).toFixed(3) : '—'}</td>
        <td><span class="cur-price td-mono" data-entry="${entryPrice ?? ''}" data-current="${exitPrice ?? ''}">${exitPrice != null ? Number(exitPrice).toFixed(3) : '—'}</span></td>
        <td class="${pnlCls}">${pnlStr}</td>
        <td>${exitReasonBadge}</td>
        <td>${resultBadge}</td>
        <td class="td-dim">${esc(t.duration || '—')}</td>
        <td><button class="btn-del-hist" onclick="delHistTrade('${esc(t.condition_id || '')}',${t.open_ts || 0})" data-tip="Delete this trade from history">❌</button></td>
      </tr>`;
    }).join('');

    if (footer) {
      const s = S.history.summary || {};
      const netPnl = s.net_pnl ?? 0;
      const netCls = netPnl > 0 ? 'td-pos' : netPnl < 0 ? 'td-neg' : '';
      const wrColor = (s.win_rate || 0) >= 50 ? 'var(--grn)' : 'var(--red)';
      footer.innerHTML = `<tr>
        <td colspan="6">Total: ${s.total || 0} trades · Win rate: <span style="color:${wrColor};font-weight:700">${s.win_rate ?? 0}%</span></td>
        <td class="${netCls}" style="font-weight:700">${(netPnl >= 0 ? '+' : '') + fmt$(netPnl)}</td>
        <td colspan="4"></td>
      </tr>`;
    }

    App.colorPrices();
  };

  App.delHistTrade = async function (conditionId, openTs) {
    if (!confirm(App.t('hist.delete_confirm'))) return;
    try {
      await fetch('/api/polymarket/history/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ condition_id: conditionId, open_ts: openTs }),
      });
      App.loadAll();
    } catch (e) {
      App.toast(App.t('hist.delete_err', { error: e.message }), 'err');
    }
  };
  window.delHistTrade = App.delHistTrade;

})(window.App);
