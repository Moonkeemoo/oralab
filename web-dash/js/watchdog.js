(function (App) {
  'use strict';

  const POLL_MS = 3000;
  let lastStatus = null;
  let busy = false;

  function secret() {
    // DASHBOARD_SECRET convention: if present in localStorage, append to POSTs.
    try { return localStorage.getItem('dashboard_secret') || ''; } catch (_) { return ''; }
  }

  async function startDaemon() {
    if (busy) return;
    busy = true;
    try {
      const s = secret();
      const url = '/api/watchdog/start' + (s ? `?secret=${encodeURIComponent(s)}` : '');
      const r = await fetch(url, { method: 'POST' });
      const data = await r.json();
      if (data.ok && window.App && App.toast) App.toast(`Watchdog запущено (PID ${data.pid})`);
      else if (window.App && App.toast) App.toast(`Не вдалось запустити: ${data.error || data.output || 'error'}`, 'error');
    } catch (e) {
      if (window.App && App.toast) App.toast(`start error: ${e.message}`, 'error');
    } finally {
      busy = false;
      tick();
    }
  }

  async function stopDaemon() {
    if (busy) return;
    if (!confirm('Зупинити watchdog daemon?')) return;
    busy = true;
    try {
      const s = secret();
      const url = '/api/watchdog/stop' + (s ? `?secret=${encodeURIComponent(s)}` : '');
      const r = await fetch(url, { method: 'POST' });
      const data = await r.json();
      if (data.ok && window.App && App.toast) App.toast('Watchdog зупинено');
      else if (window.App && App.toast) App.toast(`Не вдалось зупинити: ${data.error || data.output || 'error'}`, 'error');
    } catch (e) {
      if (window.App && App.toast) App.toast(`stop error: ${e.message}`, 'error');
    } finally {
      busy = false;
      tick();
    }
  }

  function onPillClick() {
    if (!lastStatus) return;
    if (lastStatus.running) stopDaemon();
    else startDaemon();
  }

  function fmtAge(s) {
    if (s == null) return '—';
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${(s / 3600).toFixed(1)}h`;
  }

  function render(data) {
    const pill = document.getElementById('wdPill');
    const dot = document.getElementById('wdDot');
    const txt = document.getElementById('wdText');
    if (!pill || !dot || !txt) return;

    lastStatus = data;
    pill.classList.remove('wd-ok', 'wd-stale', 'wd-dead', 'wd-alert', 'wd-p0');

    if (!data || data.status === 'error') {
      pill.classList.add('wd-dead');
      txt.textContent = 'WD ?';
      pill.title = 'Watchdog — status endpoint error';
      return;
    }

    const { status, running, last_tick_age_s, recent_alert_count, recent_alerts } = data;

    let cls = 'wd-ok';
    let label = `WD ✓ ${fmtAge(last_tick_age_s)}`;
    let tip = `Watchdog daemon\nPID: ${data.pid ?? '—'}\nLast tick: ${fmtAge(last_tick_age_s)}`;

    if (status === 'dead' || !running) {
      cls = 'wd-dead';
      label = 'WD ✕';
      tip = 'Watchdog daemon is not running.\nClick to start.';
    } else if (status === 'stale') {
      cls = 'wd-stale';
      label = `WD ⚠ ${fmtAge(last_tick_age_s)}`;
      tip = `Watchdog daemon alive but log is stale (${fmtAge(last_tick_age_s)}).`;
    } else if (status === 'alert_p0') {
      cls = 'wd-p0';
      label = `WD 🔴 ${recent_alert_count}`;
      tip = `P0 alerts in last 5 min:\n` + (recent_alerts || [])
        .filter(a => a.severity === 'P0')
        .slice(-5)
        .map(a => `• ${a.rule} ${a.target} — ${a.message}`)
        .join('\n');
    } else if (status === 'alert') {
      cls = 'wd-alert';
      label = `WD · ${recent_alert_count}`;
      tip = `Alerts in last 5 min:\n` + (recent_alerts || [])
        .slice(-5)
        .map(a => `• ${a.severity} ${a.rule} — ${a.message}`)
        .join('\n');
    }

    pill.classList.add(cls);
    txt.textContent = label;
    pill.title = tip;
  }

  async function tick() {
    try {
      const r = await fetch('/api/watchdog/status', { cache: 'no-store' });
      const data = await r.json();
      render(data);
    } catch (e) {
      render(null);
    }
  }

  function start() {
    const pill = document.getElementById('wdPill');
    if (pill) pill.addEventListener('click', onPillClick);
    tick();
    setInterval(tick, POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window.App = window.App || {});
