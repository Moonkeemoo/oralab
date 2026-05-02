/**
 * Replay tests (SPEC §216): historical / hand-crafted position lifecycles
 * fed through decide_exit tick by tick. Each lifecycle asserts:
 *
 *   - No premature SL (must not fire before minStopLossAgeSeconds)
 *   - No fake closure (REDEEM only on resolved, FREEZE only on FROZEN/drift)
 *   - State progressions match the documented decision tree priority
 *
 * v1 archive doesn't have decision_log.jsonl yet — these synthetic
 * lifecycles cover the same shape until the P3a shadow-replay engine
 * pipes real data through.
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../src/decide.js";
import type { ExitConfig, ExitIntent } from "../src/types/decide.js";
import type { MarketSnapshot } from "../src/types/market.js";
import type { PositionView } from "../src/types/position.js";
import { cfg, makePos, makeSnap, NOW } from "./helpers.js";

interface Tick {
  /** Seconds since fill */
  ageSec: number;
  bid: number;
  ask: number;
  mark: number;
  resolved?: boolean;
  driftPct?: number;
  forceFrozen?: boolean;
}

interface Lifecycle {
  name: string;
  fillPrice: number;
  ticks: Tick[];
  /** sequence of expected actions per tick (1:1) */
  expected: ExitIntent["action"][];
  /** at which tick (0-indexed) sweepCount increments (executor would do this) */
  sweepIncrementAtTick?: number[];
}

function runLifecycle(lc: Lifecycle, conf: ExitConfig = cfg): ExitIntent[] {
  const intents: ExitIntent[] = [];
  let sweepCount = 0;
  let peakPrice = lc.fillPrice;

  for (let i = 0; i < lc.ticks.length; i += 1) {
    const t = lc.ticks[i];
    if (!t) continue;
    if (t.mark > peakPrice) peakPrice = t.mark;

    const snap: MarketSnapshot = makeSnap({
      bid: t.bid,
      ask: t.ask,
      mark: t.mark,
      tickSize: 0.01,
      markTs: NOW + t.ageSec * 1000,
      fetchedAt: NOW + t.ageSec * 1000,
      resolved: t.resolved ?? false,
    });

    const pos: PositionView = makePos({
      status: t.forceFrozen ? "FROZEN" : "OPEN",
      shares: 10,
      onChainShares: 10,
      fillPrice: lc.fillPrice,
      peakPrice,
      fillTs: NOW,
      sweepCount,
      reconciliationDriftPct: t.driftPct ?? 0,
    });

    const intent = decideExit(pos, snap, conf);
    intents.push(intent);

    if (lc.sweepIncrementAtTick?.includes(i)) sweepCount += 1;
  }
  return intents;
}

