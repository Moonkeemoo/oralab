/**
 * INV-M5 — Never double-act on same trade.
 *
 * VALID_TRANSITIONS enforced. EXITING → EXITING forbidden.
 * Every exit_executor call: if state !== "exiting" return.
 *
 * decide_exit may produce SELL intents while pos.status === EXITING (the
 * executor's job is to NOT submit a second order if one is in-flight). But
 * decide_exit must respect terminal states (CLOSED, RESOLVED→CLOSED).
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../../src/decide.js";
import { cfg, makePos, makeSnap } from "../helpers.js";

describe("INV-M5 no double-act", () => {
  it("returns HOLD when status === CLOSED (terminal, no further action)", () => {
    const pos = makePos({ status: "CLOSED" });
    const snap = makeSnap();
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
  });

  it("returns HOLD when status === FAILED (terminal pre-fill)", () => {
    const pos = makePos({ status: "FAILED", shares: 0, onChainShares: 0 });
    const snap = makeSnap();
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
  });

  it.todo("ExitExecutor refuses second SELL when status=EXITING and order in-flight");
  it.todo("VALID_TRANSITIONS enforced: EXITING → EXITING forbidden");
});
