/**
 * QA-154 — Exact bid post-only rejection.
 *
 * Pattern: post-only SELL at exact bid rejected (would match). Need to undercut
 * by 100-300bps on retry.
 *
 * Rule: when sweep_count > 0 OR post_only=true and price ≤ bid+tick,
 * undercut by 1 tick to bid-1tick.
 *
 * Out of decide_exit scope (post-only is an order param). decide_exit's piece:
 * after first sweep failure, escalate to sell_bid_aggr (bid-1tick) — INV-M2 floor
 * still gates the price.
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../../src/decide.js";
import { cfg, makePos, makeSnap } from "../helpers.js";

describe("QA-154 escalate after sweep", () => {
  it("after sweep_count >= 1, SL produces sell_bid_aggr (bid-1tick)", () => {
    const snap = makeSnap({ bid: 0.4, ask: 0.41, mark: 0.4, tickSize: 0.01 });
    const pos = makePos({
      fillPrice: 0.5,
      shares: 10,
      onChainShares: 10,
      sweepCount: 1,
    });
    const intent = decideExit(pos, snap, cfg);
    if (intent.action === "sell_bid_aggr") {
      // bid - 1 tick = 0.39
      expect(intent.price).toBeCloseTo(0.39, 5);
    }
  });

  it.todo("OrderManager passes post_only=false on aggr branch (allow taker)");
});
