/* Ora et Labora — Calibrator Whales sub-tab */
/* Per-whale PnL table with performance bars */

(function (App) {
  'use strict';

  const esc = App.esc;

  // ── Section header HTML ────────────────────────────────────────────────────
  function _sectionHeader(barColor, title, description) {
    const descHtml = description
      ? `<div style="font-size:10px;color:#64748b;line-height:1.5;margin-bottom:12px;padding-left:11px">${description}</div>`
      : '';
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:${description ? '6px' : '12px'}">
        <div style="width:3px;height:14px;background:${barColor};border-radius:2px;flex-shrink:0"></div>
        <span style="font-size:11px;font-weight:700;color:#f1f5f9;text-transform:uppercase;letter-spacing:.06em">${esc(title)}</span>
      </div>
      ${descHtml}`;
  }

  // ── Classification badge HTML ──────────────────────────────────────────────
  function _classBadge(cls) {
    const MAP = {
      INFORMED:     { color: '#22c55e', bg: '#052e16', border: '#22c55e33', labelKey: 'cal.class_informed' },
      SNIPER:       { color: '#f59e0b', bg: '#451a03', border: '#f59e0b33', labelKey: 'cal.class_sniper' },
      ACCUMULATOR:  { color: '#3b82f6', bg: '#172554', border: '#3b82f633', labelKey: 'cal.class_accumulator' },
      MARKET_MAKER: { color: '#94a3b8', bg: '#1e293b', border: '#33415533', labelKey: 'cal.class_market_maker' },
      COPYCAT:      { color: '#f97316', bg: '#431407', border: '#f9731633', labelKey: 'cal.class_copycat' },
      NOISE:        { color: '#f43f5e', bg: '#4c0519', border: '#f43f5e33', labelKey: 'cal.class_noise' },
      smart_money:  { color: '#a78bfa', bg: '#2e1065', border: '#7c3aed33', labelKey: 'cal.class_smart_money' },
      unknown:      { color: '#475569', bg: '#1e293b', border: '#33415533', labelKey: 'cal.class_unknown' },
    };
    const s = MAP[cls] || MAP.unknown;
    return `<span style="font-size:9px;background:${s.bg};color:${s.color};border:1px solid ${s.border};border-radius:4px;padding:1px 6px;font-weight:600;white-space:nowrap">${esc(App.t(s.labelKey))}</span>`;
  }

  // ── WR color ───────────────────────────────────────────────────────────────
  function _wrColor(wr) {
    if (wr > 0.60) return '#22c55e';
    if (wr >= 0.50) return '#f59e0b';
    return '#f43f5e';
  }

  // ── Performance bar HTML ───────────────────────────────────────────────────
  function _perfBar(pnl, maxAbs) {
    const pct = maxAbs > 0 ? Math.min(100, Math.round((Math.abs(pnl) / maxAbs) * 100)) : 0;
    const color = pnl >= 0 ? '#22c55e' : '#f43f5e';
    return `
      <div style="display:flex;align-items:center;gap:6px;min-width:80px">
        <div style="flex:1;height:6px;background:rgba(255,255,255,0.05);border-radius:3px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width .3s"></div>
        </div>
        <span style="font-size:9px;color:#475569;flex-shrink:0;width:28px;text-align:right;font-family:monospace">${pct}%</span>
      </div>`;
  }

  // ── Whale table row HTML ───────────────────────────────────────────────────
  function _whaleRow(whale, idx, maxAbs) {
    const isEven = idx % 2 === 0;
    const rowBg  = isEven ? '#0c0f1a' : '#0e1120';
    const pnl    = whale.pnl != null ? whale.pnl : 0;
    const wr     = whale.win_rate != null ? whale.win_rate : 0;
    const trust  = whale.trust != null ? whale.trust : 0;
    const pnlColor = pnl >= 0 ? '#22c55e' : '#f43f5e';
    const pnlStr   = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
    const wrPct    = (wr * 100).toFixed(1) + '%';
    const wrColor  = _wrColor(wr);
    const wallet   = whale.wallet || '—';
    const walletFull = whale.wallet_full || wallet;

    return `
      <tr style="background:${rowBg};border-bottom:1px solid rgba(255,255,255,0.04)">
        <td style="padding:9px 10px;font-size:10px;color:#475569;text-align:center;width:32px">${idx + 1}</td>
        <td style="padding:9px 10px">
          <span
            title="${esc(walletFull)}"
            style="font-family:monospace;font-size:10px;color:#93c5fd;cursor:default"
          >${esc(wallet)}</span>
        </td>
        <td style="padding:9px 10px;font-size:11px;color:#94a3b8;text-align:center">${whale.trades != null ? whale.trades : '—'}</td>
        <td style="padding:9px 10px;font-size:11px;font-weight:700;color:${wrColor};text-align:center;font-family:monospace">${wrPct}</td>
        <td style="padding:9px 10px;font-size:11px;color:#94a3b8;text-align:center">${trust}</td>
        <td style="padding:9px 10px;text-align:center">${_classBadge(whale.classification || 'unknown')}</td>
        <td style="padding:9px 10px;font-size:12px;font-weight:700;color:${pnlColor};text-align:right;font-family:monospace;white-space:nowrap">${esc(pnlStr)}</td>
        <td style="padding:9px 14px 9px 10px;min-width:110px">${_perfBar(pnl, maxAbs)}</td>
      </tr>`;
  }

  // ── Summary row HTML ───────────────────────────────────────────────────────
  // Uses backend-provided totals (over full set) when available so the row
  // is accurate even under pagination; falls back to loaded-subset sum.
  function _summaryRow(whales, totals) {
    const t = totals || {};
    const totalTrades = t.trades != null ? t.trades : whales.reduce((s, w) => s + (w.trades || 0), 0);
    const totalWins   = t.wins   != null ? t.wins   : whales.reduce((s, w) => s + (w.wins   || 0), 0);
    const totalPnl    = t.pnl    != null ? t.pnl    : whales.reduce((s, w) => s + (w.pnl    || 0), 0);
    const whaleCount  = t.whales != null ? t.whales : whales.length;
    const avgWr       = totalTrades > 0 ? totalWins / totalTrades : 0;
    const pnlColor    = totalPnl >= 0 ? '#22c55e' : '#f43f5e';
    const pnlStr      = (totalPnl >= 0 ? '+$' : '-$') + Math.abs(totalPnl).toFixed(2);
    const wrPct       = (avgWr * 100).toFixed(1) + '%';
    const wrColor     = _wrColor(avgWr);

    return `
      <tr style="background:#111520;border-top:2px solid rgba(255,255,255,0.10)">
        <td style="padding:10px 10px;font-size:10px;color:#475569;text-align:center">Σ</td>
        <td style="padding:10px 10px;font-size:10px;font-weight:700;color:#f1f5f9">${App.t('cal.whales_count', {n: whaleCount})}</td>
        <td style="padding:10px 10px;font-size:11px;font-weight:700;color:#f1f5f9;text-align:center">${totalTrades}</td>
        <td style="padding:10px 10px;font-size:11px;font-weight:700;color:${wrColor};text-align:center;font-family:monospace">${wrPct}</td>
        <td style="padding:10px 10px"></td>
        <td style="padding:10px 10px"></td>
        <td style="padding:10px 10px;font-size:13px;font-weight:800;color:${pnlColor};text-align:right;font-family:monospace;white-space:nowrap">${esc(pnlStr)}</td>
        <td style="padding:10px 14px 10px 10px"></td>
      </tr>`;
  }

  // ── Timestamp footer ───────────────────────────────────────────────────────
  function _tsFooter(ts) {
    if (!ts) return '';
    const time = new Date(ts * 1000).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<div style="font-size:9px;color:#475569;text-align:right;margin-top:8px">${App.t('cal.updated_at', {time})}</div>`;
  }

  // ── Main module ────────────────────────────────────────────────────────────
  const PAGE_SIZE = 50;
  let _accumulated = [];      // whales fetched so far (sorted by PnL desc by server)
  let _total = 0;
  let _lastTs = 0;
  let _totals = null;         // aggregate across full set from the last response

  async function _fetchPage(offset) {
    return App.fetchJSON(`/api/polymarket/calibration/whales?limit=${PAGE_SIZE}&offset=${offset}`);
  }

  const CalWhales = {

    async load() {
      const el = document.getElementById('calTabWhales');
      if (!el) return;

      el.innerHTML = `<div style="color:#475569;font-size:12px;padding:24px 0;text-align:center">${esc(App.t('cal.loading'))}</div>`;

      let data;
      try {
        data = await _fetchPage(0);
      } catch (e) {
        el.innerHTML = `<div style="color:#f43f5e;font-size:12px;padding:24px 0;text-align:center">${esc(App.t('cal.load_error', {error: e.message}))}</div>`;
        return;
      }

      _accumulated = Array.isArray(data.whales) ? data.whales : [];
      _total = data.total != null ? data.total : _accumulated.length;
      _lastTs = data.ts || 0;
      _totals = data.totals || null;
      this.render();
    },

    async loadMore() {
      try {
        const data = await _fetchPage(_accumulated.length);
        if (Array.isArray(data.whales)) _accumulated = _accumulated.concat(data.whales);
        _total = data.total != null ? data.total : _accumulated.length;
        _lastTs = data.ts || _lastTs;
        _totals = data.totals || _totals;
      } catch (e) {
        // Non-fatal — keep existing render
        if (App.toast) App.toast(App.t('cal.load_error', {error: e.message}));
        return;
      }
      this.render();
    },

    render() {
      const el = document.getElementById('calTabWhales');
      if (!el) return;

      const whales = _accumulated;
      const ts     = _lastTs;

      const desc = App.t('cal.whales_desc');

      if (!whales.length) {
        el.innerHTML = `
          <div style="padding:2px 0">
            ${_sectionHeader('#22d3ee', App.t('cal.whales_title'), desc)}
            <div style="background:#0c0f1a;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:40px;text-align:center;color:#475569;font-size:12px">
              ${esc(App.t('cal.whales_empty'))}
            </div>
          </div>`;
        return;
      }

      // API returns sorted by PnL desc, but ensure it
      const sorted = [...whales].sort((a, b) => (b.pnl || 0) - (a.pnl || 0));
      const maxAbs = Math.max(...sorted.map(w => Math.abs(w.pnl || 0)), 1);

      // Classification summary
      const clsCounts = {};
      sorted.forEach(w => {
        const c = w.classification || 'unknown';
        clsCounts[c] = (clsCounts[c] || 0) + 1;
      });
      const clsOrder = ['INFORMED', 'SNIPER', 'ACCUMULATOR', 'COPYCAT', 'NOISE', 'unknown'];
      const clsTags = clsOrder
        .filter(c => clsCounts[c])
        .map(c => `${_classBadge(c)} <span style="font-size:10px;color:#94a3b8;margin-right:4px">${clsCounts[c]}</span>`)
        .join('');
      const legendHtml = clsTags
        ? `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px;padding:8px 12px;background:#0c0f1a;border:1px solid rgba(255,255,255,0.06);border-radius:8px">${clsTags}</div>`
        : '';

      const rows = sorted.map((w, i) => _whaleRow(w, i, maxAbs)).join('');

      const hasMore = _total > whales.length;
      const footerHtml = hasMore
        ? `<div style="display:flex;justify-content:center;margin-top:12px">
             <button id="calWhalesMore"
               style="background:#111520;color:#93c5fd;border:1px solid rgba(148,163,184,0.2);
                      border-radius:6px;padding:8px 16px;font-size:11px;cursor:pointer;
                      font-weight:600;letter-spacing:.04em">
               ${esc(App.t('cal.whales_show_more', {n: whales.length, total: _total}))}
             </button>
           </div>`
        : (whales.length > PAGE_SIZE
            ? `<div style="font-size:10px;color:#475569;text-align:center;margin-top:8px">
                 ${esc(App.t('cal.whales_all_loaded', {total: _total}))}
               </div>`
            : '');

      el.innerHTML = `
        <div style="padding:2px 0">
          ${_sectionHeader('#22d3ee', App.t('cal.whales_title'), desc)}
          ${legendHtml}
          <div class="cal-table-wrap" style="border:1px solid rgba(255,255,255,0.06);border-radius:10px">
            <table style="width:100%;min-width:680px;border-collapse:collapse">
              <thead>
                <tr style="background:#111520;border-bottom:1px solid rgba(255,255,255,0.08)">
                  <th style="padding:8px 10px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:center;width:32px">#</th>
                  <th style="padding:8px 10px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:left">${esc(App.t('cal.whales_wallet'))}</th>
                  <th style="padding:8px 10px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:center">${esc(App.t('cal.whales_trades'))}</th>
                  <th style="padding:8px 10px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:center">WR</th>
                  <th style="padding:8px 10px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:center">Trust</th>
                  <th style="padding:8px 10px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:center">${esc(App.t('cal.whales_class'))}</th>
                  <th style="padding:8px 10px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:right">PnL</th>
                  <th style="padding:8px 10px 8px 10px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#475569;text-align:left;min-width:110px">${esc(App.t('cal.whales_perf'))}</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
                ${_summaryRow(sorted, _totals)}
              </tbody>
            </table>
          </div>
          ${footerHtml}
          ${_tsFooter(ts)}
        </div>`;

      const moreBtn = document.getElementById('calWhalesMore');
      if (moreBtn) {
        moreBtn.addEventListener('click', () => {
          moreBtn.disabled = true;
          moreBtn.textContent = App.t('cal.loading');
          CalWhales.loadMore();
        });
      }
    },
  };

  window.CalWhales = CalWhales;

})(window.App);
