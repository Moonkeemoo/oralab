/* Ora et Labora — PnL sparkline chart */

(function (App) {
  'use strict';

  const $ = App.$;
  const S = App.state;

  function buildPnlSeries(trades, periodHours) {
    const cutoff = periodHours ? Date.now() / 1000 - periodHours * 3600 : 0;
    const filtered = (trades || [])
      .filter(t => {
        const pnl = t.pnl ?? t.pnl_amount;
        const ts = t.close_ts ?? t.resolved_at ?? t.close_time ?? t.timestamp;
        return pnl != null && (!periodHours || ts > cutoff);
      })
      .sort((a, b) => {
        const ta = a.close_ts ?? a.resolved_at ?? a.close_time ?? a.timestamp ?? 0;
        const tb = b.close_ts ?? b.resolved_at ?? b.close_time ?? b.timestamp ?? 0;
        return ta - tb;
      });
    let cum = 0;
    const series = [0];
    filtered.forEach(t => { cum += t.pnl ?? t.pnl_amount ?? 0; series.push(cum); });
    return series;
  }

  function drawChart(data) {
    const canvas = $('pnlChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth || 300;
    const H = canvas.offsetHeight || 26;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.scale(dpr, dpr);

    if (!data || data.length < 2) {
      ctx.clearRect(0, 0, W, H);
      return;
    }

    const last = data[data.length - 1];
    const isPos = last >= 0;
    const lineColor = isPos ? '#22c55e' : '#f43f5e';
    const fillColor = isPos ? 'rgba(34,197,94,0.1)' : 'rgba(244,63,94,0.08)';

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const pad = 4;

    const pts = data.map((v, i) => ({
      x: pad + i * (W - pad * 2) / (data.length - 1),
      y: pad + (1 - (v - min) / range) * (H - pad * 2),
    }));

    ctx.clearRect(0, 0, W, H);

    // fill
    ctx.beginPath();
    ctx.moveTo(pts[0].x, H);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, H);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    // line
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // last dot
    const lp = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(lp.x, lp.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();

    // PnL value is written ONLY by renderPortfolio() from server-authoritative
    // S.portfolio.pnl — do NOT write here. drawChart() only draws the sparkline.
  }

  App.setPrd = function (btn, key) {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.period = key;
    App.redrawChart();
  };
  window.setPrd = App.setPrd;

  App.redrawChart = function () {
    const canvas = $('pnlChart');
    const pnlValEl = $('pnlVal');
    const trades = (S.history && S.history.trades) ? S.history.trades : [];

    // Use liq-based unrealized PnL for chart (actual exit value, not flattering midpoint)
    const unrealizedPnl = (S.positions || []).reduce((sum, p) => sum + (p.unrealized_pnl_liquidation ?? p.unrealized_pnl ?? 0), 0);
    const hasData = trades.length > 0 || Math.abs(unrealizedPnl) > 0.001;

    if (!hasData) {
      if (pnlValEl) { pnlValEl.textContent = '—'; pnlValEl.className = 'ds-num'; }
      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const W = canvas.offsetWidth || 260;
        const H0 = canvas.offsetHeight || 26;
        canvas.width = W * dpr; canvas.height = H0 * dpr;
        canvas.style.width = W + 'px'; canvas.style.height = H0 + 'px';
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = `${9 * dpr}px -apple-system, sans-serif`;
        ctx.fillStyle = 'rgba(148,163,184,0.35)';
        ctx.textAlign = 'center';
        ctx.fillText('No data', canvas.width / 2, canvas.height / 2 + 3 * dpr);
      }
      return;
    }

    const periodMap = { 'ALL': null, '1M': 720, '1W': 168, '1D': 24 };
    const hours = periodMap[S.period] ?? null;
    const series = buildPnlSeries(trades, hours);

    if (Math.abs(unrealizedPnl) > 0.001) {
      const lastRealized = series[series.length - 1] ?? 0;
      series.push(lastRealized + unrealizedPnl);
    }

    // PnL value is written by renderPortfolio() from server-authoritative
    // S.portfolio.pnl — do NOT overwrite here (causes flicker between
    // client-computed and server-computed values). Chart only draws the line.
    drawChart(series);
  };

  window.addEventListener('resize', () => { App.redrawChart(); });

})(window.App);
