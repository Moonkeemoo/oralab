/* Ora et Labora — positions rendering */

(function (App) {
  'use strict';

  const $ = App.$;
  const S = App.state;
  const fmt$ = App.fmt$;
  const esc = App.esc;

  // Track positions currently being exited (by asset_id)
  S._exitingAssets = S._exitingAssets || {};

  // Ghost detection: fetch reconciliation data and overlay badges
  App.loadReconciliation = async function () {
    if (S.currentMode !== 'live') { S.reconciliation = null; return; }
    try {
      S.reconciliation = await App.fetchJSON('/api/polymarket/reconciliation?mode=live');
    } catch (e) { S.reconciliation = null; }
  };

  function _isPhantom(pos) {
    if (!S.reconciliation || !S.reconciliation.phantom) return false;
    return S.reconciliation.phantom.some(p => p.asset_id === pos.asset_id || p.trade_id === pos.trade_id);
  }

  App.renderPositions = function () {
    const tbody = $('positionsTbody');
    const countEl = $('posCount');
    if (!tbody) return;

    const positions = S.positions || [];
    if (countEl) countEl.textContent = positions.length;

    if (!positions.length) {
      tbody.innerHTML = '<tr><td colspan="15" class="td-dim" style="text-align:center;padding:32px">' + App.t('pos.no_positions') + '</td></tr>';
      return;
    }

    tbody.innerHTML = positions.map(p => {
      const isBuying = p.pending_action === 'buying' || p.fill_status === 'buying';
      const isSelling = p.pending_action === 'selling' || S._exitingAssets[p.asset_id || ''];

      const mode = p.trading_mode === 'live' ? '<span class="b b-live">LIVE</span>' : '<span class="b b-dry">DRY</span>';
      const tradeId = p.trade_id ? `<span class="trade-id">${esc((p.trade_id || '').slice(0, 4))}</span>` : '<span class="td-dim">—</span>';

      const pMktUrl = p.event_slug
        ? `https://polymarket.com/event/${esc(p.event_slug)}?r=moonkee`
        : '';
      const mktCell = pMktUrl
        ? `<a href="${pMktUrl}" target="_blank" class="mkt-link">${esc(p.market)}</a>`
        : esc(p.market || '—');

      const whaleCell = p.wallet
        ? `<span class="td-mono" style="color:var(--ind)">${esc(App.shortWallet(p.wallet))}</span>`
        : '<span class="td-dim">—</span>';

      const sideBadge = App.outcomeBadge(p.side);

      const orderId = p.order_id
        ? `<span class="order-id">${esc((p.order_id || '').slice(0, 8))}</span>`
        : '<span class="td-dim">—</span>';

      // Ghost detection badge
      const phantom = _isPhantom(p);
      const ghostBadge = phantom ? '<span class="b b-ghost" data-tip="Phantom: in trade_log but not on-chain">GHOST</span> ' : '';

      // ── Fill status badge (with pending buy/sell states) ──────────
      let fillBadgeHtml;
      if (isBuying) {
        fillBadgeHtml = '<span class="b b-buying pulse">' + App.t('pos.buying') + '</span>';
      } else if (isSelling) {
        fillBadgeHtml = '<span class="b b-selling pulse">' + App.t('pos.selling') + '</span>';
      } else {
        const fillStatus = p.fill_status || (p.trading_mode === 'live' ? 'filled' : 'simulated');
        const fillCls = fillStatus === 'filled' ? 'b-filled' : fillStatus === 'pending' ? 'b-pending' : 'b-simulated';
        fillBadgeHtml = `<span class="b ${fillCls}">${esc(fillStatus)}</span>`;
      }

      // B3: Mark quality badge with age + source tooltip.
      // Shows "Xs" when the mark is fresh and "Xs stale" when past the
      // threshold. Tooltip includes source, fetch status, and stale
      // cutoff so the operator can debug freshness at a glance.
      const markQ = p.mark_quality || (p.trading_mode === 'live' ? 'executable' : '—');
      const markCls = markQ === 'executable' ? 'b-exec' : markQ === 'stale' ? 'b-stale' : markQ === 'cached' ? 'b-cached' : 'b-indicative';
      const markSrc = p.mark_source_liquidation || p.mark_source_fair || '';
      const markAge = p.mark_age_s;
      const markThreshold = p.mark_stale_threshold_s;
      const markFetch = p.mark_fetch_status;
      const isStale = !!p.mark_stale;
      const isPending = !!p.mark_pending_refresh;

      // Badge label: prefer the age number when we have one.
      let markLabel;
      if (markAge == null) {
        markLabel = isPending ? 'pending' : markQ;
      } else if (isStale) {
        markLabel = Math.round(markAge) + 's stale';
      } else {
        markLabel = Math.round(markAge) + 's';
      }

      const tipParts = [];
      if (markSrc) tipParts.push(App.t('trades.mark_tip_source', {src: markSrc}));
      if (markAge != null) tipParts.push(App.t('trades.mark_tip_age', {age: Math.round(markAge)}));
      if (markThreshold != null) tipParts.push(App.t('trades.mark_tip_threshold', {threshold: Math.round(markThreshold)}));
      if (markFetch && markFetch !== 'ok') tipParts.push('fetch: ' + markFetch);
      if (isPending) tipParts.push(App.t('trades.mark_tip_pending'));
      const markTip = tipParts.length ? tipParts.join(' · ') : markQ;

      const markBadge = markQ !== '—'
        ? `<span class="b ${markCls}" data-tip="${esc(markTip)}">${esc(markLabel)}</span>`
        : '<span class="td-dim">—</span>';

      // B4: cost drift badge — warn when local cost basis has diverged
      // from the proportional on-chain slice by >$0.10. Shown next to
      // the cost cell. See AUDIT D3/B4 for why this can't just be fixed
      // silently at overlay time.
      let costDriftBadge = '';
      if (p.cost_drift_warn) {
        const drift = p.cost_drift;
        const driftPct = p.cost_drift_pct;
        const sign = drift > 0 ? '+' : '';
        const localOrig = p.cost_local_original;
        const ocProp = p.cost_onchain_proportional;
        const tipParts = ['local vs on-chain cost drift'];
        if (localOrig != null) tipParts.push('local: $' + localOrig.toFixed(2));
        if (ocProp != null) tipParts.push('on-chain: $' + ocProp.toFixed(2));
        if (drift != null) tipParts.push('Δ: ' + sign + '$' + drift.toFixed(2));
        if (driftPct != null) tipParts.push(sign + driftPct.toFixed(1) + '%');
        costDriftBadge = ` <span class="b b-drift" data-tip="${esc(tipParts.join(' · '))}">Δ${sign}${Math.abs(drift).toFixed(2)}</span>`;
      }

      // Liq-based price (what you'd actually receive selling) vs fair.
      // E3 (audit M3): displayed number is TWAP-smoothed (same value the
      // bot makes SL/TP decisions on). Raw (pre-smoothing) price exposed
      // in the tooltip so users can see exactly why a decision fired on
      // a number different from the ticker.
      const liqPrice = p.current_price_liquidation ?? p.current_price ?? null;
      const fairPrice = p.current_price_fair ?? p.current_price ?? null;
      const rawLiq = p.current_price_raw_liquidation ?? null;
      const rawFair = p.current_price_raw_fair ?? null;
      const twapWindow = p.current_price_twap_window || 0;
      const displayPrice = liqPrice ?? fairPrice;
      const _tipParts = [];
      if (liqPrice != null && fairPrice != null && Math.abs(liqPrice - fairPrice) > 0.001) {
        _tipParts.push('liq: ' + liqPrice.toFixed(3) + ' · fair: ' + fairPrice.toFixed(3));
      }
      if (rawLiq != null && liqPrice != null && Math.abs(rawLiq - liqPrice) >= 0.002) {
        _tipParts.push('TWAP(' + twapWindow + '): ' + liqPrice.toFixed(3) + ' · raw: ' + rawLiq.toFixed(3));
      } else if (twapWindow >= 2 && rawLiq != null) {
        _tipParts.push('TWAP(' + twapWindow + ') = raw (' + rawLiq.toFixed(3) + ')');
      }
      const priceTip = _tipParts.join(' | ');
      // Small badge when TWAP and raw diverge by ≥ 0.5¢ — draws the eye
      // to positions where the displayed price is meaningfully different
      // from the instantaneous quote.
      const twapDivergent = (
        rawLiq != null && liqPrice != null && twapWindow >= 2
        && Math.abs(rawLiq - liqPrice) >= 0.005
      );
      const twapBadge = twapDivergent
        ? ` <span class="b b-twap" data-tip="TWAP(${twapWindow}) used for bot decisions · raw: ${rawLiq.toFixed(3)}">TWAP</span>`
        : '';

      const pnl = p.unrealized_pnl ?? 0;
      const pnlCls = pnl > 0 ? 'td-pos' : pnl < 0 ? 'td-neg' : 'td-dim';
      const pnlStr = (pnl >= 0 ? '+' : '') + fmt$(pnl);

      // ── SL/TP progress bar ───────────────────────────────────────────
      const rs = S.riskSettings || {};
      const slPct = (rs.EXIT_STOP_LOSS ?? -0.25) * 100;        // e.g. -25
      const tpPct = (rs.EXIT_TAKE_PROFIT ?? 0.40) * 100;       // e.g. +40
      let pnlPctVal = 0;
      if (p.cost && p.cost > 0) {
        pnlPctVal = (pnl / p.cost) * 100;
      }
      // Clamp marker between SL-10 and TP+10 for visual range
      const rangeMin = slPct - 10;
      const rangeMax = tpPct + 10;
      const clampedPnl = Math.max(rangeMin, Math.min(rangeMax, pnlPctVal));
      const markerPos = ((clampedPnl - rangeMin) / (rangeMax - rangeMin)) * 100;
      // SL and TP zone boundaries as % of total bar width
      const slZone = ((slPct - rangeMin) / (rangeMax - rangeMin)) * 100;
      const tpZone = ((tpPct - rangeMin) / (rangeMax - rangeMin)) * 100;
      const zeroPos = ((0 - rangeMin) / (rangeMax - rangeMin)) * 100;
      const pnlPctStr = (pnlPctVal >= 0 ? '+' : '') + pnlPctVal.toFixed(1) + '%';
      const slTpBar = (!isBuying && p.entry_price > 0) ? `
        <div class="sltp-bar" data-tip="${App.t('pos.sltp_tip', {sl: slPct.toFixed(0), now: pnlPctStr, tp: tpPct.toFixed(0)})}">
          <div class="sltp-sl" style="width:${slZone.toFixed(1)}%"></div>
          <div class="sltp-safe" style="left:${slZone.toFixed(1)}%;width:${(tpZone - slZone).toFixed(1)}%"></div>
          <div class="sltp-tp" style="left:${tpZone.toFixed(1)}%;width:${(100 - tpZone).toFixed(1)}%"></div>
          <div class="sltp-zero" style="left:${zeroPos.toFixed(1)}%"></div>
          <div class="sltp-marker ${pnlPctVal >= 0 ? 'sltp-marker-pos' : 'sltp-marker-neg'}" style="left:${markerPos.toFixed(1)}%"></div>
        </div>` : '';

      // ── Exit / Dismiss button ────────────────────────────────────
      let exitBtnHtml;
      if (isBuying) {
        exitBtnHtml = '<button class="btn-exit" disabled style="opacity:0.3">—</button>';
      } else if (isSelling) {
        exitBtnHtml = '<button class="btn-exit btn-exit-loading" disabled><span class="spinner-sm"></span> ' + App.t('pos.exiting') + '</button>';
      } else if (phantom) {
        exitBtnHtml = `<button class="btn-exit btn-dismiss" onclick="dismissPosition('${esc(p.trade_id || '')}','${esc(p.market || '')}')">Dismiss</button>`;
      } else {
        exitBtnHtml = `<button class="btn-exit" onclick="exitPosition('${esc(p.trade_id || '')}','${esc(p.condition_id || '')}','${esc(p.asset_id || '')}','${esc(p.market || '')}','${esc(p.trading_mode || '')}')">${App.t('pos.exit_btn')}</button>`;
      }

      // B3: Row classes — buying/selling states take precedence, but
      // stale mark adds a dedicated border so the operator can see at a
      // glance which positions are running on stale prices.
      const rowClassList = [];
      if (isBuying) rowClassList.push('row-buying');
      else if (isSelling) rowClassList.push('row-selling');
      if (isStale) rowClassList.push('row-mark-stale');
      const rowCls = rowClassList.length ? ` class="${rowClassList.join(' ')}"` : '';

      return `<tr${rowCls}>
        <td>${mode}</td>
        <td>${tradeId}</td>
        <td class="td-main">${mktCell}</td>
        <td>${whaleCell}</td>
        <td>${sideBadge} ${App.strategyBadge(p.strategy)}</td>
        <td><span class="td-mono">${p.entry_price != null ? p.entry_price.toFixed(3) : '—'}</span></td>
        <td><span class="cur-price td-mono" data-entry="${p.entry_price ?? ''}" data-current="${displayPrice ?? ''}"${priceTip ? ' data-tip="' + esc(priceTip) + '"' : ''}>${displayPrice != null ? displayPrice.toFixed(3) : '—'}</span>${twapBadge}</td>
        <td><span class="td-mono">${fmt$(p.cost)}</span>${costDriftBadge}</td>
        <td class="${pnlCls}">${pnlStr} <span class="td-dim" style="font-size:10px">${!isBuying && p.entry_price > 0 ? pnlPctStr : ''}</span>${slTpBar}</td>
        <td>${orderId}</td>
        <td>${ghostBadge}${fillBadgeHtml}</td>
        <td>${markBadge}</td>
        <td class="td-dim">${p.age_ts ? App.fmtAge(p.age_ts) : '—'}</td>
        <td class="td-dim">${p.last_price_update_ts ? App.fmtUpdatedAt(p.last_price_update_ts) : '—'}</td>
        <td>${exitBtnHtml}</td>
      </tr>`;
    }).join('');

    App.colorPrices();
  };

  App.exitPosition = async function (tradeId, conditionId, assetId, market, mode) {
    const isLive = mode === 'live';
    const msg = isLive
      ? App.t('pos.confirm_exit_live', {market: market})
      : App.t('pos.confirm_exit_dry', {market: market});
    if (!confirm(msg)) return;

    // Immediately mark as exiting and re-render
    if (assetId) S._exitingAssets[assetId] = true;
    App.renderPositions();

    try {
      const body = {};
      if (tradeId) body.trade_id = tradeId;
      if (conditionId) body.condition_id = conditionId;
      if (assetId) body.asset_id = assetId;
      const resp = await fetch('/api/polymarket/positions/exit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      App.toast(App.t('pos.exit_ok'), 'ok');
      setTimeout(() => App.loadAll(), 1000);
    } catch (e) {
      App.toast(App.t('pos.exit_err', {error: e.message}), 'err');
    } finally {
      if (assetId) delete S._exitingAssets[assetId];
      App.renderPositions();
    }
  };
  window.exitPosition = App.exitPosition;

  App.dismissPosition = async function (tradeId, market) {
    if (!confirm(App.t('pos.confirm_dismiss', {market: market}))) return;
    try {
      const resp = await fetch('/api/polymarket/positions/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade_id: tradeId }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      App.toast(App.t('pos.dismiss_ok', {count: data.count || 1}), 'ok');
      setTimeout(() => App.loadAll(), 500);
    } catch (e) {
      App.toast(App.t('pos.dismiss_err', {error: e.message}), 'err');
    }
  };
  window.dismissPosition = App.dismissPosition;

})(window.App);