const LIFECYCLES: Lifecycle[] = [
  {
    name: "uneventful flat → resolved",
    fillPrice: 0.5,
    ticks: [
      { ageSec: 60, bid: 0.49, ask: 0.51, mark: 0.5 },
      { ageSec: 600, bid: 0.5, ask: 0.51, mark: 0.5 },
      { ageSec: 86_400, bid: 0.5, ask: 0.51, mark: 0.5, resolved: true },
    ],
    expected: ["hold", "hold", "redeem"],
  },
  {
    name: "early dip below SL but before min age → HOLD then SL fires",
    fillPrice: 0.5,
    ticks: [
      { ageSec: 60, bid: 0.4, ask: 0.41, mark: 0.4 }, // -20% pnl, age 60s < 300s
      { ageSec: 350, bid: 0.4, ask: 0.41, mark: 0.4 }, // age > 300s now → SL
    ],
    expected: ["sell_bid_probe", "sell_bid_probe"],
    // First tick: -20% triggers SL emergency (-17%) which has NO age guard.
    // Second tick: still emergency. Both bid+1tick probe at sweep=0.
  },
  {
    name: "TP ramp",
    fillPrice: 0.5,
    ticks: [
      { ageSec: 60, bid: 0.55, ask: 0.56, mark: 0.55 },
      { ageSec: 120, bid: 0.6, ask: 0.61, mark: 0.6 },
    ],
    expected: ["hold", "sell_bid_probe"],
  },
  {
    name: "trail giveback after +30% peak",
    fillPrice: 0.5,
    ticks: [
      { ageSec: 60, bid: 0.55, ask: 0.56, mark: 0.55 },
      { ageSec: 120, bid: 0.65, ask: 0.66, mark: 0.65 }, // peak 0.65 (+30%) — TP fires
    ],
    expected: ["hold", "sell_bid_probe"],
    // Note: at +30% mark, TP gate (+20%) fires before trail. To exercise
    // pure trail we'd need pullback below TP threshold next; this lifecycle
    // intentionally shows TP wins.
  },
  {
    name: "drift mid-life → FREEZE",
    fillPrice: 0.5,
    ticks: [
      { ageSec: 60, bid: 0.5, ask: 0.51, mark: 0.5 },
      { ageSec: 120, bid: 0.5, ask: 0.51, mark: 0.5, driftPct: 0.07 },
    ],
    expected: ["hold", "freeze"],
  },
  {
    name: "FROZEN status persists",
    fillPrice: 0.5,
    ticks: [
      { ageSec: 60, bid: 0.5, ask: 0.51, mark: 0.5, forceFrozen: true },
    ],
    expected: ["freeze"],
  },
  {
    name: "catastrophic dip + 2 sweeps → emergency FOK at floor",
    fillPrice: 0.6,
    ticks: [
      { ageSec: 60, bid: 0.45, ask: 0.46, mark: 0.45 }, // -25% sweep 0
      { ageSec: 70, bid: 0.45, ask: 0.46, mark: 0.45 }, // sweep 1
      { ageSec: 80, bid: 0.45, ask: 0.46, mark: 0.45 }, // sweep 2 → FOK
    ],
    expected: ["sell_bid_probe", "sell_bid_probe", "sell_fok"],
    sweepIncrementAtTick: [0, 1], // executor increments after each placeSell
  },
];

describe("decide_exit replay — lifecycle invariants", () => {
  for (const lc of LIFECYCLES) {
    it(lc.name, () => {
      const intents = runLifecycle(lc);
      expect(intents.length).toBe(lc.expected.length);
      for (let i = 0; i < lc.expected.length; i += 1) {
        expect(intents[i]?.action, `tick ${i}`).toBe(lc.expected[i]);
      }
    });
  }

  it("invariant: standard SL never fires before minStopLossAgeSeconds (only emergency does)", () => {
    // Mark drops -16% (between SL=-15% and SL_emergency=-17%) at age 60s.
    // Standard SL has min-age guard, so we should HOLD until age >= 300s.
    const lc: Lifecycle = {
      name: "std SL min-age guard",
      fillPrice: 0.5,
      ticks: [
        { ageSec: 60, bid: 0.42, ask: 0.43, mark: 0.42 }, // -16%
        { ageSec: 200, bid: 0.42, ask: 0.43, mark: 0.42 },
        { ageSec: 350, bid: 0.42, ask: 0.43, mark: 0.42 }, // age > 300 → SL fires
      ],
      expected: ["hold", "hold", "sell_bid_probe"],
    };
    const intents = runLifecycle(lc);
    expect(intents[0]?.action).toBe("hold");
    expect(intents[1]?.action).toBe("hold");
    expect(intents[2]?.action).toBe("sell_bid_probe");
    expect(intents[2]?.gates).toContain("SL");
  });

  it("invariant: REDEEM only on snap.resolved (never with active book)", () => {
    const lc: Lifecycle = {
      name: "no premature redeem",
      fillPrice: 0.5,
      ticks: [{ ageSec: 60, bid: 0.5, ask: 0.51, mark: 0.5, resolved: false }],
      expected: ["hold"],
    };
    const intents = runLifecycle(lc);
    expect(intents[0]?.action).not.toBe("redeem");
  });
});
