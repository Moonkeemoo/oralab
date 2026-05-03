/**
 * GTC Limit Orders tab — dead-book fallback monitoring.
 * Shows pending GTC orders and recent fills.
 */
(function (App) {
  'use strict';
  var $ = App.$;
  var S = App.state;

  S.gtcPending = [];
  S.gtcFills = [];

  App.renderGtcOrders = function () {
    var pending = S.gtcPending || [];
    var fills = S.gtcFills || [];
    var countEl = $('gtcCount');
    if (countEl) countEl.textContent = pending.length || '';

    // ── Pending table ──
    var ptbody = $('gtcPendingTbody');
    if (ptbody) {
      if (!pending.length) {
        ptbody.innerHTML = '<tr><td colspan="9" class="empty">' + App.t('gtc.no_pending') + '</td></tr>';
      } else {
        ptbody.innerHTML = pending.map(function (o) {
          var age = o.age_s || 0;
          var ttl = o.ttl_s || 60;
          var pct = Math.min(age / ttl * 100, 100);
          var barColor = pct > 80 ? '#e74c3c' : pct > 50 ? '#f39c12' : '#2ecc71';
          var wShort = (o.whale_wallet || '').slice(0, 10) + '…';
          return '<tr>' +
            '<td title="' + (o.title || '') + '">' + (o.title || '?').slice(0, 40) + '</td>' +
            '<td>' + (o.outcome || '?') + '</td>' +
            '<td class="mono">' + wShort + '</td>' +
            '<td class="mono">' + (o.price || 0).toFixed(3) + '</td>' +
            '<td class="mono">' + (o.whale_price || 0).toFixed(3) + '</td>' +
            '<td class="mono" style="color:#e74c3c">' + (o.market_price || 0).toFixed(3) + '</td>' +
            '<td>$' + (o.cost_usd || 0).toFixed(2) + '</td>' +
            '<td>' + age + 's</td>' +
            '<td><div style="width:50px;height:8px;background:#333;border-radius:4px;overflow:hidden">' +
              '<div style="width:' + pct + '%;height:100%;background:' + barColor + '"></div></div></td>' +
          '</tr>';
        }).join('');
      }
    }

    // ── Fills table ──
    var ftbody = $('gtcFillsTbody');
    if (ftbody) {
      if (!fills.length) {
        ftbody.innerHTML = '<tr><td colspan="7" class="empty">' + App.t('gtc.no_fills') + '</td></tr>';
      } else {
        ftbody.innerHTML = fills.slice(-20).reverse().map(function (t) {
          var ts = new Date((t.timestamp || 0) * 1000);
          var timeStr = ts.toLocaleString('uk-UA', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
          var pnl = t.unrealized_pnl_liquidation || t.unrealized_pnl_fair || 0;
          var pnlColor = pnl >= 0 ? '#2ecc71' : '#e74c3c';
          return '<tr>' +
            '<td>' + timeStr + '</td>' +
            '<td title="' + (t.market || '') + '">' + (t.market || '?').slice(0, 35) + '</td>' +
            '<td>' + (t.outcome || '?') + '</td>' +
            '<td class="mono">' + (t.entry_price || 0).toFixed(3) + '</td>' +
            '<td class="mono">' + (t.gtc_whale_price || t.whale_price || 0).toFixed(3) + '</td>' +
            '<td>$' + (t.our_cost || 0).toFixed(2) + '</td>' +
            '<td style="color:' + pnlColor + '">$' + pnl.toFixed(2) + '</td>' +
          '</tr>';
        }).join('');
      }
    }
  };

})(window.App);
