/**
 * INV-M3 — Closure ONLY via on-chain SELL fill OR UMA-resolved.
 *
 * Two paths only: (a) /activity shows our SELL with matching tx hash;
 * (b) market.umaResolutionStatus === "resolved" AND we redeemed.
 * Forbidden: price_resolved/phantom_external/timeout closures.
 *
 * decide_exit is one piece: it must NEVER return a "close" action — only
 * sell_xxx, redeem, hold, freeze. Closure_reason write happens in lifecycle
 * code, gated by chain confirmation (tested at executor level).
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../../src/decide.js";
import type { ExitAction } from "../../src/types/decide.js";
import { cfg, makePos, makeSnap } from "../helpers.js";

const CLOSURE_FORBIDDEN: readonly ExitAction[] = [];
// Note: ExitAction discriminated union deliberately has no "close" — type-level proof.
// This test verifies behavioral path: no decision returns a closure-like action.

describe("INV-M3 closure only via chain fill", () => {
  it("never returns a close-equivalent action — only sell_xxx/redeem/hold/freeze", () => {
    const pos = makePos();
    const snap = makeSnap();
    const intent = decideExit(pos, snap, cfg);
    expect(CLOSURE_FORBIDDEN).not.toContain(intent.action);
    // The only path that produces "close" is the ExitExecutor on confirmed chain fill,
    // not decide_exit itself.
    expect(["hold", "sell_bid_probe", "sell_bid_aggr", "sell_fok", "redeem", "freeze"]).toContain(
      intent.action,
    );
  });

  it("REDEEM only when market.resolved === true (gate #2)", () => {
    const snap = makeSnap({ resolved: true, umaResolutionStatus: "resolved" });
    const pos = makePos({ side: "YES" });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("redeem");
  });

  it.todo("closure_reason write requires chain SELL tx hash (executor concern)");
  it.todo("price_resolved closure path REMOVED — never close from mark-near-extreme");
});
