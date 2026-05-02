/**
 * QA-180 — Synthesized bid/ask masks dead orderbook.
 *
 * Pattern: _build_snapshot defaults bid = mark*0.99, ask = mark*1.01 when
 * not provided. Real book has bid=$0.01 ask=$0.99 → spread 196% but synthesized
 * spread shows 2% → INV-D2 spread gate doesn't fire → SL fires on dead book.
 *
 * Test: given dead orderbook, decide_exit must HOLD with INV-D2 in gates.
 * Real bid/ask must come from /book, never synthesized.
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../../src/decide.js";
import { cfg, makePos, makeSnap } from "../helpers.js";

describe("QA-180 dead orderbook with real /book bid/ask", () => {
  it("HOLD on bid 0.01 / ask 0.99 / mark 0.5 (196% spread)", () => {
    const snap = makeSnap({ bid: 0.01, ask: 0.99, mark: 0.5, expectedOutcomeValue: 0.5 });
    const pos = makePos({ fillPrice: 0.5, shares: 10, onChainShares: 10 });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
    expect(intent.gates.some((g) => g.includes("D2") || g.includes("180"))).toBe(true);
  });

  it("HOLD even when SL would otherwise trigger (dead book takes precedence)", () => {
    // SL at -15%: position fillPrice 0.5, mark dropped to 0.4 (-20%)
    // BUT book is dead — no real exit possible
    const snap = makeSnap({ bid: 0.001, ask: 0.999, mark: 0.4, expectedOutcomeValue: 0.5 });
    const pos = makePos({ fillPrice: 0.5, shares: 10, onChainShares: 10 });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
  });
});
