/* Ora et Labora — tooltip + init */

// ── Global tooltip (runs immediately) ────────────────────────────────────────
(function () {
  const tip = document.createElement('div');
  tip.className = 'g-tip';
  document.body.appendChild(tip);
  let _raf = null;

  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.classList.remove('vis'); return; }
    tip.textContent = el.getAttribute('data-tip');
    tip.classList.add('vis');
  });
  document.addEventListener('mouseout', e => {
    if (!e.target.closest('[data-tip]')) return;
    tip.classList.remove('vis');
  });
  document.addEventListener('mousemove', e => {
    if (!tip.classList.contains('vis')) return;
    if (_raf) cancelAnimationFrame(_raf);
    _raf = requestAnimationFrame(() => {
      let x = e.clientX + 14, y = e.clientY + 16;
      if (x + tip.offsetWidth  > window.innerWidth  - 8) x = e.clientX - tip.offsetWidth  - 10;
      if (y + tip.offsetHeight > window.innerHeight - 8) y = e.clientY - tip.offsetHeight - 10;
      tip.style.left = x + 'px';
      tip.style.top  = y + 'px';
    });
  });
})();

// ── App init ─────────────────────────────────────────────────────────────────
(function (App) {
  'use strict';

  const S = App.state;

  async function init() {
    App.wireAll();
    // Load i18n locale before rendering
    await App.loadLocale();
    App.applyI18n();
    // Update flag toggle to reflect current locale
    var flagEl = document.querySelector('#langToggle .lang-flag');
    if (flagEl) flagEl.textContent = App.locale === 'ua' ? '\u{1F1FA}\u{1F1E6}' : '\u{1F1EC}\u{1F1E7}';
    // Fetch mode BEFORE loading data so currentMode is correct
    try {
      const mode = await App.fetchJSON('/api/polymarket/trading-mode');
      S.currentMode = mode.mode || 'dry_run';
    } catch (e) { /* keep default dry_run */ }
    App.loadAll();
    // F12: Always start the 5s polling loop. SSE is a *fast overlay*
    // for portfolio+positions only — it doesn't carry filter pipeline
    // data, reject_counts, recent_rejections, profiles, etc. Without
    // polling those panels would freeze until a hard reload (the bug
    // we shipped in B2). Polling is cheap and idempotent; SSE just
    // makes positions/portfolio feel snappier on top of it.
    App.startAutoRefresh();
    if (typeof App.connectSSE === 'function') {
      App.connectSSE();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window.App);
