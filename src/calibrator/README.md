# Calibrator (P2c MVP)

Adaptive filter-threshold tuning daemon. Reads recent activity, emits
advisory recommendations, never mutates strategy_filters automatically.

## What it does

On every cycle (default: hourly):

1. Snapshot last-24h `CLOSED` positions → compute `avgPnlPerTrade`.
2. Snapshot last-24h rejected signals grouped by `reject_reason`.
3. For each tunable filter (9 of them — see `TUNABLE_FILTERS` in
   `engine.ts`), compute one `Recommendation`:
   - **relax** when avgPnl > 0 and the filter is rejecting > 100 signals/24h
     (we're missing winners → loosen by 10%).
   - **tighten** when avgPnl < 0 and we have > 5 accepted trades (cut the
     losing tail by 15%).
   - **hold** otherwise.
4. Persist all recs to `calibrator_recommendations` (one row per filter per
   cycle).

The Mini App reads `/api/calibrator/recommendations` and surfaces the top
suggestions. Operator decides whether to apply.

## Run

```bash
# Daemon (default — runs forever, hourly):
npm run dev:calibrator

# One-shot — single cycle, log result, exit:
npm run calibrator:once

# Trigger from API (audit-logged):
curl -X POST -H "X-Dev-Bypass: $DEV_AUTH_TOKEN" http://localhost:8081/api/calibrator/run
```

## Tunable env vars

| Var | Default | What |
|---|---|---|
| `CAL_INTERVAL_MS` | `3600000` (1h) | Daemon cycle interval. Lower for testing. |
| `DATABASE_URL` | (required) | Postgres connection — same as the rest of the bot. |

## MVP limitations (intentional, see TODO list below for v1.1)

- **Single KPI: net pnl per accepted trade.** v1's `multi_kpi.py` weighted
  scoring (win rate, profit factor, drawdown, exit efficiency) deferred.
- **No bayesian confidence updates** — we use a sample-size tier
  (`stable` > 50, `exploring` 11-50, `low_data` <= 10) instead of v1's
  `bayesian.py` posterior estimation.
- **No counterfactual scoring** — lift is a back-of-envelope heuristic
  (avg pnl × relax/tighten factor × my_rejects), not v1's per-signal
  `would_profit` replay.
- **No auto-apply** — recommendations are advisory only. The thermostat-style
  auto-tune from v1 is intentionally not ported until the operator gates
  ship.
- **No exit-side calibration** — v1's exit_thermostat (SL/TP/trail band
  tuning) is deferred. Only entry filters are recommended.

## Wiring

- Schema: `src/db/schema.ts` → `calibratorRecommendations`
- Migration: `src/db/migrations/0007_next_trauma.sql`
- Engine: `src/calibrator/engine.ts` (pure helpers + `runCycle`)
- Daemon: `src/calibrator/main.ts`
- API: `src/api/rest_server.ts` → `/api/calibrator/{status,recommendations,run}`
- Tests: `tests/calibrator/engine.spec.ts`
