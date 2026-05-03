# Calibrator v2 Port — Design Spec (from v1 audit)

**Status**: Draft, post-deep-audit of v1 source + visual walkthrough at localhost:4312.
**Source-of-truth in v1**: `~/Documents/GitHub/ora-et-labora/calibrator/`
**Target in v2**: `src/calibrator/` (MVP daemon already exists from #50, extend toward v1 parity).

## v1 architecture (5 layers)

```
Layer 0 — trace.py        cal_XXXX trace ID per cycle, JSONL audit
Layer 1 — thermostat      KPI aggregator (entry side): win_rate, profit_factor, avg_pnl, pass_rate
Layer 1 — exit_thermostat KPI aggregator (exit side): sl_rate, tp_hit_rate, exit_efficiency, left_on_table
Layer 2 — counterfactual  Tracks rejected signals → resolves outcome → per-filter saved$/lost$
Layer 3 — multi_kpi       compute_deficits + compute_weights + compute_entry_lift + compute_exit_lift + score
Layer 5 — bayesian        Beta(α,β) per-filter confidence, multiplies lift in score
Layer 6 — engine          Orchestrator: runs all layers per cycle, emits Recommendation list
```

Numbers reflect v1's CLAUDE.md taxonomy. Layer 4 was the old direction-gate; replaced by Layer 3 self-gate (weights → 0 when no deficit).

---

## Layer 1 — KPI specs (KPI_SPEC, source of truth)

| KPI               | Bucket | Kind          | Ideal | Worst | Scale | Notes |
|-------------------|--------|---------------|-------|-------|-------|-------|
| `win_rate`        | entry  | higher_better | 0.62  | 0.40  | 0.10  | wins / closed |
| `profit_factor`   | entry  | higher_better | 2.0   | 0.5   | 0.50  | grossWin / grossLoss |
| `avg_pnl`         | entry  | higher_better | 0.35  | -0.45 | 0.20  | mean per closed trade |
| `pass_rate`       | entry  | **band**      | min 0.03 / max 0.08 |  | 0.03 | both too-low and too-high penalize |
| `sl_rate`         | exit   | lower_better  | 0.15  | 0.60  | 0.10  | sl_emergency + sl_aggressive + sl_fok |
| `tp_hit_rate`     | exit   | higher_better | 0.35  | 0.05  | 0.10  | tp_fok |
| `exit_efficiency` | exit   | higher_better | 0.75  | 0.30  | 0.15  | realized_gain / peak_gain (non-SL only) |
| `left_on_table`   | exit   | lower_better  | 0.15  | 0.70  | 0.15  | 1 - efficiency |

**Deficit math** (`compute_deficits`):
- `higher_better`: `(ideal - value) / (ideal - worst)`, clamped [0, 1]
- `lower_better`: `(value - ideal) / (worst - ideal)`, clamped [0, 1]
- `band`: 0 inside [min, max]; otherwise `(min-value)/min` or `(value-max)/max`

When all KPIs are at target → deficits = 0 → weights = 0 → no recommendations. This is the implicit "hold" gate.

---

## Layer 3 — Multi-KPI scoring

```
weight[K] = importance[K] × deficit[K] / Σ(importance × deficit)
score[L]  = Σ_K (weight[K] × lift_norm[L][K]) × confidence[L]
applied   = score[L] ≥ MIN_LIFT_THRESHOLD     # default 0.08
```

`lift_norm[K] = lift[K] / scale[K]`, sign-flipped for lower_better, clamped [-1, 1].
`lift[K]` is hard-bounded `±0.15` to prevent runaway extrapolation.

### Importance defaults (from v1 settings)
```
WIN_RATE=3, PROFIT_FACTOR=3, AVG_PNL=2, PASS_RATE=1,
SL_RATE=2, TP_HIT_RATE=1.5, EXIT_EFFICIENCY=1, LEFT_ON_TABLE=1
```

---

## Layer 3 — Entry lift (compute_entry_lift)

For each `lever L` in allowlist:
```
step_fraction = max_step × confidence[reject_key]   # max_step=0.15 default
```
**Thick data** (`data_points >= 5`):
```
new_winners = step_fraction × winners_blocked          # from counterfactual
new_losers  = step_fraction × losers_blocked
denom       = n_passed + new_winners + new_losers
lift[win_rate]      = (winners + new_winners) / denom - current_wr
lift[avg_pnl]       = (sum_pnl + new_winners*aw - new_losers*al) / denom - current_avg
lift[profit_factor] = (gp + new_winners*aw) / (gl + new_losers*al) - current_pf
lift[pass_rate]     = (new_winners + new_losers) / total_signals
```
**Thin data** (`< 5`): fall back to net$-proxy: `lift[avg_pnl] ≈ net × step_fraction / n_passed`, `lift[pass_rate] ≈ reject_count × step_fraction / total_signals`.

**Direction**: `relax` if `lift[avg_pnl] >= 0`, else `tighten` (all lifts sign-flipped).

**Param delta**: For min-type config (`FILTER_TRUST_MIN`, `SM_SCORE_MIN_GATE`, etc.), `relax = decrease threshold`; for max-type, `relax = increase`.

**Allowlist** (v1 _ENTRY_ATTRIBUTION_ALLOWLIST):
```
trust_gate, sm_score, market_volume, price_impact, slippage,
price_collapsed, remaining_edge, time_horizon_too_close,
time_horizon_too_far, exit_reentry_cooldown, entry_cooldown,
conviction_gate:probe, conviction_gate:confirm
```

---

## Layer 3 — Exit lift (compute_exit_lift)

5 exit knobs each with widen + narrow direction:
```
EXIT_TAKE_PROFIT          (Take Profit)
EXIT_STOP_LOSS            (Stop Loss)
EXIT_STOP_LOSS_EMERGENCY  (Emergency Stop)
EXIT_TRAIL_ACTIVATE       (Trail Activate)
EXIT_TRAIL_STOP           (Trail Stop)
```

**Each direction emits a separate LeverLift entry** (key = `f"{config_key}:{direction}"`).

**Widen SL math** (`_sl_widen_delta`): SL trades whose `peak >= current_tp` would have hit TP if SL were wider. NOT generic peak>0 — that bug let v1 widen SL 5x in row chasing phantom conversions (QA-127).

**Widen TP**: TP trades with `peak < new_tp` would no longer hit TP → TP rate down, LOT up.

**Narrow SL/TP**: opposite direction, more conservative.

---

## Layer 2 — Counterfactual ($ attribution)

For each rejected signal:
1. Record `(condition_id, reject_key, asset_id, whale_price, ts)` to `cf_pending` table.
2. After CF_TRACKING_WINDOW (6h default), poll: did the market resolve? Did price move?
3. Compute `would_pnl = (resolved_price - whale_price) × hypothetical_size`.
4. Update `FilterAttribution`:
   - `saved` += `|would_pnl|` if loss (correct rejection)
   - `lost`  += `|would_pnl|` if profit (incorrect rejection)
   - `winners_blocked` / `losers_blocked` counters
   - `avg_winner_pnl` / `avg_loser_pnl` rolling means

**Per-key fairness**: cap pending at `max(30, CF_MAX_PENDING/6)` per filter so loud filters don't starve quiet ones.

**Conviction gate split**: track `conviction_gate:probe` vs `conviction_gate:confirm` separately (different thresholds).

---

## Layer 5 — Bayesian confidence

Beta(α, β) per filter:
- `α += 1` when filter made correct call (correct reject = saved$, correct pass = winner)
- `β += 1` when filter made wrong call
- `confidence = α / (α + β)` ∈ [0.5 prior, 1.0]
- `data_points = α + β - 2` (subtract uninformative prior Beta(1,1))

**Status tiers** (from v1 settings):
- `stable`     if `confidence ≥ 0.7 AND data_points ≥ 10`
- `exploring`  if `confidence ≥ 0.5`
- `uncertain`  otherwise

**Auto-apply gate**: `BAYES_AUTO_MIN_CONF = 0.7` (only stable filters auto-apply).

---

## Layer 6 — Engine orchestration

Per cycle:
```
trace_id = new_trace_id()
1. kpi      = thermostat.compute()
2. exit_kpi = exit_thermostat.compute()
3. counterfactual.record_rejections() + counterfactual.resolve_pending()
4. attribution = counterfactual.compute_attribution()
5. beliefs   = bayesian.compute_all(reject_map, human_names)
6. deficits  = multi_kpi.compute_deficits(kpi, exit_kpi)
7. weights   = multi_kpi.compute_weights(deficits, importance)
8. entry_lift = multi_kpi.compute_entry_lift(attribution, trades, config, beliefs, max_step, total_signals)
9. exit_lift  = multi_kpi.compute_exit_lift(trades, exit_config, max_step)
10. levers   = entry_lift + exit_lift, ranked by score = Σ(w[K]×lift_norm[L][K]) × confidence[L]
11. recommendations = [L for L in levers if score[L] >= MIN_LIFT_THRESHOLD][:CAL_MAX_RECS]
12. mode == 'auto' → apply each rec via setRuntimeConfig + audit_log
    mode == 'watch' → emit only, no apply
    mode == 'manual' → skip cycle entirely
13. log_trace(cycle_complete, {weights, deficits, lift_matrix, recommendations})
```

**Modes**:
- `manual` — engine doesn't run (operator-driven)
- `watch`  — runs, emits, never applies (monitoring)
- `auto`   — runs and applies recs that pass MIN_LIFT_THRESHOLD AND `confidence ≥ BAYES_AUTO_MIN_CONF`

**Conditions for recommendation** (v1 Огляд checklist):
- ✓ Mode != manual
- ✓ Closed trades ≥ CAL_MIN_TRADES (20 default)
- ✓ Top lever score ≥ MIN_LIFT_THRESHOLD (0.08)
- ✓ Calibrator daemon alive

---

## Layer 0 — Trace

Every cycle gets a `cal_XXXX` ID. JSONL log at `output/calibrator_trace.jsonl` (in v2: `calibrator_trace` table).
Event types: `cycle_start`, `cycle_complete`, `recommendation`, `set_assist`, `apply`, `reject`, `rollback`, `weights`, `lift_matrix`, `deficits`.

---

## Settings (v1 defaults)

```
MIN_LIFT_THRESHOLD       = 0.08        # apply gate
IMPORTANCE_WIN_RATE      = 3
IMPORTANCE_PROFIT_FACTOR = 3
IMPORTANCE_AVG_PNL       = 2
IMPORTANCE_PASS_RATE     = 1
IMPORTANCE_SL_RATE       = 2
IMPORTANCE_TP_HIT_RATE   = 1.5
IMPORTANCE_EXIT_EFFICIENCY = 1
IMPORTANCE_LEFT_ON_TABLE = 1
CF_TRACKING_WINDOW       = 6h          # how long to track rejections
CF_CHECK_INTERVAL        = 5m
CF_MAX_PENDING           = 1000
CAL_RUN_INTERVAL         = 30m
CAL_MIN_TRADES           = 20
CAL_MAX_STEP             = 15%
CAL_MAX_RECS             = 3
DECAY_HALF_LIFE          = 7d          # time decay on trades for KPIs
DECAY_MIN_WEIGHT         = 0.05
BAYES_STABLE_THRESHOLD   = 0.7
BAYES_UNCERTAIN_THRESHOLD = 0.5
BAYES_AUTO_MIN_CONF      = 0.7
SAFETY_WR_DROP_ROLLBACK  = 8pp         # auto-rollback if WR drops
SAFETY_VERIFY_TIMEOUT    = 30s
```

---

## Sport-tag analytics (Спорт sub-tab — first-class)

User explicitly flagged this as critical: "трекає по тегам... який спорт найбільше заробив і коли".
The Sport sub-tab in v1 has TWO views:

### A. Per-sport KPI table

| Sport | Угод | Win | Loss | NET PNL | WR | TP% | SL% | Сер.час | Сер.ставка | Performance bar |
|-------|------|-----|------|---------|------|-----|-----|---------|------------|----------------|
| NHL   | 4    | 3   | 1    | +$1.61  | 75%  | 25% | 0%  | 57m     | $3.76      | green 100%     |
| NBA   | 1    | 1   | 0    | +$0.59  | 100% | 100%| 0%  | 56m     | $3.08      | green 37%      |
| Tennis| 1    | 1   | 0    | +$0.64  | 100% | 100%| 0%  | 31m     | $3.38      | green 48%      |
| Soccer| 6    | 2   | 4    | -$0.02  | 17%  | 17% | 33% | 10m     | $3.72      | red 1%         |
| Other | 7    | 2   | 3    | -$0.47  | 29%  | 14% | 29% | 12m     | $10.33     | red 29%        |
| Esports|10   | 5   | 5    | -$1.29  | 50%  | 30% | 30% | 21m     | $5.15      | red 88%        |

Sortable by NET PNL.

### B. Hour-of-day heatmap

Y-axis: sports rows (NHL/Tennis/NBA/Soccer/Other/Esports/...)
X-axis: 24 hours UTC (00..23)
Cell value: depending on toggle:
- **PNL ($)** — sum(realized_pnl_usd) for that sport × hour bucket. Green/red gradient.
- **WIN RATE (%)**
- **КІЛЬКІСТЬ УГОД** — count of trades

Identifies time-of-day windows where specific sports overperform (e.g. NHL +$1.16 at 02:00 UTC + +$0.35 at 03:00 vs Esports -$3.96 at 09:00).

### Data flow in v2

| Need | Current state | Action |
|------|---------------|--------|
| Sport per market | `gamma market.sportsMarketType` + `isSportsMarket`. Plus `sports_events.league` (mlb/cs2/lol/...) keyed by gameId. | Cache `league` on `positions.league` at INSERT time. Source: `gamma.gameId → sports_events.league`, fallback to deriving from market.slug regex. |
| Tags[] | gamma exposes but we don't store | Optional: store as `positions.tags jsonb` for richer drilldowns later. v1 uses single `league` for table; tags can wait. |
| Sport mapping | Raw league codes vary (`mlb`/`nba`/`nhl`/`cs2`/`lol`/`val`/`ufc`/`mls`/`fr2`/`epl`/etc) | Add `LEAGUE_TO_SPORT` map: `{cs2,lol,val,codmw} → "Esports"`, `{mlb} → "MLB"`, `{nba,wnba} → "NBA"`, `{nhl} → "NHL"`, `{soccer,mls,epl,fr2,bra,arg,j2100,mex} → "Soccer"`, etc. Single source of truth in `src/calibrator/sport_taxonomy.ts`. |

### Schema

```sql
ALTER TABLE positions ADD COLUMN league varchar(32);
ALTER TABLE positions ADD COLUMN sport varchar(32);  -- canonical group
CREATE INDEX idx_positions_sport_lastchange ON positions(sport, last_state_change_ts DESC);
```

`league` set at INSERT time in `signal_router.ts` from gamma metadata (already fetched). `sport` derived via `LEAGUE_TO_SPORT[league]`.

### Aggregation queries

**Per-sport table** (24h window):
```sql
SELECT
  sport,
  count(*) AS trades,
  count(*) FILTER (WHERE realized_pnl_usd > 0) AS wins,
  count(*) FILTER (WHERE realized_pnl_usd < 0) AS losses,
  sum(realized_pnl_usd)::numeric(10,2) AS net_pnl,
  (count(*) FILTER (WHERE realized_pnl_usd > 0)::float / GREATEST(count(*),1))::numeric(4,2) AS win_rate,
  (count(*) FILTER (WHERE close_reason ~* '^tp')::float / GREATEST(count(*),1))::numeric(4,2) AS tp_pct,
  (count(*) FILTER (WHERE close_reason ~* '^sl')::float / GREATEST(count(*),1))::numeric(4,2) AS sl_pct,
  avg((last_state_change_ts - fill_ts) / 1000)::int AS avg_dur_sec,
  avg(entry_cost_usd)::numeric(10,2) AS avg_stake_usd
FROM positions
WHERE status='CLOSED' AND mode = $mode
  AND last_state_change_ts > extract(epoch from now()-interval '24 hours')*1000
  AND sport IS NOT NULL
GROUP BY sport
ORDER BY net_pnl DESC;
```

**Hour-of-day heatmap** (any window):
```sql
SELECT
  sport,
  EXTRACT(hour FROM to_timestamp(fill_ts/1000) AT TIME ZONE 'UTC')::int AS hour_utc,
  count(*) AS trades,
  sum(realized_pnl_usd)::numeric(10,2) AS pnl_usd,
  (count(*) FILTER (WHERE realized_pnl_usd > 0)::float / GREATEST(count(*),1))::numeric(4,2) AS win_rate
FROM positions
WHERE status='CLOSED' AND mode = $mode
  AND last_state_change_ts > extract(epoch from now()-interval '7 days')*1000
  AND sport IS NOT NULL
GROUP BY sport, hour_utc
ORDER BY sport, hour_utc;
```
Returns sparse rows; UI fills 24-cell grid with 0 for missing hours.

### REST endpoints

```
GET /api/calibrator/sport?windowHours=24
  → { sports: [{sport, trades, wins, losses, netPnl, winRate, tpPct, slPct, avgDurSec, avgStakeUsd}, ...] }

GET /api/calibrator/sport/heatmap?days=7&metric={pnl|wr|count}
  → { sports: ["NHL", "Soccer", ...], hours: [0..23], cells: { "NHL_3": 1.16, "Soccer_15": -0.28, ... } }
```

### Use cases (per-sport calibration question from earlier)

Even if v1 never wired per-sport threshold tuning, the analytics enable:
- **Manual decision support**: "Esports lose 88% of stake at 09:00 UTC — pause sport_only filter to allow only NHL/NBA/MLB during 02:00–10:00."
- **Future enhancement**: per-sport multipliers on conviction threshold (`conviction_gate.params.sportMultiplier.NHL = 0.8`).
- **Sanity gate**: if any sport's WR drops below 30% over rolling 50 trades → auto-disable that sport's signals via runtime_config.

This is part of Phase D (REST) + Phase E (UI sub-tab Спорт). Schema migration goes in Phase A.

---

## v2 Mini App tabs (7 sub-tabs from v1 walkthrough)

| Tab            | Source data                                                |
|----------------|------------------------------------------------------------|
| `Огляд`        | header pills + 3 status cards + KPI bar + checklist + entry/exit history |
| `Entry`        | LIFT MATRIX entry + counterfactual $-attribution + bayesian belief |
| `Exit`         | LIFT MATRIX exit + closure-reason distribution + per-knob analysis (TP/SL/Trail/Time) + current params table |
| `Whales`       | Per-whale PnL + class + trust score + filter chips |
| `Спорт`        | Per-sport KPI table (NHL/NBA/Soccer/Esports) + hour-of-day heatmap |
| `Лог`          | trace events table — every recommendation/apply/rollback |
| `Налаштування` | All settings inline-editable (6 sections matching v1) |

---

## v2 implementation phases

### Phase A — Foundations (schema + thermostat + multi_kpi)
- Schema: `calibrator_trades`, `calibrator_trace`, `calibrator_settings`, `cf_pending`, `cf_attribution`, `filter_beliefs`. (Most can be VIEWs over existing `positions`/`signals`/`decisions`.)
- Port `multi_kpi.ts` with KPI_SPEC, compute_deficits, compute_weights, compute_entry_lift, compute_exit_lift, score (no I/O, fully unit-testable).
- Port `thermostat.ts` + `exit_thermostat.ts` reading from `positions` + `signals` views with time-decay.

### Phase B — Counterfactual & Bayesian
- `counterfactual.ts`: record_rejections (consume rejected signals on insert via trigger or pull every CF_CHECK_INTERVAL), resolve_pending (after CF_TRACKING_WINDOW, look up market resolution via gamma + decisions, compute would_pnl).
- `bayesian.ts`: load/save filter_beliefs, update_from_attribution (Beta conjugate update), compute_all status tiers.

### Phase C — Engine + modes + rollback
- Refactor `engine.ts` to orchestrate all 5 layers with trace_id.
- Add modes (manual/watch/auto) — extends current MVP daemon.
- Apply via `setRuntimeConfig` + `audit_log` rows (never direct strategy_filters write).
- Rollback: SAFETY_WR_DROP_ROLLBACK monitor — if WR drops > 8pp within SAFETY_VERIFY_TIMEOUT after apply, revert via setRuntimeConfig.

### Phase D — REST endpoints
Extend `/api/calibrator/*`:
- GET `/snapshot` (full Огляд payload: deficits, weights, kpi, exit_kpi, checklist)
- GET `/lift_matrix?phase={entry|exit}` (current cycle's matrix)
- GET `/attribution` (Layer 2 saved$/lost$ per filter)
- GET `/beliefs` (Layer 5 confidence per filter)
- GET `/trace?since=...` (event log)
- GET `/sport` (per-sport KPI breakdown)
- POST `/settings` (set IMPORTANCE_*/MIN_LIFT_THRESHOLD/etc)
- POST `/mode` (switch manual/watch/auto)
- POST `/apply/:id` (manual approve a single recommendation)
- POST `/dismiss/:id`, POST `/rollback`

### Phase E — Mini App tab (7 sub-tabs)
- New `web/js/views/calibrator.js` (top-level)
- 7 `web/js/views/calibrator/{overview,entry,exit,whales,sport,log,settings}.js` sub-views
- New nav item between Strategy and Whales in footer (preserve all existing 5 tabs!)

### Phase F — Verification
- Replay v1's calibration_history.json against v2 engine → expect same recommendations within tolerance
- Property tests: deficits ∈ [0,1], weights sum=1 OR all=0, lift bounded ±0.15, score gated by MIN_LIFT_THRESHOLD

---

## Estimated scope

| Phase | Files (new) | LOC est | Tests |
|-------|-------------|---------|-------|
| A | 4-5 | 600 | 30 |
| B | 2 | 400 | 20 |
| C | 1 (refactor) | 250 | 10 |
| D | 1 (extends) | 200 | n/a |
| E | 8 | 700 | n/a |
| F | replay script | 100 | n/a |
| **Total** | | **2250** | **60** |

Realistic shippable: A in one chunk, B in second, C+D third, E split into 3 (overview+settings, entry+exit+log, whales+sport). Plus F at the end.

---

## Open questions for Taras
1. **Auto mode** in v1 — was it ever turned on, or always watch? (Default in v1 settings is `watch`.) Recommend v2 ships with `manual` default and adds `auto` only after F replay shows consistent recs.
2. **WR_DROP rollback timeout 30s** — only triggers if there are enough trades within 30s to compute WR. In low-volume DRY this never fires. Should we extend to N trades instead of N seconds?
3. **Per-sport calibration** — v1 has Sport sub-tab with KPI by sport. Is per-sport tuning ever used (e.g. relax SL only for NHL)? Or just analytics?
