(function (App) {
  'use strict';
  const $ = App.$;
  const S = App.state;
  const CLASS_EMOJI = App.CLASS_EMOJI || {};

  // ─── Client-side pagination ─────────────────────
  // Rendering thousands of rows kills the tab; keep DOM bounded and let the
  // user opt into more. Reset whenever filter/sort/mode/search changes.
  const PAGE_SIZE = 100;
  let _walletsShown = PAGE_SIZE;
  let _signalsShown = PAGE_SIZE;
  function _resetWalletPage()  { _walletsShown = PAGE_SIZE; }
  function _resetSignalPage()  { _signalsShown = PAGE_SIZE; }

  // ─── Helpers (from wallets.js) ──────────────────────────────
  function profileFor(addr) {
    if (!addr) return null;
    return S.profilesMap[addr] || S.profilesMap[(addr || '').toLowerCase()] || null;
  }

  function categoryBadge(cat) {
    if (!cat) return '';
    const name = typeof cat === 'object' ? (cat.name || '') : String(cat);
    const pct  = typeof cat === 'object' ? (cat.pct  || '') : '';
    const upper = name.toUpperCase();
    let cls = '';
    if (upper === 'POLITICS') cls = 'b-pol';
    else if (upper.startsWith('SPORT')) cls = 'b-sport';
    else if (upper === 'CRYPTO') cls = 'b-crypto';
    else if (upper === 'FINANCE' || upper === 'ECONOMICS') cls = 'b-econ';

    if (cls) {
      const label = pct ? `${name} ${pct}%` : name;
      return `<span class="b ${cls}">${App.esc(label)}</span>`;
    }
    return `<span class="b" style="background:rgba(100,116,139,.1);border:1px solid rgba(100,116,139,.2);color:var(--t2)">${App.esc(pct ? `${name} ${pct}%` : name)}</span>`;
  }

  // ─── Mode switch ────────────────────────────────
  function switchWhalesMode(mode, btn) {
    S.whalesMode = mode;
    _resetWalletPage();
    _resetSignalPage();
    document.querySelectorAll('.wh-mode-btn').forEach(b => b.classList.remove('on'));
    if (btn) btn.classList.add('on');

    const walletTable = $('whWalletTable');
    const signalTable = $('whSignalTable');
    const signalSummary = $('whSignalSummary');
    const sortW = $('whSortWallets');
    const sortS = $('whSortSignals');
    const domainFilter = $('whDomainFilter');
    const typeFilter = $('whTypeFilter');

    if (mode === 'wallets') {
      walletTable.classList.remove('hidden');
      signalTable.classList.add('hidden');
      signalSummary.classList.add('hidden');
      sortW.classList.remove('hidden');
      sortS.classList.add('hidden');
      if (domainFilter) domainFilter.classList.remove('hidden');
      _populateTypeFilter('wallets');
      renderWallets();
    } else {
      walletTable.classList.add('hidden');
      signalTable.classList.remove('hidden');
      signalSummary.classList.remove('hidden');
      sortW.classList.add('hidden');
      sortS.classList.remove('hidden');
      if (domainFilter) domainFilter.classList.add('hidden');
      _populateTypeFilter('signals');
      renderSignals();
    }
  }

  function _populateTypeFilter(mode) {
    const sel = $('whTypeFilter');
    if (!sel) return;
    if (mode === 'signals') {
      sel.innerHTML = '<option value="">' + App.t('whales.all_levels') + '</option>'
        + '<option value="PROBE">PROBE</option>'
        + '<option value="CONFIRM">CONFIRM</option>'
        + '<option value="CONVICTION">CONVICTION</option>';
    } else {
      sel.innerHTML = '<option value="">' + App.t('whales.all_types') + '</option>'
        + '<option value="INFORMED">INFORMED</option>'
        + '<option value="SNIPER">SNIPER</option>'
        + '<option value="ACCUMULATOR">ACCUMULATOR</option>'
        + '<option value="MARKET_MAKER">MARKET_MAKER</option>'
        + '<option value="COPYCAT">COPYCAT</option>'
        + '<option value="NOISE">NOISE</option>';
    }
  }

  // ─── Sort / Filter handlers ─────────────────────
  function setWhaleSort(el) {
    const sort = el.dataset?.sort || el;
    S.whalesSort = sort;
    document.querySelectorAll('#whSortWallets .sort-b').forEach(b =>
      b.classList.toggle('on', b.dataset.sort === sort));
    _resetWalletPage();
    renderWallets();
  }

  function setSignalSort(el) {
    const sort = el.dataset?.sort || el;
    S.signalSort = sort;
    document.querySelectorAll('#whSortSignals .sort-b').forEach(b =>
      b.classList.toggle('on', b.dataset.sort === sort));
    _resetSignalPage();
    renderSignals();
  }

  function setWhaleTypeFilter(el) {
    if (S.whalesMode === 'signals') {
      S.signalFilter = el.value;
      _resetSignalPage();
      renderSignals();
    } else {
      S.whalesTypeFilter = el.value;
      _resetWalletPage();
      renderWallets();
    }
  }

  function setWhaleDomainFilter(el) {
    S.whalesDomainFilter = el.value;
    _resetWalletPage();
    renderWallets();
  }

  function setWhaleSearch(el) {
    S.whalesSearch = (el.value || '').toLowerCase();
    if (S.whalesMode === 'signals') {
      _resetSignalPage();
      renderSignals();
    } else {
      _resetWalletPage();
      renderWallets();
    }
  }

  // ─── Discovery toggle ──────────────────────────
  function toggleDisco() {
    const panel = $('discoPanel');
    const btn = $('discoToggle');
    if (panel) panel.classList.toggle('open');
    if (btn) btn.classList.toggle('open');
  }

  // ─── renderWallets (merged wallets + leaderboard) ──
  function renderWallets() {
    const tbody = $('whWalletsTbody');
    if (!tbody) return;

    const wallets = S.wallets || [];
    const profiles = S.profilesMap || {};
    const intents = S.intents || [];

    // Build lookup maps
    const lbMap = {};
    (S.lbData || []).forEach(p => { lbMap[(p.wallet || '').toLowerCase()] = p; });

    const intentByWallet = {};
    intents.forEach(r => {
      const w = (r.wallet || '').toLowerCase();
      if (!intentByWallet[w]) intentByWallet[w] = { probes: 0, confirms: 0, convictions: 0 };
      if (r.level === 'PROBE') intentByWallet[w].probes++;
      else if (r.level === 'CONFIRM') intentByWallet[w].confirms++;
      else if (r.level === 'CONVICTION') intentByWallet[w].convictions++;
    });

    // Update summary cards
    _updateSummaryCards(wallets, intents);

    if (!wallets.length) {
      tbody.innerHTML = '<tr><td colspan="13" class="td-dim" style="text-align:center;padding:32px">' + App.t('whales.empty') + '</td></tr>';
      return;
    }

    // Filter
    let filtered = [...wallets];
    if (S.whalesTypeFilter) {
      filtered = filtered.filter(w => {
        const addr = (w.address || w.wallet || '').toLowerCase();
        const prof = profiles[addr];
        return prof?.classification === S.whalesTypeFilter;
      });
    }
    if (S.whalesDomainFilter) {
      filtered = filtered.filter(w => {
        const addr = (w.address || w.wallet || '').toLowerCase();
        const prof = profiles[addr];
        return (prof?.primary_domain || '').toLowerCase() === S.whalesDomainFilter;
      });
    }
    if (S.whalesSearch) {
      filtered = filtered.filter(w => {
        const addr = (w.address || w.wallet || '').toLowerCase();
        const name = (w.userName || w.name || '').toLowerCase();
        return addr.includes(S.whalesSearch) || name.includes(S.whalesSearch);
      });
    }

    // Sort
    const sorted = [...filtered].sort((a, b) => {
      const addrA = (a.address || a.wallet || '').toLowerCase();
      const addrB = (b.address || b.wallet || '').toLowerCase();
      const profA = profiles[addrA] || {};
      const profB = profiles[addrB] || {};
      const lbA = lbMap[addrA] || {};
      const lbB = lbMap[addrB] || {};
      let va, vb;
      switch (S.whalesSort) {
        case 'conviction':
          va = lbA.conviction_rate || 0; vb = lbB.conviction_rate || 0; break;
        case 'sm':
          va = profA.smart_money_score || 0; vb = profB.smart_money_score || 0; break;
        case 'capital':
          va = lbA.total_capital || 0; vb = lbB.total_capital || 0; break;
        case 'pnl':
          va = Number(a.trust_pnl) || 0; vb = Number(b.trust_pnl) || 0; break;
        case 'trust':
          va = Number(a.trust_score) || 50; vb = Number(b.trust_score) || 50; break;
        default:
          va = lbA.conviction_rate || 0; vb = lbB.conviction_rate || 0;
      }
      return S.whalesSortAsc ? va - vb : vb - va;
    });

    // Render rows (bounded by _walletsShown — rest revealed via "Show more")
    const totalSorted = sorted.length;
    const pageSorted = sorted.slice(0, _walletsShown);
    tbody.innerHTML = pageSorted.map((w, i) => {
      const addr = w.address || w.wallet || '';
      const addrLower = addr.toLowerCase();
      const profile = profileFor(addr);
      const lb = lbMap[addrLower] || {};
      const sigs = intentByWallet[addrLower] || {};

      // SM Score
      const smScore = profile?.smart_money_score ?? w.score;
      const smClass = smScore != null ? (smScore >= 70 ? 'var(--grn)' : smScore >= 40 ? 'var(--amb)' : 'var(--red)') : 'var(--t3)';

      // Trust
      const score = Number(w.trust_score) || 50;
      const tc = App.trustColor(score);

      // Conviction rate
      const cr = lb.conviction_rate ?? null;
      const crColor = cr != null ? (cr >= 30 ? 'var(--grn)' : cr >= 10 ? 'var(--amb)' : 'var(--red)') : 'var(--t3)';

      // Domain
      const domain = (profile && profile.primary_domain) || '';
      const domainBadge = domain
        ? `<span class="b" style="background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.2);color:rgb(139,92,246);font-size:9px">${App.esc(domain)}</span>`
        : '<span class="td-dim">\u2014</span>';

      // Win rate
      const trustTrades = (w.trust_wins || 0) + (w.trust_losses || 0);
      const winRate = trustTrades > 0 ? ((w.trust_wins / trustTrades) * 100) : null;
      const wr = winRate != null ? winRate.toFixed(0) : null;
      const wrColor = winRate != null ? (winRate >= 75 ? 'var(--grn)' : winRate >= 60 ? 'var(--amb)' : 'var(--red)') : 'var(--t3)';

      // PNL
      const trustPnl = Number(w.trust_pnl) || 0;
      const pnlCls = trustPnl > 0 ? 'td-pos' : trustPnl < 0 ? 'td-neg' : 'td-dim';

      // Capital
      const capital = lb.total_capital ?? null;

      // Markets
      const mkts = lb.markets_tracked ?? null;
      const activeMkts = lb.active_markets || 0;
      const mktsCell = mkts != null
        ? (activeMkts > 0 ? `${mkts} <span style="color:var(--grn);font-size:10px">(${activeMkts} active)</span>` : String(mkts))
        : '<span class="td-dim">\u2014</span>';

      // Signals badges
      let sigHtml = '';
      if (sigs.convictions) sigHtml += `<span class="b b-conv" style="cursor:pointer" onclick="switchWhalesMode('signals')">V ${sigs.convictions}</span> `;
      if (sigs.confirms) sigHtml += `<span class="b b-confirm" style="cursor:pointer" onclick="switchWhalesMode('signals')">C ${sigs.confirms}</span> `;
      if (sigs.probes) sigHtml += `<span class="b b-probe" style="cursor:pointer" onclick="switchWhalesMode('signals')">P ${sigs.probes}</span>`;
      if (!sigHtml) sigHtml = '<span class="td-dim">\u2014</span>';

      // Categories
      const cats = Array.isArray(w.categories) ? w.categories : (w.category ? [w.category] : []);

      // Type
      const classification = profile?.classification || '';
      const classEmoji = CLASS_EMOJI[classification] || '';
      const typeBadge = classification
        ? `<span class="b" style="font-size:9px">${App.esc(classEmoji)} ${App.esc(classification)}</span>`
        : '<span class="td-dim">\u2014</span>';

      // Name
      const nameTag = (w.userName || w.name) ? `<span style="color:var(--t3);font-size:10px;margin-left:5px">${App.esc(w.userName || w.name)}</span>` : '';

      return `<tr>
        <td class="td-dim">${i + 1}</td>
        <td><span class="td-mono" style="color:var(--ind)">${App.esc(App.shortWallet(addr))}</span>${nameTag}</td>
        <td>${smScore != null ? `<span style="color:${smClass};font-weight:700">${smScore}</span>` : '\u2014'}</td>
        <td><div class="trust-ring" style="border-color:${tc};color:${tc}">${score}</div></td>
        <td>${cr != null ? `<div class="winbar"><div class="winbar-bg"><div class="winbar-fill" style="width:${Math.min(cr,100)}%;background:${crColor}"></div></div><span style="font-size:11px;font-weight:700;color:${crColor}">${cr}%</span></div>` : '<span class="td-dim">\u2014</span>'}</td>
        <td>${domainBadge}</td>
        <td><div class="winbar"><div class="winbar-bg"><div class="winbar-fill" style="width:${wr != null ? wr : 0}%;background:${wrColor}"></div></div><span style="font-size:10px;color:${wrColor}">${wr != null ? wr + '%' : '\u2014'}</span></div></td>
        <td class="${pnlCls}">${trustPnl !== 0 ? (trustPnl > 0 ? '+' : '') + App.fmt$(trustPnl) : '\u2014'}</td>
        <td class="td-pos">${capital != null ? App.fmt$(capital) : '<span class="td-dim">\u2014</span>'}</td>
        <td style="color:var(--t2)">${mktsCell}</td>
        <td>${sigHtml}</td>
        <td>${cats.map(categoryBadge).join(' ')}</td>
        <td>${typeBadge}</td>
      </tr>`;
    }).join('');

    if (totalSorted > pageSorted.length) {
      const remaining = totalSorted - pageSorted.length;
      tbody.innerHTML += `<tr id="whWalletsMoreRow"><td colspan="13" style="text-align:center;padding:12px">
        <button id="whWalletsMoreBtn" class="b" style="cursor:pointer;padding:6px 14px;font-size:11px;font-weight:600">
          ${App.t ? App.t('whales.show_more', {shown: pageSorted.length, total: totalSorted}) : `Показати ще (${pageSorted.length} з ${totalSorted})`}
        </button>
      </td></tr>`;
      const btn = $('whWalletsMoreBtn');
      if (btn) btn.addEventListener('click', () => {
        _walletsShown += PAGE_SIZE;
        renderWallets();
      });
    }
  }

  // ─── renderSignals (moved from intent.js) ──────
  function renderSignals() {
    const tbody = $('whSignalsTbody');
    if (!tbody) return;

    const records = S.intents || [];
    const profiles = S.profilesMap || {};

    // Update signal summary
    _updateSignalSummary(records);

    // Filter by level
    let filtered = S.signalFilter
      ? records.filter(r => r.level === S.signalFilter)
      : [...records];

    // Filter by search
    if (S.whalesSearch) {
      filtered = filtered.filter(r => {
        const addr = (r.wallet || '').toLowerCase();
        const title = (r.market_title || '').toLowerCase();
        return addr.includes(S.whalesSearch) || title.includes(S.whalesSearch);
      });
    }

    // Sort
    const LEVEL_ORDER = { CONVICTION: 0, CONFIRM: 1, PROBE: 2 };
    const sorted = [...filtered].sort((a, b) => {
      switch (S.signalSort) {
        case 'total': return (b.total_invested || 0) - (a.total_invested || 0);
        case 'trades': return (b.trade_count || 0) - (a.trade_count || 0);
        case 'last_trade': return (b.last_trade_time || 0) - (a.last_trade_time || 0);
        default: // level
          return (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9)
            || (b.total_invested || 0) - (a.total_invested || 0);
      }
    });

    if (!sorted.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="td-dim" style="text-align:center;padding:32px">No intent records</td></tr>';
      return;
    }

    const totalSorted = sorted.length;
    const pageSorted = sorted.slice(0, _signalsShown);
    tbody.innerHTML = pageSorted.map(r => {
      const levelBadge = r.level === 'PROBE'
        ? '<span class="b b-probe">PROBE</span>'
        : r.level === 'CONFIRM'
        ? '<span class="b b-confirm">CONFIRM</span>'
        : '<span class="b b-conv">CONVICTION</span>';

      const sideBadge = (r.side === 'YES' || r.side === 'BUY')
        ? '<span class="b b-yes">BUY</span>'
        : '<span class="b b-no">SELL</span>';

      const mktCell = r.market_title
        ? `<span class="td-main">${App.esc(r.market_title.length > 50 ? r.market_title.slice(0, 50) + '\u2026' : r.market_title)}</span>`
        : (r.market_id ? App.esc(r.market_id.slice(0, 10) + '\u2026') : '\u2014');

      // SM + Trust from profiles
      const addr = (r.wallet || '').toLowerCase();
      const prof = profiles[addr] || {};
      const smScore = prof.smart_money_score;
      const smColor = smScore != null ? (smScore >= 70 ? 'var(--grn)' : smScore >= 40 ? 'var(--amb)' : 'var(--red)') : 'var(--t3)';

      // Trust from wallet data or profile
      const walletData = (S.wallets || []).find(w => (w.address || w.wallet || '').toLowerCase() === addr);
      const trustScore = walletData ? (Number(walletData.trust_score) || 50) : null;
      const tc = trustScore != null ? App.trustColor(trustScore) : 'var(--t3)';

      return `<tr>
        <td class="td-mono" style="color:var(--ind)">${App.esc(App.shortWallet(r.wallet))}</td>
        <td>${mktCell}</td>
        <td>${sideBadge}</td>
        <td>${levelBadge}</td>
        <td style="font-weight:700;color:var(--t1)">${r.trade_count || 0}</td>
        <td class="td-pos">${App.fmt$(r.total_invested)}</td>
        <td>${smScore != null ? `<span style="color:${smColor};font-weight:700">${smScore}</span>` : '<span class="td-dim">\u2014</span>'}</td>
        <td>${trustScore != null ? `<div class="trust-ring" style="border-color:${tc};color:${tc};width:28px;height:28px;font-size:10px">${trustScore}</div>` : '<span class="td-dim">\u2014</span>'}</td>
        <td class="td-dim">${App.fmtTs(r.probe_time)}</td>
        <td class="td-dim">${App.fmtTs(r.last_trade_time)}</td>
        <td class="td-dim">${App.fmtExpiry(r.expires_at)}</td>
      </tr>`;
    }).join('');

    if (totalSorted > pageSorted.length) {
      tbody.innerHTML += `<tr id="whSignalsMoreRow"><td colspan="11" style="text-align:center;padding:12px">
        <button id="whSignalsMoreBtn" class="b" style="cursor:pointer;padding:6px 14px;font-size:11px;font-weight:600">
          ${App.t ? App.t('whales.show_more', {shown: pageSorted.length, total: totalSorted}) : `Показати ще (${pageSorted.length} з ${totalSorted})`}
        </button>
      </td></tr>`;
      const btn = $('whSignalsMoreBtn');
      if (btn) btn.addEventListener('click', () => {
        _signalsShown += PAGE_SIZE;
        renderSignals();
      });
    }
  }

  // ─── Summary helpers ───────────────────────────
  function _updateSummaryCards(wallets, intents) {
    const avgTrust = wallets.length
      ? wallets.reduce((s, w) => s + (Number(w.trust_score) || 50), 0) / wallets.length
      : 0;
    const active = wallets.filter(w => !w.trust_disabled).length;
    const pruned = wallets.filter(w => w.trust_disabled).length;
    const catSet = new Set();
    wallets.forEach(w => {
      (Array.isArray(w.categories) ? w.categories : (w.category ? [w.category] : []))
        .forEach(c => catSet.add(typeof c === 'object' ? c.name : c));
    });
    const confirms = intents.filter(r => r.level === 'CONFIRM').length;
    const convictions = intents.filter(r => r.level === 'CONVICTION').length;
    const signalCount = confirms + convictions;

    const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    set('walletTotal', wallets.length);
    set('walletAvgTrust', avgTrust.toFixed(0));
    set('walletActive', active);
    set('walletPruned', pruned);
    set('whaleSignalCount', signalCount);
    set('walletTypes', catSet.size);
    set('walCount', wallets.length);
    set('wh-signal-badge', signalCount);
  }

  function _updateSignalSummary(records) {
    const probes = records.filter(r => r.level === 'PROBE').length;
    const confirms = records.filter(r => r.level === 'CONFIRM').length;
    const convictions = records.filter(r => r.level === 'CONVICTION').length;
    const totalUsd = records.reduce((s, r) => s + (r.total_invested || 0), 0);

    const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    set('intentProbes', probes);
    set('intentConfirms', confirms);
    set('intentConvictions', convictions);
    const trackedEl = $('intentTracked');
    if (trackedEl) trackedEl.textContent = App.fmt$(totalUsd) + ' tracked';

    // Also try fetching stats from API
    App.fetchJSON('/api/polymarket/intents/stats').then(stats => {
      set('intentProbes', stats.probes ?? probes);
      set('intentConfirms', stats.confirms ?? confirms);
      set('intentConvictions', stats.convictions ?? convictions);
      if (trackedEl) trackedEl.textContent = App.fmt$(stats.total_usd ?? totalUsd) + ' tracked';
    }).catch(() => {});
  }

  // ─── Reset wallet (preserved from wallets.js) ──
  async function resetWallet(address) {
    if (!confirm(App.t('whales.reset_confirm'))) return;
    try {
      const r = await fetch('/api/polymarket/wallets/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); App.toast(e.error || App.t('whales.reset_err'), 'err'); return; }
      App.toast(App.t('whales.reset_ok'), 'ok');
      renderWallets();
    } catch (e) { App.toast(App.t('whales.err', {error: e.message}), 'err'); }
  }

  // ─── Expose ─────────────────────────────────────
  App.renderWhales = function () {
    if (S.whalesMode === 'signals') renderSignals();
    else renderWallets();
  };

  App.clearLeaderboardCache = function () { S.lbData = []; };

  // Expose to global for onclick handlers
  window.switchWhalesMode = switchWhalesMode;
  window.setWhaleSort = setWhaleSort;
  window.setSignalSort = setSignalSort;
  window.setWhaleTypeFilter = setWhaleTypeFilter;
  window.setWhaleDomainFilter = setWhaleDomainFilter;
  window.setWhaleSearch = setWhaleSearch;
  window.toggleDisco = toggleDisco;
  window.resetWallet = resetWallet;

})(window.App);
