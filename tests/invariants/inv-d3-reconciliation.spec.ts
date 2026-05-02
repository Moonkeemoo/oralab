/**
 * INV-D3 — Continuous reconciliation with explicit grace periods.
 *
 * Position monitor 2Hz tick reconciles DB vs /positions. Drift thresholds:
 *  - <0.5%: ok
 *  - <30s grace period: continue
 *  - 0.5%–5%: sync to chain
 *  - 5%–10%: freeze with WARN
 *  - ≥10%: freeze with P0
 *
 * decide_exit's piece: when reconciliationDriftPct beyond threshold OR
 * status === FROZEN, return FREEZE intent. The reconciler runs first (per tick),
 * sets driftPct + may set status=FROZEN; decide_exit honors that signal.
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../../src/decide.js";
import { cfg, makePos, makeSnap } from "../helpers.js";

describe("INV-D3 reconciliation conflict", () => {
  it("FREEZE when status === FROZEN (reconciler set it)", () => {
    const pos = makePos({ status: "FROZEN" });
    const snap = makeSnap();
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("freeze");
    expect(intent.gates).toContain("INV-D3");
  });

  it("FREEZE on heavy drift > 10% (P0)", () => {
    const pos = makePos({ shares: 10, onChainShares: 8.9, reconciliationDriftPct: 0.11 });
    const snap = makeSnap();
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("freeze");
  });

  it("FREEZE on moderate drift 5-10% (P1 alert)", () => {
    const pos = makePos({ shares: 10, onChainShares: 9.3, reconciliationDriftPct: 0.07 });
    const snap = makeSnap();
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("freeze");
  });

  it.todo("reconciler runs every 2Hz tick, not only at startup");
  it.todo("grace period: PENDING/FILLED <30s, EXITING <60s, no freeze inside grace");
  it.todo("FROZEN → OPEN recovery requires Mini App human Resume button");
});
