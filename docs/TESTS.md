# Critical Test Patterns — Negative Tests for New Project

Top 30 must-not-violate patterns from 4 months of Python bot incidents.
Each is a real prod bug that cost money or caused stuck state. New TS
project must have a failing test for each before any code is written
(red phase TDD).

Pattern numbering follows existing `docs/qa/patterns/qa1XX_*.md` files.

---

## Money-safety (must-block tests)

### QA-180 — Synthesized bid/ask masks dead orderbook
**Pattern:** `_build_snapshot` defaults bid = mark*0.99, ask = mark*1.01 when not provided. Real book has bid=$0.01 ask=$0.99 → spread 196% but synthesized spread shows 2% → INV-D2 spread gate doesn't fire → SL fires on dead book.
**Test:** Given dead orderbook, `decide_exit` must return HOLD with INV-D2 in gates. Real bid/ask must come from `/book`, never synthesized.

### QA-181 — Premature closure_reason orphans position
**Pattern:** V2 wrote `entry.closure_reason = reason` immediately after bridge accepted GTD, before on-chain fill. GTD expired CANCELED, position still on chain, but local DB shows closure_reason → dashboard hides it, exit_eval skips.
**Test:** Closure_reason write only after `/activity` shows our SELL tx, never on bridge accept.

### QA-166 — Dead orderbook GTD loop
**Pattern:** Bot places GTD@mark, mark much higher than real bid → expires, retries with new mark, bleeds slowly. d847559e and 8602f617 incidents.
**Test:** When `bid * 5 < mark`, `decide_exit` produces HOLD or sell_bid_aggr at bid+tick, never sell at mark.

### QA-165 — WS-book mark trust post-fill
**Pattern:** WS book registered cross-spread quote 1s after FOK fill. Bot trusted mark_quality=executable from ws_book → fired emergency SL on phantom price.
**Test:** Post-entry debounce 5s — if `now - fill_ts < 5s` AND `mark_source === "ws_book"`, return HOLD.

### QA-156 — Pre-sell balance threshold too loose
**Pattern:** Bot used 95% threshold for "tracked vs on-chain", let through orders that overshoot real balance.
**Test:** Threshold 99.5%; if tracked_size > on_chain * 1.005, cap to on_chain.

### QA-155 — Non-tick price rejection
**Pattern:** Sell price 0.04567 not aligned to tick 0.001 → rejected.
**Test:** All order prices `Math.floor(price / tickSize + 1e-9) * tickSize` for SELL, ceil for BUY.

### QA-154 — Exact bid post-only rejection
**Pattern:** Post-only SELL at exact bid rejected (would match). Need to undercut by 100-300bps on retry.
**Test:** When sweep_count > 0 OR post_only=true and price ≤ bid+tick, undercut by 1 tick to bid-1tick.

### QA-153 — WS coverage gap blocks SELL retry
**Pattern:** WS feed silent → mark stale → SL retry uses old mark, fires below real bid.
**Test:** mark_age_s > 60 → HOLD. Don't act on stale data.

### QA-149 — Failed BUY phantom in budget
**Pattern:** Failed BUYs (status=failed/cancelled) recorded in trades but never spent on chain. Counted as "open" by R9 budget drift.
**Test:** Budget drift detector excludes status in (failed, error, cancelled).

### QA-160 — Budget release at exit submission
**Pattern:** Budget released when state transitions to "exiting" (sell submitted), not at "closed". Trades in "exiting" with no closure_reason show open in trade_log but spent_usd already excludes them.
**Test:** Reconciler counts (exiting, resolved) as released; only OPEN counts as committed.

---

## State integrity

### QA-144 — Reconciler phantom loss stamp
**Pattern:** Reconciler stamps phantom loss when /activity returns 0 trades for asset. But could be eventual consistency lag, not real phantom.
**Test:** Wait 5 minutes after close before phantom-stamping. Allow grace period for chain indexing.

### QA-141 — Bridge success=false null error
**Pattern:** SDK returned success=false with no errorMsg → downstream sees null:null → all rejections collapse to "status=400".
**Test:** Every non-success response has structured error_code (insufficient_balance, tick_size_mismatch, post_only_rejected, expired, clob_rejected). Never null/null/null.

### QA-138 — Split source-of-truth asymmetric save
**Pattern:** Two writers update same JSON, one had partial state, last-writer-wins lost data.
**Test:** Single writer per file. SQLite transactions for multi-row updates.

### QA-136 — Frozen display fields on state skip
**Pattern:** When status="exiting", mark refresh skipped. Dashboard shows frozen $0.50 forever.
**Test:** Mark refresh runs in EXITING too, just doesn't trigger SL/TP eval.

### QA-137 — Pre-sell balance refresh gate skip
**Pattern:** Skipped balance refresh in some path → tried to sell shares we don't have on chain.
**Test:** Pre-flight `getBalanceAllowance` mandatory before EVERY SELL, no exceptions.

---

## Live execution

### QA-178 — Startup external-sell reconciliation gap
**Pattern:** `recover_pending_orders` only checks orders WE placed by order_id. Manual sells via UI during offline window invisible until next live chain event.
**Test:** Startup reconciler walks /activity, closes any OPEN entries with matching SELL.

