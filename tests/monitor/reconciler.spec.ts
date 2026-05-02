import { describe, expect, it } from "vitest";
import type { DataPosition } from "../../src/api/data.js";
import { type PositionForRecon, reconcileAgainstChain } from "../../src/monitor/reconciler.js";

const NOW = 1_777_700_000_000;

function chainOf(assetId: string, size: number): DataPosition[] {
  return [
    {
      proxyWallet: "0xtest",
      asset: assetId,
      conditionId: "0xcond",
      size,
      avgPrice: 0.5,
      initialValue: 10,
      currentValue: 10,
      cashPnl: 0,
      percentPnl: 0,
      curPrice: 0.5,
      redeemable: false,
      mergeable: false,
      title: "test",
      outcome: "Yes",
      outcomeIndex: 0,
      oppositeOutcome: "No",
      oppositeAsset: "1",
      endDate: "2026-01-01",
      negativeRisk: false,
    },
  ];
}

function pos(over: Partial<PositionForRecon> = {}): PositionForRecon {
  return {
    id: 1,
    walletAddress: "0xtest",
    assetId: "asset-1",
    status: "OPEN",
    shares: 10,
    lastStateChangeTs: NOW - 60_000,
    ...over,
  };
}

describe("INV-D3 reconciler — chain absent paths", () => {
  it("PENDING within 30s grace → continue", () => {
    const r = reconcileAgainstChain(
      pos({ status: "PENDING", lastStateChangeTs: NOW - 10_000 }),
      [],
      NOW,
    );
    expect(r.action).toBe("continue");
  });
  it("FILLED within 30s grace → continue", () => {
    const r = reconcileAgainstChain(
      pos({ status: "FILLED", lastStateChangeTs: NOW - 10_000 }),
      [],
      NOW,
    );
    expect(r.action).toBe("continue");
  });
  it("EXITING within 60s grace → continue", () => {
    const r = reconcileAgainstChain(
      pos({ status: "EXITING", lastStateChangeTs: NOW - 30_000 }),
      [],
      NOW,
    );
    expect(r.action).toBe("continue");
  });
  it("EXITING beyond 60s grace + chain absent → close as sell_filled_chain_lag", () => {
    const r = reconcileAgainstChain(
      pos({ status: "EXITING", lastStateChangeTs: NOW - 90_000 }),
      [],
      NOW,
    );
    expect(r.action).toBe("close");
    expect(r.reason).toBe("sell_filled_chain_lag");
  });
  it("OPEN with chain invisible beyond grace → freeze chain_invisible", () => {
    const r = reconcileAgainstChain(
      pos({ status: "OPEN", lastStateChangeTs: NOW - 90_000 }),
      [],
      NOW,
    );
    expect(r.action).toBe("freeze");
    expect(r.reason).toBe("chain_invisible");
  });
});

describe("INV-D3 reconciler — chain present, drift bands", () => {
  it("drift < 0.5% → ok", () => {
    const r = reconcileAgainstChain(pos({ shares: 10 }), chainOf("asset-1", 10.04), NOW);
    expect(r.action).toBe("ok");
  });
  it("drift 1% within 30s of state change → continue (grace)", () => {
    const r = reconcileAgainstChain(
      pos({ shares: 10, lastStateChangeTs: NOW - 5_000 }),
      chainOf("asset-1", 10.1),
      NOW,
    );
    expect(r.action).toBe("continue");
  });
  it("drift 1% beyond grace → sync_to_chain", () => {
    const r = reconcileAgainstChain(
      pos({ shares: 10, lastStateChangeTs: NOW - 60_000 }),
      chainOf("asset-1", 10.3),
      NOW,
    );
    expect(r.action).toBe("sync_to_chain");
    expect(r.chainSize).toBe(10.3);
  });
  it("drift 7% beyond grace → freeze drift_5_to_10", () => {
    const r = reconcileAgainstChain(
      pos({ shares: 10, lastStateChangeTs: NOW - 60_000 }),
      chainOf("asset-1", 9.3),
      NOW,
    );
    expect(r.action).toBe("freeze");
    expect(r.reason).toBe("drift_5_to_10");
  });
  it("drift 15% beyond grace → freeze drift_over_10 (P0)", () => {
    const r = reconcileAgainstChain(
      pos({ shares: 10, lastStateChangeTs: NOW - 60_000 }),
      chainOf("asset-1", 8.5),
      NOW,
    );
    expect(r.action).toBe("freeze");
    expect(r.reason).toBe("drift_over_10");
  });
});
