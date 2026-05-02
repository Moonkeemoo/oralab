/**
 * INV-D1 — Source-of-truth hierarchy, never otherwise.
 *
 * /positions = position truth, /activity = realized PnL truth,
 * gamma.outcomePrices = odds truth, /book = bid/ask truth.
 * NEVER /midpoint, NEVER mark*0.99 synthesis (QA-180).
 *
 * decide_exit consumes MarketSnapshot which is built from these trusted sources.
 * The snapshot builder enforces source rules (tested at builder level).
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../../src/decide.js";
import { cfg, makePos, makeSnap } from "../helpers.js";

describe("INV-D1 source-of-truth hierarchy", () => {
  it("rejects synthesized mark sources — markSource must be ws_book/rest_book/chain", () => {
    // cached_midpoint is a forbidden source for mark; if snapshot builder ever
    // constructs one, decide_exit must HOLD rather than trust it.
    const snap = makeSnap({ markSource: "cached_midpoint" });
    const pos = makePos();
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
    expect(intent.gates.some((g) => g.includes("D1") || g.includes("D2"))).toBe(true);
  });

  it.todo("MarketSnapshot builder reads bid/ask from /book, never /midpoint");
  it.todo("PositionView reflects /positions chain truth, not local DB shares");
  it.todo("Realized PnL uses /activity arithmetic, not local trade log");
  it.todo('Display labels "verified" vs "local-only" honored in Mini App');
});
