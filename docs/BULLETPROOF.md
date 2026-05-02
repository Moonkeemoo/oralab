# Bulletproof LIVE checklist

> The whole reason we're rebuilding from scratch is so LIVE BUY/SELL
> doesn't have problems. Every defect that touches BUY or SELL flow is a
> higher priority than any other class of work.
>
> Source: Taras 2026-05-02 after the race-condition double-buy incident.

## Current bulletproof guarantees (commit `9266d95+`)

### Entry side

| Guarantee | How |
|---|---|
| At most one in-flight entry per (user, strategy) | `src/feed/entry_mutex.ts` `serializedEntry` wraps full routeInner |
| `max_open_positions` re-checked AFTER previous INSERT | filter pipeline runs inside the mutex; subsequent calls see updated DB |
| Whale's stale price never used for actual order | `liveAskWithSlippage` reads /book at decision time + slippage tolerance |
| Signal age > 90s pre-gamma cheap reject | `signal_router` early-out via `SIGNAL_STALE_AGE_SEC` |
| Stale signal also caught downstream | `stale_trade` filter in pipeline (300s default per filter) |
| pUSD < usdAmount → reject before CLOB | `placeBuy` calls `getBalanceAllowance(COLLATERAL)` pre-flight |
| FOK BUY didn't fill → fail fast | empty `makingAmount`/`takingAmount` + `transactionsHashes` = `fok_unfilled` reject |
| `delayed`-with-empty FOK BUY disambiguated before kill | `placeBuy` polls `getOrder(size_matched)` + chain-balance delta vs baseline; settled trades route to success_delayed instead of orphaned chain position |
| Position INSERT only on confirmed fill (LIVE) | `signal_router` checks `takingAmount > 0` after `placeBuy` success |
| Partial fill records actual filled shares | `position.shares = Number(buy.takingAmount)` exactly |
| Audit signal row matches final outcome | `persistSignal` called once at end with terminal `accepted`/`rejectReason` |
| Every CLOB order placement attempt audited | `recordOrder` called regardless of success |

### Exit side

| Guarantee | How |
|---|---|
| KILL_SWITCH NEVER blocks placeSell | `placeSell` removed kill-switch check; KILL halts new BUYs only |
| INV-M1 chain-balance cap on SELL | `placeSell` calls `getBalanceAllowance(CONDITIONAL)`, caps `effectiveSize` |
| `sell_fok` is real FOK market order | `placeSell` branches `createAndPostMarketOrder` (FOK/FAK) vs `createAndPostOrder` (GTD/GTC) |
| FOK SELL didn't fill → fail fast | same delayed-with-no-fill detection as BUY |
| `delayed`-with-empty FOK SELL disambiguated before kill | `placeSell` polls `getOrder(size_matched)` + chain shares decrease vs pre-order baseline; settled SELLs return success_delayed |
| QA-174 cancel-before-place on sweep | `cancelOpenOrdersForAsset(assetId, "SELL")` before placing on `sweepCount > 0` |
| INV-M5 no double-act on EXITING | guard at top of `executeExitIntent` |
| Exit only via chain SELL fill OR resolved | `decide_exit` never returns close action; `closure_reason` written by `DbFillHandler` on confirmed fill (INV-M3) |

### Reconciliation

| Guarantee | How |
|---|---|
| 30s grace for PENDING/FILLED, 60s for EXITING | `reconcileAgainstChain` |
| Drift `<0.5%` ok / `<5%` sync DB / `<10%` freeze WARN / `≥10%` freeze P0 | drift bands in reconciler |
| Recovery from FROZEN is human-only | architecture §08; Mini App "Resume" button in P2c |

### Observability

| Metric | Purpose |
|---|---|
| `whale_to_buy_latency_ms` | end-to-end RTDS → CLOB accept |
| `decide_exit_duration_ms` | pure function performance regression |
| `position_monitor_tick_ms` | 2 Hz tick budget (target ≤200ms) |
| `order_placement_duration_ms` | per-op CLOB roundtrip |
| `order_placement_outcome_total` | success / kill_switch / rejected / fok_unfilled |
| `reconciliation_drift_pct` | per-tick drift distribution |
| `entry_mutex_wait_ms` | queue depth proxy under firehose |
| `entry_route_outcome_total` | accept-rate + dominant reject reason |

## What's NOT yet bulletproof (track here)

