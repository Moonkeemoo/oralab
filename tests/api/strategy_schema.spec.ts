import { describe, expect, it } from "vitest";
import {
  validateExitConfigKey,
  validateStrategyParam,
} from "../../src/api/strategy_schema.js";

describe("validateStrategyParam", () => {
  it("accepts valid baseSizeUsd", () => {
    const r = validateStrategyParam("baseSizeUsd", 5);
    expect(r.ok).toBe(true);
  });
  it("rejects negative baseSizeUsd", () => {
    const r = validateStrategyParam("baseSizeUsd", -1);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/positive/i);
  });
  it("rejects unknown key", () => {
    const r = validateStrategyParam("rocketFuel" as never, 5);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown/i);
  });
  it("rejects non-number value", () => {
    const r = validateStrategyParam("baseSizeUsd", "5" as unknown as number);
    expect(r.ok).toBe(false);
  });
});

describe("validateExitConfigKey", () => {
  it("accepts stopLoss in range", () => {
    expect(validateExitConfigKey("stopLoss", -0.15).ok).toBe(true);
  });
  it("rejects stopLoss above 0", () => {
    expect(validateExitConfigKey("stopLoss", 0.05).ok).toBe(false);
  });
  it("rejects stopLoss below -0.99", () => {
    expect(validateExitConfigKey("stopLoss", -1.5).ok).toBe(false);
  });
  it("accepts takeProfit 0..1", () => {
    expect(validateExitConfigKey("takeProfit", 0.2).ok).toBe(true);
  });
  it("rejects unknown exit key", () => {
    expect(validateExitConfigKey("rocket" as never, 1).ok).toBe(false);
  });
});
