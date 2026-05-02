import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LIVE-mode unit tests for placeBuy / placeSell. Mocks ../../src/api/clob.js
 * so we can drive ClobClient responses deterministically without touching
 * Polymarket. Each test asserts a specific bulletproof guarantee.
 */

interface MockClient {
  createAndPostMarketOrder: ReturnType<typeof vi.fn>;
  createAndPostOrder: ReturnType<typeof vi.fn>;
  getBalanceAllowance: ReturnType<typeof vi.fn>;
  getOrder: ReturnType<typeof vi.fn>;
  cancelOrder: ReturnType<typeof vi.fn>;
  getOpenOrders: ReturnType<typeof vi.fn>;
}

let mockClient: MockClient;

vi.mock("../../src/api/clob.js", async () => {
  return {
    getClobClient: () => ({
      client: mockClient,
      walletAddress: "0xfake",
    }),
    isDryRun: () => false,
    isKillSwitchActive: () => false,
  };
});

import {
  cancelOpenOrdersForAsset,
  placeBuy,
  placeSell,
} from "../../src/execute/order_manager.js";

function freshMock(): MockClient {
  return {
    createAndPostMarketOrder: vi.fn(),
    createAndPostOrder: vi.fn(),
    getBalanceAllowance: vi.fn(),
    getOrder: vi.fn(),
    cancelOrder: vi.fn(),
    getOpenOrders: vi.fn(),
  };
}

