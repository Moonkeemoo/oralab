import { describe, expect, it } from "vitest";
import {
  hypotheticalSizeUsd,
  normalizeRejectKey,
  perKeyQuota,
  splitConvictionGate,
} from "../../src/calibrator/counterfactual.js";

/**
 * Pure helpers — DB-touching paths are integration-tested elsewhere (Phase D
 * curl smoke). These cover the splitting/normalization/quota math that v1
 * counterfactual.py inlined into record_rejections().
 */
describe("calibrator/counterfactual — pure helpers", () => {
  describe("normalizeRejectKey", () => {
    it("passes through canonical keys unchanged", () => {
      expect(normalizeRejectKey("trust_gate")).toBe("trust_gate");
      expect(normalizeRejectKey("market_volume")).toBe("market_volume");
    });
    it("returns 'unknown' for empty input", () => {
      expect(normalizeRejectKey("")).toBe("unknown");
    });
  });

  describe("splitConvictionGate", () => {
    it("splits conviction_gate by intent_level", () => {
      expect(splitConvictionGate("conviction_gate", "probe")).toBe("conviction_gate:probe");
      expect(splitConvictionGate("conviction_gate", "confirm")).toBe("conviction_gate:confirm");
      expect(splitConvictionGate("conviction_gate", "conviction")).toBe(
        "conviction_gate:conviction",
      );
    });
    it("is case-insensitive on intent", () => {
      expect(splitConvictionGate("conviction_gate", "PROBE")).toBe("conviction_gate:probe");
      expect(splitConvictionGate("conviction_gate", "Confirm")).toBe("conviction_gate:confirm");
    });
    it("falls back to base key when intent_level is missing or unknown", () => {
      expect(splitConvictionGate("conviction_gate", null)).toBe("conviction_gate");
      expect(splitConvictionGate("conviction_gate", undefined)).toBe("conviction_gate");
      expect(splitConvictionGate("conviction_gate", "weird")).toBe("conviction_gate");
    });
    it("does not split non-conviction keys", () => {
      expect(splitConvictionGate("trust_gate", "probe")).toBe("trust_gate");
      expect(splitConvictionGate("market_volume", "confirm")).toBe("market_volume");
    });
  });

  describe("perKeyQuota", () => {
    it("returns floor of maxPending/6 when above the floor", () => {
      expect(perKeyQuota(1000)).toBe(166); // 1000/6=166
      expect(perKeyQuota(600)).toBe(100);
    });
    it("clamps to MIN_PER_KEY_QUOTA (30) for small caps", () => {
      expect(perKeyQuota(100)).toBe(30);
      expect(perKeyQuota(60)).toBe(30);
      expect(perKeyQuota(0)).toBe(30);
    });
  });

  describe("hypotheticalSizeUsd", () => {
    it("uses baseSizeUsd × convictionScore when both present", () => {
      expect(
        hypotheticalSizeUsd({ baseSizeUsd: 10, convictionScore: 0.8 }),
      ).toBeCloseTo(8, 6);
    });
    it("treats missing convictionScore as 1.0", () => {
      expect(hypotheticalSizeUsd({ baseSizeUsd: 5 })).toBeCloseTo(5, 6);
      expect(hypotheticalSizeUsd({ baseSizeUsd: 5, convictionScore: null })).toBeCloseTo(5, 6);
    });
    it("falls back to median entry when baseSizeUsd is invalid", () => {
      expect(
        hypotheticalSizeUsd({
          baseSizeUsd: 0,
          fallbackMedianEntryUsd: 7.5,
        }),
      ).toBeCloseTo(7.5, 6);
    });
    it("returns 1.0 default when no usable inputs", () => {
      expect(hypotheticalSizeUsd({ baseSizeUsd: 0 })).toBe(1.0);
      expect(
        hypotheticalSizeUsd({ baseSizeUsd: Number.NaN, fallbackMedianEntryUsd: null }),
      ).toBe(1.0);
    });
  });
});