- [ ] Tests for FOK kill detection in `placeBuy` / `placeSell` (need ClobClient mock)
- [ ] Tests for `cancelOpenOrdersForAsset` (need ClobClient mock)
- [x] Reconciler chain-vs-orders cross-check on startup (commit `<latest>` — `runStartupCrosscheck` cancels ghost orders + warns on orphan chain shares / stale DB positions)
- [x] WS feed reconnect storm protection (commit `<63424be+>` — min backoff 5s, max 60s, stable-reset 60s, /activity backfill cooldown 5min)
- [x] FillReconciler missed-fill recovery via /activity scan on reconnect (commit cf62fee + `<63424be+>` for actual onConnect wiring)
- [ ] `ExitExecutor` redeem path for resolved markets (P3+)
- [x] Tests for FOK kill detection in `placeBuy` / `placeSell` (commit `d153e11` — 13 mocked LIVE tests)
- [x] Tests for `cancelOpenOrdersForAsset` (commit `d153e11` — 3 cases incl. partial failure + alt response shape)
- [x] decide_exit 100% coverage + property tests + replay (commit `962fae0` — 52 tests across coverage/property/scenario/replay)
- [x] PositionMonitor advances `peakPrice` on each tick (trail-arm prerequisite)
- [x] FillReconciler WS receives + handles real OrderFilled events (commit `63424be` — type:"user" lowercase, event_type:"trade", CONFIRMED triggers transition)
- [x] `placeSell` dust floor — reject sub-tickSize SELLs that round to makerAmount=0/takerAmount=0 (env `SELL_DUST_FLOOR_SHARES`, default 0.1)
- [x] `exit-all-positions.ts` flips matching DB positions to EXITING pre-flight, so reconciler closes via `sell_filled_chain_lag` instead of `chain_invisible` FROZEN

## NOT yet LIVE-verified (work fine in unit tests / DRY)

These code paths are written and unit-covered but have not run a real
order through CLOB end-to-end. Each is a candidate for the next LIVE
exercise window:

- [x] `decide_exit` SL/TP/trail → `executor.executeExitIntent` → `placeSell GTD`
  Verified LIVE 2026-05-02 (test-2 + extended): pos 8 TP @+0.8% sell_bid_probe,
  pos 9/10/12/13 SL @-7% sell_bid_probe→sell_bid_aggr; one GTD per asset matched
  on chain at bid+1tick.
- [x] `FillReconciler.onFill` against a real OrderFilled WS event from CLOB.
  Verified 2026-05-02: pos 12 BUY+SELL closed via WS handler (`chain_sell_filled`
  close_reason, `fills` table populated). All three trade status messages
  (MATCHED → MINED → CONFIRMED) received and dispatched; only CONFIRMED triggers
  the position status transition (INV-M3).
- [x] Trail giveback fire end-to-end. Covered via 7-step synthetic
  scenario in `tests/decide-trail-and-emergency.spec.ts` plus property
  tests asserting trail fires only when `peakPrice * (1 - trailStop) <= mark`.
  Real LIVE verification deferred until natural conditions arise.
- [x] SL emergency `sell_fok` real FOK market order at outcome floor.
  Covered via sweep-escalation scenarios (0 → 1 → 2 → FOK at floor) in
  `tests/decide-trail-and-emergency.spec.ts`. Real LIVE verification
  deferred until natural conditions arise (illiquid book + 2 standard
  SL fails); the FOK branch in placeSell is independently covered LIVE
  via the manual exit-all path.

## Verified LIVE 2026-05-02

| Path | Status |
|---|---|
| RTDS WS → routeWhaleBuy | ✅ 5 BUYs in 8s (race condition surfaced) |
| Strategy filter pipeline | ✅ sport_only worked; price_too_high cut |
| placeBuy LIVE FOK | ✅ accepted by CLOB; one matched, one delayed → kill detected |
| Reconciler PENDING→FROZEN | ✅ orphan caught on chain_invisible |
| Manual exit SELL FOK at minPrice = bid×0.9 | ✅ partial fill (3.105/5.76) |
| Manual exit SELL FAK at minPrice = bid×0.8 | ✅ remainder filled |
| pUSD net effect on $15.94 deployed | -$0.19 (-1.2%) — ~$0.48 in fees+slippage |
| placeBuy delayed-fill disambiguation | ✅ pos 8/12/13 BUY `via:order_poll, filled:N`; without fix would have orphaned chain positions |
| TP gate via decide_exit → executor → placeSell GTD | ✅ pos 8 TP +0.8% → sell_bid_probe → GTD matched @ 0.61 |
| SL standard via decide_exit → executor escalation | ✅ pos 9/10/12/13: sweep=0 sell_bid_probe → sweep≥1 sell_bid_aggr; GTD filled |
| Sweep cooldown 5s (prevents CLOB hammering) | ✅ logs show `sweep_cooldown 527ms<5000ms`…`4914ms` then next sweep |
| GTD 120s expiration (no CLOB rejection bombing) | ✅ 0 invalid-expiration errors post-fix (14 were pre-fix) |
| INV-M1 cap with 1e6 unit fix | ✅ chain dust 0.003 shares correctly blocks SELL via dust_below_floor |
| FillReconciler WS handler (real OrderFilled) | ✅ pos 12 closed via `chain_sell_filled` close_reason, `fills` row inserted |
| WS reconnect-storm protection | ✅ min backoff 5s, max 60s, stable-reset only after 60s held, /activity cooldown 5min |
| pUSD net across all test cycles (pos 8-13) | ~+$2.68 ($103.41 → $106.09); positives outweighed losses despite tight SL |

## Triggers to add to this list

When ANY of these happen during LIVE operation, add the matching bulletproof item:

- An order that should have failed didn't fail (false success)
- A position that should have closed stayed open (stuck SELL)
- More positions opened than configured cap (race condition)
- KILL halted SELL when it should have been allowed
- Reconciler drift not detected fast enough
- WS feed silently dropped connection without reconnect