describe("placeBuy LIVE — FOK detection + delayed-fill disambiguation", () => {
  beforeEach(() => {
    mockClient = freshMock();
    vi.stubEnv("DRY_RUN", "false");
    vi.stubEnv("ORDER_DELAYED_POLL_MS", "200");
    vi.stubEnv("ORDER_DELAYED_POLL_INTERVAL_MS", "50");
    // Default: pUSD plenty
    mockClient.getBalanceAllowance.mockResolvedValue({ balance: "1000000000" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("normal success path: takingAmount > 0 → success", async () => {
    mockClient.createAndPostMarketOrder.mockResolvedValue({
      success: true,
      orderID: "0xnormal",
      status: "matched",
      makingAmount: "5000000",
      takingAmount: "10",
      transactionsHashes: ["0xtx"],
    });
    const r = await placeBuy({
      userId: 1,
      tokenId: "tok-A",
      price: 0.5,
      usdAmount: 5,
      tickSize: 0.01,
      negRisk: false,
    });
    expect(r.success).toBe(true);
    expect(r.takingAmount).toBe("10");
  });

  it("delayed + empty + getOrder polls find size_matched → success_delayed", async () => {
    mockClient.createAndPostMarketOrder.mockResolvedValue({
      success: true,
      orderID: "0xdelayed",
      status: "delayed",
      makingAmount: "",
      takingAmount: "",
      transactionsHashes: [],
    });
    // First poll: still empty. Second poll: size_matched > 0.
    mockClient.getOrder
      .mockResolvedValueOnce({ size_matched: "0", status: "delayed" })
      .mockResolvedValueOnce({ size_matched: "10.5", status: "matched" });
    const r = await placeBuy({
      userId: 1,
      tokenId: "tok-B",
      price: 0.5,
      usdAmount: 5,
      tickSize: 0.01,
      negRisk: false,
    });
    expect(r.success).toBe(true);
    expect(r.takingAmount).toBe("10.5");
  });

  it("delayed + empty + getOrder always 0 + chain delta also 0 → fok_unfilled", async () => {
    mockClient.createAndPostMarketOrder.mockResolvedValue({
      success: true,
      orderID: "0xkill",
      status: "delayed",
      makingAmount: "",
      takingAmount: "",
      transactionsHashes: [],
    });
    mockClient.getOrder.mockResolvedValue({ size_matched: "0", status: "delayed" });
    // baseline is read first, then "after" is read inside disambiguateDelayedFill.
    // Both should be the same (no chain delta).
    mockClient.getBalanceAllowance.mockImplementation(async (params: { asset_type: string }) => {
      if (params.asset_type === "COLLATERAL") return { balance: "1000000000" };
      return { balance: "0" };
    });
    const r = await placeBuy({
      userId: 1,
      tokenId: "tok-C",
      price: 0.5,
      usdAmount: 5,
      tickSize: 0.01,
      negRisk: false,
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("fok_unfilled");
  });

  it("delayed + empty + chain shares grew (BUY settled async) → success via chain_delta", async () => {
    mockClient.createAndPostMarketOrder.mockResolvedValue({
      success: true,
      orderID: "0xchaindelta",
      status: "delayed",
      makingAmount: "",
      takingAmount: "",
      transactionsHashes: [],
    });
    // getOrder never finds match
    mockClient.getOrder.mockResolvedValue({ size_matched: "0", status: "delayed" });
    // baseline CONDITIONAL = 0; after-poll CONDITIONAL = 5 shares
    let conditionalCalls = 0;
    mockClient.getBalanceAllowance.mockImplementation(async (params: { asset_type: string }) => {
      if (params.asset_type === "COLLATERAL") return { balance: "1000000000" };
      conditionalCalls += 1;
      return { balance: conditionalCalls === 1 ? "0" : "5000000" };
    });
    const r = await placeBuy({
      userId: 1,
      tokenId: "tok-D",
      price: 0.5,
      usdAmount: 5,
      tickSize: 0.01,
      negRisk: false,
    });
    expect(r.success).toBe(true);
    expect(r.takingAmount).toBe("5");
  });

  it("INV-M1 pre-flight: pUSD = 0 → no_pusd reject before placing", async () => {
    mockClient.getBalanceAllowance.mockResolvedValue({ balance: "0" });
    const r = await placeBuy({
      userId: 1,
      tokenId: "tok-E",
      price: 0.5,
      usdAmount: 5,
      tickSize: 0.01,
      negRisk: false,
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("no_pusd");
    expect(mockClient.createAndPostMarketOrder).not.toHaveBeenCalled();
  });
});

describe("placeSell LIVE — INV-M1 cap, dust floor, FOK disambiguation", () => {
  beforeEach(() => {
    mockClient = freshMock();
    vi.stubEnv("DRY_RUN", "false");
    vi.stubEnv("ORDER_DELAYED_POLL_MS", "200");
    vi.stubEnv("ORDER_DELAYED_POLL_INTERVAL_MS", "50");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("INV-M1 cap: chain shares (in micro-units) properly divided by 1e6", async () => {
    // 4.5 shares on chain (= 4_500_000 micro), intent = 5 shares
    mockClient.getBalanceAllowance.mockResolvedValue({ balance: "4500000" });
    mockClient.createAndPostOrder.mockResolvedValue({
      success: true,
      orderID: "0xsell",
      status: "live",
      takingAmount: "1.35",
    });
    const r = await placeSell({
      userId: 1,
      tokenId: "tok-X",
      price: 0.3,
      sizeShares: 5,
      tickSize: 0.01,
      negRisk: false,
      expirationTs: Math.floor(Date.now() / 1000) + 120,
      orderType: "GTD",
    });
    expect(r.success).toBe(true);
    // Verify SDK was called with capped size (4.5), not original 5.
    const args = mockClient.createAndPostOrder.mock.calls[0]?.[0] as { size: number };
    expect(args.size).toBeCloseTo(4.5, 5);
  });

  it("Chain = 0 → no_chain_balance reject, no order placed", async () => {
    mockClient.getBalanceAllowance.mockResolvedValue({ balance: "0" });
    const r = await placeSell({
      userId: 1,
      tokenId: "tok-X",
      price: 0.3,
      sizeShares: 5,
      tickSize: 0.01,
      negRisk: false,
      expirationTs: Math.floor(Date.now() / 1000) + 120,
      orderType: "GTD",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("no_chain_balance");
    expect(mockClient.createAndPostOrder).not.toHaveBeenCalled();
  });

  it("Chain dust < SELL_DUST_FLOOR_SHARES → no_chain_balance (dust_below_floor)", async () => {
    // 0.003 shares on chain (= 3000 micro), default floor 0.1
    mockClient.getBalanceAllowance.mockResolvedValue({ balance: "3000" });
    const r = await placeSell({
      userId: 1,
      tokenId: "tok-X",
      price: 0.3,
      sizeShares: 5,
      tickSize: 0.01,
      negRisk: false,
      expirationTs: Math.floor(Date.now() / 1000) + 120,
      orderType: "GTD",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("no_chain_balance");
    expect(mockClient.createAndPostOrder).not.toHaveBeenCalled();
  });

  it("FOK SELL delayed + empty + chain shares dropped → success via chain_delta", async () => {
    // baseline 10 shares chain; after async settlement, chain = 5
    let calls = 0;
    mockClient.getBalanceAllowance.mockImplementation(async () => {
      calls += 1;
      return { balance: calls === 1 ? "10000000" : "5000000" };
    });
    mockClient.createAndPostMarketOrder.mockResolvedValue({
      success: true,
      orderID: "0xsellfok",
      status: "delayed",
      takingAmount: "",
      transactionsHashes: [],
    });
    mockClient.getOrder.mockResolvedValue({ size_matched: "0", status: "delayed" });
    const r = await placeSell({
      userId: 1,
      tokenId: "tok-X",
      price: 0.3,
      sizeShares: 10,
      tickSize: 0.01,
      negRisk: false,
      expirationTs: Math.floor(Date.now() / 1000) + 120,
      orderType: "FOK",
    });
    expect(r.success).toBe(true);
    expect(r.takingAmount).toBe("5");
  });

  it("GTD path uses createAndPostOrder, FOK uses createAndPostMarketOrder", async () => {
    mockClient.getBalanceAllowance.mockResolvedValue({ balance: "10000000" });
    mockClient.createAndPostOrder.mockResolvedValue({
      success: true,
      orderID: "0xgtd",
      status: "live",
    });
    await placeSell({
      userId: 1,
      tokenId: "tok-X",
      price: 0.3,
      sizeShares: 10,
      tickSize: 0.01,
      negRisk: false,
      expirationTs: Math.floor(Date.now() / 1000) + 120,
      orderType: "GTD",
    });
    expect(mockClient.createAndPostOrder).toHaveBeenCalledOnce();
    expect(mockClient.createAndPostMarketOrder).not.toHaveBeenCalled();
  });
});

describe("cancelOpenOrdersForAsset", () => {
  beforeEach(() => {
    mockClient = freshMock();
    vi.stubEnv("DRY_RUN", "false");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("filters by asset and side; cancels only matches", async () => {
    mockClient.getOpenOrders.mockResolvedValue([
      { id: "o1", asset_id: "A", side: "SELL" },
      { id: "o2", asset_id: "A", side: "BUY" },
      { id: "o3", asset_id: "B", side: "SELL" },
      { id: "o4", asset_id: "A", side: "SELL" },
    ]);
    mockClient.cancelOrder.mockResolvedValue({ success: true });
    const r = await cancelOpenOrdersForAsset("A", "SELL");
    expect(r.cancelled).toBe(2);
    expect(mockClient.cancelOrder).toHaveBeenCalledTimes(2);
  });

  it("survives one cancel failure and reports correct count", async () => {
    mockClient.getOpenOrders.mockResolvedValue([
      { id: "o1", asset_id: "A", side: "SELL" },
      { id: "o2", asset_id: "A", side: "SELL" },
    ]);
    mockClient.cancelOrder
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ success: true });
    const r = await cancelOpenOrdersForAsset("A", "SELL");
    expect(r.cancelled).toBe(1);
  });

  it("supports {results: [...]} response shape", async () => {
    mockClient.getOpenOrders.mockResolvedValue({
      results: [{ id: "o1", asset_id: "A", side: "SELL" }],
    });
    mockClient.cancelOrder.mockResolvedValue({ success: true });
    const r = await cancelOpenOrdersForAsset("A");
    expect(r.cancelled).toBe(1);
  });
});