### QA-176 — FAIL OPEN silent death
**Pattern:** V2 errors silently fall through to V1; V2 dies every tick, V1 covers, no telemetry. Only manual audit reveals.
**Test:** V2 path increments stats counter. Periodic [V2-HEALTH] log every N ticks. If fallback rate > 50% → P1 alert.

### QA-175 — TTL cache false-zero on failure
**Pattern:** Cache that zeros out on HTTP error worse than no cache. V2 sees "no position" → suppresses SL.
**Test:** On transient HTTP failure, cache PRESERVES prior snapshot + logs staleness age. Three branches: success+empty=real zero, success+data=update, exception=preserve.

### QA-172 — balance_provider per-tick HTTP storm
**Pattern:** Per-tick per-asset HTTP to /positions on 2Hz monitor → rate limit cascade → empty response → false "no position" → SL skipped.
**Test:** Single batch /positions fetch per refresh window (TTL 3-5s). Cache shared across all assets.

### QA-173 — `continue` suppresses V1 side effects
**Pattern:** When V2 fork takes over via continue/return, V1's downstream side effects (telegram, decision_log, counters) are NOT auto-replicated.
**Test:** Every fork point has explicit checklist: telegram, decision_log, counter, lifecycle. New paths must enumerate.

### QA-174 — open_orders stub allows double-place
**Pattern:** cancel-before-place sweep is no-op; relies on bridge cancel returning 404 idempotent.
**Test:** Active enumeration of open orders before placing new. Don't trust idempotency assumption alone.

---

## Edge cases (real-world)

### QA-148 — Unreachable FOK loop midpoint repricing
**Pattern:** FOK fallback uses midpoint that's stale → loop forever.
**Test:** FOK price always derived from latest /book, not cached midpoint.

### QA-147 — Session anchor lost on restart
**Pattern:** Bot restart loses peak_price; trail re-armed from current mark, never triggers.
**Test:** Persist peak_price in DB. On restart, restore.

### QA-145 — Price resolved active sell fallthrough
**Pattern:** When mark approaches resolution price (0 or 1), bot fired "price_resolved" closure even with active sell pending.
**Test:** price_resolved path REMOVED. INV-M3 enforces.

### QA-152 — Peak quality gate too strict
**Pattern:** trail activation gated by mark_quality "executable" only → marked stale never advanced peak.
**Test:** Peak from any non-cached source advances peak_price; activation requires only crossing threshold.

### QA-151 — Bid-anchored first SELL
**Pattern:** First SELL after SL trigger went at MARK (not bid) → on dead book, never filled → next sweep at lower mark → bleeds.
**Test:** First SELL = bid + 1 tick (bid-anchored from start, not mark).

### QA-143 — Trail peak blind to thin-book midpoint
**Pattern:** Peak advanced on stale midpoint mark → trail "armed" at fake high → false trail trigger when mark refreshed.
**Test:** Peak advances only on mark from `ws_book` or `chain` source, NOT cached midpoint.

### QA-179 — Nested function forward-reference
**Pattern:** Python nested function called before its def in same outer scope → NameError at runtime.
**Test:** No nested helper definitions; module-level functions or class methods only.

### QA-167 — price_resolved fake-close without chain
**Pattern:** Mark < epsilon → bot closed locally without on-chain SELL fill confirmation.
**Test:** Closure_reason gated on chain_sell_tx_hash OR market.resolved=true. No mark-based shortcuts.

### QA-168 — fee_rate_bps hardcoded
**Pattern:** fee_rate_bps=0 hardcoded → mismatch with sport markets that have 1000 bps → order_version_mismatch.
**Test:** Always read fee from gamma `maker_base_fee` per market, never assume.

---

## Test framework conventions

```ts
// tests/decide.spec.ts
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { decideExit } from "../src/decide";

describe("INV-M2 outcome floor", () => {
  it("blocks SELL below floor on dead book (QA-166)", () => {
    const snap = makeSnap({
      bid: 0.001, ask: 0.999, mark: 0.003,
      expectedOutcomeValue: 0.045,
    });
    const pos = makePos({ fillPrice: 0.35, onchainSize: 10.6 });
    const intent = decideExit(pos, snap, defaultConfig);
    expect(intent.action).toBe("hold");
  });

  it("property: forall snap, action !== sell when price < floor", () => {
    fc.assert(fc.property(
      fc.float({ min: 0.001, max: 0.99 }),  // bid
      fc.float({ min: 0.001, max: 0.99 }),  // mark
      (bid, mark) => {
        const snap = makeSnap({ bid, ask: bid + 0.01, mark });
        const pos = makePos({ fillPrice: mark * 1.5 });
        const intent = decideExit(pos, snap, defaultConfig);
        const floor = outcomeFloor(snap, defaultConfig);
        if (intent.action.startsWith("sell")) {
          expect(intent.price).toBeGreaterThanOrEqual(floor);
        }
      },
    ));
  });
});
```

---

## What this list does NOT cover

- V1-specific Python pitfalls (config injection, _cfg/_deps wiring)
- File-locking quirks (SQLite handles automatically)
- Threading bugs (Node single-threaded by default)
- Filter pipeline detail bugs (separate concern, port later)
- Calibrator bugs (separate system)

These 30 are the SAFETY net. Pass all 30 → core trading loop is sound.
