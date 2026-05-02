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
- [ ] Reconciler chain-vs-orders cross-check on startup (catch ghost open orders we forgot)
- [ ] WS feed reconnect storm protection (limit reconnect rate to 1/min)
- [x] FillReconciler missed-fill recovery via /activity scan on reconnect (commit cf62fee)
- [ ] `ExitExecutor` redeem path for resolved markets (P3+)
- [x] PositionMonitor advances `peakPrice` on each tick (trail-arm prerequisite)

## NOT yet LIVE-verified (work fine in unit tests / DRY)

These code paths are written and unit-covered but have not run a real
order through CLOB end-to-end. Each is a candidate for the next LIVE
exercise window:

- [ ] `decide_exit` SL/TP/trail → `executor.executeExitIntent` → `placeSell GTD`
  (manual exit-all uses placeSell FAK — different SDK call). Risk: signing
  / auth / order shape difference between createAndPostMarketOrder and
  createAndPostOrder.
- [ ] `FillReconciler.onFill` against a real OrderFilled WS event from CLOB.
  Earlier LIVE runs we exited via direct script, so DbFillHandler.onFill
  was not exercised by real WS data — only the activity backfill path.
- [ ] Trail giveback fire end-to-end. Now that `peakPrice` advances, this
  is reachable. Needs a position that runs +15% above fillPrice then
  drops 5%.
- [ ] SL emergency `sell_fok` real FOK market order at outcome floor.
  Code path corrected from GTC → FOK but not LIVE.

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

## Triggers to add to this list

When ANY of these happen during LIVE operation, add the matching bulletproof item:

- An order that should have failed didn't fail (false success)
- A position that should have closed stayed open (stuck SELL)
- More positions opened than configured cap (race condition)
- KILL halted SELL when it should have been allowed
- Reconciler drift not detected fast enough
- WS feed silently dropped connection without reconnect
