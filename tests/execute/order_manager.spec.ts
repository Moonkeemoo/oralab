import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelByOrderId, placeBuy, placeSell } from "../../src/execute/order_manager.js";

describe("OrderManager — DRY mode (default in P1)", () => {
  beforeEach(() => {
    vi.stubEnv("DRY_RUN", "true");
    vi.stubEnv("KILL_SWITCH", "false");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("placeBuy in DRY returns success without hitting CLOB", async () => {
    const r = await placeBuy({
      userId: 1,
      tokenId: "tok-1",
      price: 0.5,
      sizeShares: 10,
      tickSize: 0.01,
      negRisk: false,
    });
    expect(r.success).toBe(true);
    expect(r.dry).toBe(true);
    expect(r.status).toBe("DRY_RUN");
    expect(r.clientOrderId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("placeSell in DRY returns success without hitting CLOB", async () => {
    const r = await placeSell({
      userId: 1,
      tokenId: "tok-1",
      price: 0.5,
      sizeShares: 10,
      tickSize: 0.01,
      negRisk: false,
      expirationTs: Math.floor(Date.now() / 1000) + 60,
      orderType: "GTD",
    });
    expect(r.success).toBe(true);
    expect(r.dry).toBe(true);
  });

  it("cancelByOrderId in DRY is no-op success", async () => {
    const r = await cancelByOrderId("order-id-stub");
    expect(r.success).toBe(true);
  });

  it("each call generates a fresh client_order_id (idempotency key)", async () => {
    const a = await placeBuy({
      userId: 1,
      tokenId: "tok-1",
      price: 0.5,
      sizeShares: 10,
      tickSize: 0.01,
      negRisk: false,
    });
    const b = await placeBuy({
      userId: 1,
      tokenId: "tok-1",
      price: 0.5,
      sizeShares: 10,
      tickSize: 0.01,
      negRisk: false,
    });
    expect(a.clientOrderId).not.toBe(b.clientOrderId);
  });

  it("KILL_SWITCH=true rejects placeBuy with kill_switch error code", async () => {
    vi.stubEnv("KILL_SWITCH", "true");
    const r = await placeBuy({
      userId: 1,
      tokenId: "tok-1",
      price: 0.5,
      sizeShares: 10,
      tickSize: 0.01,
      negRisk: false,
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("kill_switch");
  });

  it("KILL_SWITCH=true rejects placeSell with kill_switch error code", async () => {
    vi.stubEnv("KILL_SWITCH", "true");
    const r = await placeSell({
      userId: 1,
      tokenId: "tok-1",
      price: 0.5,
      sizeShares: 10,
      tickSize: 0.01,
      negRisk: false,
      expirationTs: Math.floor(Date.now() / 1000) + 60,
      orderType: "GTD",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("kill_switch");
  });
});
