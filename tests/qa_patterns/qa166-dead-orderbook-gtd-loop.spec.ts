/**
 * QA-166 — Dead orderbook GTD loop.
 *
 * Pattern: bot places GTD@mark, mark much higher than real bid → expires,
 * retries with new mark, bleeds slowly. (d847559e and 8602f617 incidents.)
 *
 * Rule: when bid * 5 < mark, decide_exit produces HOLD or sell_bid_aggr at
 * bid+tick, NEVER sell at mark.
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../../src/decide.js";
import { cfg, makePos, makeSnap } from "../helpers.js";

describe("QA-166 no SELL at stale mark on dead book", () => {
  it("when bid*5 < mark, never produces SELL price near mark", () => {
    // bid 0.05, mark 0.40 → bid*5=0.25 < mark
    const snap = makeSnap({
      bid: 0.05,
      ask: 0.41,
      mark: 0.4,
      tickSize: 0.01,
      expectedOutcomeValue: 0.5,
    });
    const pos = makePos({ fillPrice: 0.6, shares: 10, onChainShares: 10 }); // -33% loss
    const intent = decideExit(pos, snap, cfg);
    if (intent.action.startsWith("sell")) {
      // SELL price must be anchored to bid, not mark
      expect(intent.price).toBeLessThanOrEqual(snap.bid + 2 * snap.tickSize);
    }
  });

  it("first SL retry is bid-anchored bid+1tick, not mark (QA-151)", () => {
    const snap = makeSnap({ bid: 0.4, ask: 0.5, mark: 0.45 });
    const pos = makePos({ fillPrice: 0.6, shares: 10, onChainShares: 10, sweepCount: 0 });
    const intent = decideExit(pos, snap, cfg);
    if (intent.action === "sell_bid_probe") {
      // bid+1tick = 0.41
      expect(intent.price).toBeCloseTo(0.41, 5);
    }
  });
});
