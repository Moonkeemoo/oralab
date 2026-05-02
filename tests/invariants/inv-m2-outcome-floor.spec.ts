/**
 * INV-M2 — Never sell below outcome floor.
 *
 * floor = max(min_tick, expected_outcome_value × 0.3)
 * expected_outcome_value = parsed gamma_api.outcomePrices[our_side_index]
 * Order rejected if price < floor. Watchdog R22 backstops.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideExit } from "../../src/decide.js";
import { cfg, makePos, makeSnap } from "../helpers.js";

describe("INV-M2 outcome floor", () => {
  it("blocks SELL below floor on dead book (QA-166 pattern)", () => {
    // dead book: real bid $0.001, ask $0.999, mark $0.003
    // expected outcome value 0.045 → floor = max(0.01, 0.045 * 0.3) = 0.0135
    const snap = makeSnap({
      bid: 0.001,
      ask: 0.999,
      mark: 0.003,
      tickSize: 0.01,
      expectedOutcomeValue: 0.045,
    });
    const pos = makePos({ fillPrice: 0.35, shares: 10.6, onChainShares: 10.6 });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
    expect(intent.gates.some((g) => g.includes("M2") || g.includes("D2"))).toBe(true);
  });

  it("when SELL fires, price must be >= floor", () => {
    const snap = makeSnap({ bid: 0.4, ask: 0.41, mark: 0.4, expectedOutcomeValue: 0.5 });
    const pos = makePos({ fillPrice: 0.5, shares: 10, onChainShares: 10 });
    const intent = decideExit(pos, snap, cfg);
    if (intent.action.startsWith("sell")) {
      const floor = Math.max(snap.tickSize, snap.expectedOutcomeValue * cfg.outcomeFloorMultiplier);
      expect(intent.price).toBeGreaterThanOrEqual(floor);
    }
  });

  it("property: forall snap, action !== sell when proposed price < floor", () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0.001), max: Math.fround(0.5), noNaN: true }),
        fc.float({ min: Math.fround(0.05), max: Math.fround(0.99), noNaN: true }),
        fc.float({ min: Math.fround(0.05), max: Math.fround(0.99), noNaN: true }),
        (bid, mark, expectedOutcome) => {
          const snap = makeSnap({
            bid,
            ask: bid + 0.01,
            mark,
            expectedOutcomeValue: expectedOutcome,
          });
          const pos = makePos({ fillPrice: mark * 1.5, shares: 10, onChainShares: 10 });
          const intent = decideExit(pos, snap, cfg);
          const floor = Math.max(snap.tickSize, expectedOutcome * cfg.outcomeFloorMultiplier);
          if (intent.action.startsWith("sell")) {
            expect(intent.price).toBeGreaterThanOrEqual(floor);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
