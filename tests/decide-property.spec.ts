/**
 * Property tests for decide_exit (SPEC §215 mandatory).
 *
 * 1000+ random snapshots — for any input, all 10 invariants hold and the
 * function only ever produces well-formed ExitIntent values.
 *
 * Specific properties checked across the full random space:
 *   - INV-M1: returned size is always ≤ min(pos.shares, pos.onChainShares)
 *     and 0 when onChainShares = 0
 *   - INV-M2: SELL price is always ≥ outcomeFloor (max(tickSize, expected×0.3))
 *   - INV-M3: never returns "redeem" unless market is resolved
 *   - INV-D2: never SELLs when mark source is cached_midpoint
 *   - INV-D3: never SELLs when reconciler drift ≥ 5% (must FREEZE)
 *   - terminal-state safety: CLOSED/FAILED never produces an action
 *   - tick alignment: SELL price always aligned to tickSize
 *   - urgency: every action carries a urgency in 1..5
 *   - determinism: same input → same output (run twice)
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideExit } from "../src/decide.js";
import { DEFAULT_EXIT_CONFIG } from "../src/types/decide.js";
import type { MarketSnapshot } from "../src/types/market.js";
import type { PositionView } from "../src/types/position.js";

const TICK_SIZES = [0.01, 0.001, 0.0001] as const;
const STATUSES = [
  "PENDING",
  "FILLED",
  "OPEN",
  "EXITING",
  "RESOLVED",
  "CLOSED",
  "FAILED",
  "FROZEN",
] as const;
const SOURCES = ["rest_book", "ws_book", "chain", "cached_midpoint"] as const;
const UMA = ["proposed", "disputed", "resolved", null] as const;

const NOW = 1_777_700_000_000;

const arbSnapshot = fc.record({
  bid: fc.double({ min: 0, max: 1, noNaN: true }),
  ask: fc.double({ min: 0, max: 1, noNaN: true }),
  mark: fc.double({ min: 0, max: 1, noNaN: true }),
  tickSize: fc.constantFrom(...TICK_SIZES),
  expectedOutcomeValue: fc.double({ min: 0.01, max: 1, noNaN: true }),
  markSource: fc.constantFrom(...SOURCES),
  markTs: fc.integer({ min: NOW - 300_000, max: NOW }),
  fetchedAt: fc.constant(NOW),
  resolved: fc.boolean(),
  acceptingOrders: fc.boolean(),
  umaResolutionStatus: fc.constantFrom(...UMA),
});

const arbPos = fc.record({
  status: fc.constantFrom(...STATUSES),
  shares: fc.double({ min: 0, max: 1000, noNaN: true }),
  onChainShares: fc.double({ min: 0, max: 1000, noNaN: true }),
  fillPrice: fc.double({ min: 0, max: 1, noNaN: true }),
  peakPrice: fc.double({ min: 0, max: 1, noNaN: true }),
  fillTs: fc.integer({ min: NOW - 86_400_000, max: NOW }),
  trailArmed: fc.boolean(),
  sweepCount: fc.integer({ min: 0, max: 10 }),
  reconciliationDriftPct: fc.double({ min: 0, max: 0.5, noNaN: true }),
});

function buildSnap(s: ReturnType<(typeof arbSnapshot)["map"]>): MarketSnapshot {
  return {
    conditionId: "0xprop",
    assetId: "0",
    bid: s.bid as number,
    ask: s.ask as number,
    bidSize: 100,
    askSize: 100,
    mark: s.mark as number,
    markSource: s.markSource as MarketSnapshot["markSource"],
    markTs: s.markTs as number,
    tickSize: s.tickSize as number,
    negRisk: false,
    minOrderSize: 5,
    expectedOutcomeValue: s.expectedOutcomeValue as number,
    acceptingOrders: s.acceptingOrders as boolean,
    umaResolutionStatus: s.umaResolutionStatus as MarketSnapshot["umaResolutionStatus"],
    resolved: s.resolved as boolean,
    winningOutcomeIndex: null,
    endDateTs: NOW + 86_400_000,
    fetchedAt: s.fetchedAt as number,
  };
}

function buildPos(p: ReturnType<(typeof arbPos)["map"]>): PositionView {
  return {
    id: "pos-prop",
    userId: 1,
    walletAddress: "0xprop",
    conditionId: "0xprop",
    assetId: "0",
    side: "YES",
    status: p.status as PositionView["status"],
    shares: p.shares as number,
    onChainShares: p.onChainShares as number,
    fillPrice: p.fillPrice as number,
    peakPrice: p.peakPrice as number,
    fillTs: p.fillTs as number,
    lastStateChangeTs: p.fillTs as number,
    trailArmed: p.trailArmed as boolean,
    sweepCount: p.sweepCount as number,
    reconciliationDriftPct: p.reconciliationDriftPct as number,
  };
}

const cfg = DEFAULT_EXIT_CONFIG;

describe("decide_exit — properties (SPEC §215)", () => {
  it("INV-M1: returned size never exceeds min(pos.shares, pos.onChainShares)", () => {
    fc.assert(
      fc.property(arbSnapshot, arbPos, (s, p) => {
        const intent = decideExit(buildPos(p), buildSnap(s), cfg);
        if (intent.action === "hold" || intent.action === "freeze" || intent.action === "redeem") {
          return intent.size === 0;
        }
        const cap = Math.min(p.shares as number, p.onChainShares as number);
        return intent.size > 0 && intent.size <= cap;
      }),
      { numRuns: 1000 },
    );
  });

  it("INV-M1: onChainShares=0 forces non-SELL outcome (HOLD/FREEZE/REDEEM)", () => {
    fc.assert(
      fc.property(arbSnapshot, arbPos, (s, p) => {
        const pos = buildPos({ ...p, onChainShares: 0 });
        const intent = decideExit(pos, buildSnap(s), cfg);
        return (
          intent.action === "hold" || intent.action === "freeze" || intent.action === "redeem"
        );
      }),
      { numRuns: 500 },
    );
  });

  it("INV-M2: SELL price is always ≥ outcomeFloor = max(tickSize, expected×0.3)", () => {
    fc.assert(
      fc.property(arbSnapshot, arbPos, (s, p) => {
        const snap = buildSnap(s);
        const intent = decideExit(buildPos(p), snap, cfg);
        if (
          intent.action !== "sell_bid_probe" &&
          intent.action !== "sell_bid_aggr" &&
          intent.action !== "sell_fok"
        ) {
          return true;
        }
        const floor = Math.max(snap.tickSize, snap.expectedOutcomeValue * cfg.outcomeFloorMultiplier);
        return intent.price >= floor - 1e-9;
      }),
      { numRuns: 1000 },
    );
  });

  it("INV-M3: redeem only when resolved/uma=resolved", () => {
    fc.assert(
      fc.property(arbSnapshot, arbPos, (s, p) => {
        const snap = buildSnap(s);
        const intent = decideExit(buildPos(p), snap, cfg);
        if (intent.action !== "redeem") return true;
        return snap.resolved || snap.umaResolutionStatus === "resolved";
      }),
      { numRuns: 1000 },
    );
  });

  it("INV-D2: never SELL when mark source = cached_midpoint", () => {
    fc.assert(
      fc.property(arbSnapshot, arbPos, (s, p) => {
        const snap = buildSnap({ ...s, markSource: "cached_midpoint" });
        const intent = decideExit(buildPos(p), snap, cfg);
        return (
          intent.action !== "sell_bid_probe" &&
          intent.action !== "sell_bid_aggr" &&
          intent.action !== "sell_fok"
        );
      }),
      { numRuns: 500 },
    );
  });

  it("INV-D3: drift ≥ 5% → never SELL (must FREEZE or HOLD)", () => {
    fc.assert(
      fc.property(arbSnapshot, arbPos, (s, p) => {
        const pos = buildPos({ ...p, reconciliationDriftPct: 0.06 });
        const intent = decideExit(pos, buildSnap(s), cfg);
        return (
          intent.action !== "sell_bid_probe" &&
          intent.action !== "sell_bid_aggr" &&
          intent.action !== "sell_fok"
        );
      }),
      { numRuns: 500 },
    );
  });

  it("Terminal CLOSED/FAILED → always HOLD", () => {
    fc.assert(
      fc.property(
        arbSnapshot,
        arbPos,
        fc.constantFrom("CLOSED", "FAILED" as const),
        (s, p, status) => {
          const intent = decideExit(buildPos({ ...p, status }), buildSnap(s), cfg);
          return intent.action === "hold";
        },
      ),
      { numRuns: 200 },
    );
  });

  it("FROZEN → always FREEZE", () => {
    fc.assert(
      fc.property(arbSnapshot, arbPos, (s, p) => {
        const intent = decideExit(buildPos({ ...p, status: "FROZEN" }), buildSnap(s), cfg);
        return intent.action === "freeze";
      }),
      { numRuns: 200 },
    );
  });

  it("Tick alignment: SELL price aligned to tickSize", () => {
    fc.assert(
      fc.property(arbSnapshot, arbPos, (s, p) => {
        const snap = buildSnap(s);
        const intent = decideExit(buildPos(p), snap, cfg);
        if (
          intent.action !== "sell_bid_probe" &&
          intent.action !== "sell_bid_aggr" &&
          intent.action !== "sell_fok"
        ) {
          return true;
        }
        const ticks = intent.price / snap.tickSize;
        return Math.abs(ticks - Math.round(ticks)) < 1e-6;
      }),
      { numRuns: 1000 },
    );
  });

  it("Urgency in 1..5 always", () => {
    fc.assert(
      fc.property(arbSnapshot, arbPos, (s, p) => {
        const intent = decideExit(buildPos(p), buildSnap(s), cfg);
        return intent.urgency >= 1 && intent.urgency <= 5;
      }),
      { numRuns: 500 },
    );
  });

  it("Determinism: same input → same output", () => {
    fc.assert(
      fc.property(arbSnapshot, arbPos, (s, p) => {
        const a = decideExit(buildPos(p), buildSnap(s), cfg);
        const b = decideExit(buildPos(p), buildSnap(s), cfg);
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 500 },
    );
  });

  it("Pure: never throws", () => {
    fc.assert(
      fc.property(arbSnapshot, arbPos, (s, p) => {
        try {
          decideExit(buildPos(p), buildSnap(s), cfg);
          return true;
        } catch {
          return false;
        }
      }),
      { numRuns: 1000 },
    );
  });
});
