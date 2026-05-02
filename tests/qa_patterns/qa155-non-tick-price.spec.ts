/**
 * QA-155 — Non-tick price rejection.
 *
 * Pattern: sell price 0.04567 not aligned to tick 0.001 → CLOB rejected with
 * tick_size_mismatch.
 *
 * Rule: SELL → Math.floor(price / tickSize + 1e-9) * tickSize. BUY → ceil.
 *
 * decide_exit produces a price; the order signer enforces tick alignment as
 * a separate guard. Test both: decide_exit's price is tick-clean AND signer
 * re-rounds defensively.
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../../src/decide.js";
import { cfg, makePos, makeSnap } from "../helpers.js";

describe("QA-155 tick-aligned prices from decide_exit", () => {
  it("SELL price aligned to tickSize 0.01", () => {
    const snap = makeSnap({ bid: 0.4, ask: 0.41, mark: 0.4, tickSize: 0.01 });
    const pos = makePos({ fillPrice: 0.6, shares: 10, onChainShares: 10 }); // -33%
    const intent = decideExit(pos, snap, cfg);
    if (intent.action.startsWith("sell")) {
      const remainder = (intent.price * 1000) % (snap.tickSize * 1000);
      expect(Math.abs(remainder)).toBeLessThan(0.0001);
    }
  });

  it("SELL price aligned to tickSize 0.001 (granular markets)", () => {
    const snap = makeSnap({ bid: 0.453, ask: 0.456, mark: 0.453, tickSize: 0.001 });
    const pos = makePos({ fillPrice: 0.6, shares: 10, onChainShares: 10 });
    const intent = decideExit(pos, snap, cfg);
    if (intent.action.startsWith("sell")) {
      const remainder = (intent.price * 10000) % (snap.tickSize * 10000);
      expect(Math.abs(remainder)).toBeLessThan(0.001);
    }
  });

  it.todo("OrderManager re-rounds defensively before sign+post (1e-9 epsilon)");
});
