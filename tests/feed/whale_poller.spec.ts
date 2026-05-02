import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dataApi from "../../src/api/data.js";
import { WhaleActivityPoller } from "../../src/feed/whale_poller.js";

interface Activity {
  asset: string;
  conditionId: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  timestamp: number;
  transactionHash: string;
  fee: number;
  title: string;
}

function act(over: Partial<Activity> = {}): Activity {
  return {
    asset: "asset-1",
    conditionId: "0xcond",
    side: "BUY",
    size: 10,
    price: 0.5,
    timestamp: 1_000,
    transactionHash: "0xtx",
    fee: 0,
    title: "test",
    ...over,
  };
}

describe("WhaleActivityPoller — fresh-event detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("emits only new BUYs since lastSeenTs; sells are filtered out", async () => {
    const calls: string[] = [];
    const handler = {
      onWhaleBuy: async (whale: string, a: Activity) => {
        calls.push(`${whale}:${a.timestamp}:${a.side}`);
      },
    };

    const fetched = vi
      .spyOn(dataApi, "getActivity")
      .mockResolvedValueOnce([
        act({ timestamp: 100, side: "BUY" }),
        act({ timestamp: 90, side: "SELL" }),
      ])
      .mockResolvedValueOnce([
        act({ timestamp: 200, side: "BUY", transactionHash: "0xt2" }),
        act({ timestamp: 100, side: "BUY", transactionHash: "0xt1" }), // duplicate
      ]);

    const poller = new WhaleActivityPoller({
      whaleAddresses: ["0xwhale"],
      intervalMs: 1_000,
      handler,
    });

    await poller.tickAll();
    expect(calls).toEqual(["0xwhale:100:BUY"]);

    await poller.tickAll();
    expect(calls).toEqual(["0xwhale:100:BUY", "0xwhale:200:BUY"]);
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it("emits BUYs in chronological order even when API returns newest-first", async () => {
    const seen: number[] = [];
    const handler = { onWhaleBuy: async (_w: string, a: Activity) => void seen.push(a.timestamp) };

    vi.spyOn(dataApi, "getActivity").mockResolvedValueOnce([
      act({ timestamp: 300, transactionHash: "0xc" }),
      act({ timestamp: 200, transactionHash: "0xb" }),
      act({ timestamp: 100, transactionHash: "0xa" }),
    ]);

    const poller = new WhaleActivityPoller({ whaleAddresses: ["0xwhale"], handler });
    await poller.tickAll();
    expect(seen).toEqual([100, 200, 300]);
  });

  it("absorbs handler errors per-event without losing the lastSeenTs progress", async () => {
    const handler = {
      onWhaleBuy: vi.fn().mockRejectedValue(new Error("boom")),
    };
    vi.spyOn(dataApi, "getActivity")
      .mockResolvedValueOnce([act({ timestamp: 100 })])
      .mockResolvedValueOnce([act({ timestamp: 100 })]); // same

    const poller = new WhaleActivityPoller({ whaleAddresses: ["0xwhale"], handler });
    await poller.tickAll();
    await poller.tickAll();
    // First tick: handler called once; second tick: nothing newer than 100, no call
    expect(handler.onWhaleBuy).toHaveBeenCalledTimes(1);
  });

  it("recovers from API failure on next tick", async () => {
    const handler = { onWhaleBuy: vi.fn() };
    vi.spyOn(dataApi, "getActivity")
      .mockRejectedValueOnce(new Error("api down"))
      .mockResolvedValueOnce([act({ timestamp: 100 })]);

    const poller = new WhaleActivityPoller({ whaleAddresses: ["0xwhale"], handler });
    await poller.tickAll();
    expect(handler.onWhaleBuy).not.toHaveBeenCalled();
    await poller.tickAll();
    expect(handler.onWhaleBuy).toHaveBeenCalledTimes(1);
  });
});
