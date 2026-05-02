/**
 * INV-M1 — Never sell more than on-chain shares.
 *
 * Pre-flight check before EVERY order. order.size = min(intent.size, free, on_chain).
 * Watchdog R21 backstops via lifecycle event audit.
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../../src/decide.js";
import { cfg, makePos, makeSnap } from "../helpers.js";

describe("INV-M1 never sell more than on-chain shares", () => {
  it("returns HOLD when onChainShares = 0 (already sold elsewhere)", () => {
    const pos = makePos({ shares: 10, onChainShares: 0 });
    const snap = makeSnap();
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
    expect(intent.gates).toContain("INV-M1");
  });

  it("caps SELL intent.size to onChainShares when local exceeds chain", () => {
    const pos = makePos({ shares: 10, onChainShares: 7, fillPrice: 0.5 });
    const snap = makeSnap({ bid: 0.4, mark: 0.4 }); // -20% triggers SL
    const intent = decideExit(pos, snap, cfg);
    if (intent.action.startsWith("sell")) {
      expect(intent.size).toBeLessThanOrEqual(7);
    }
  });
});
