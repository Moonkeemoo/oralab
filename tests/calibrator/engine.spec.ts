import { describe, expect, it } from "vitest";
import {
  classifyConfidence,
  computeRecommendation,
  extractTunable,
  sortByScore,
} from "../../src/calibrator/engine.js";

describe("calibrator/engine — pure helpers", () => {
  describe("extractTunable", () => {
    it("picks `min` when present", () => {
      expect(extractTunable({ min: 0.5, max: 0.9 })).toEqual({ paramKey: "min", value: 0.5 });
    });

    it("falls back to thresholdProbe when min absent", () => {
      expect(extractTunable({ thresholdProbe: 0.7 })).toEqual({
        paramKey: "thresholdProbe",
        value: 0.7,
      });
    });

    it("returns 0 when no numeric tunable found", () => {
      expect(extractTunable({ enabled: true })).toEqual({ paramKey: "min", value: 0 });
    });

    it("ignores non-finite values", () => {
      expect(extractTunable({ min: Number.NaN, max: 5 })).toEqual({ paramKey: "max", value: 5 });
    });
  });

  describe("classifyConfidence", () => {
    it("returns stable above 50 samples", () => {
      expect(classifyConfidence(51)).toBe("stable");
      expect(classifyConfidence(1000)).toBe("stable");
    });
    it("returns exploring 11-50", () => {
      expect(classifyConfidence(11)).toBe("exploring");
      expect(classifyConfidence(50)).toBe("exploring");
    });
    it("returns low_data <=10", () => {
      expect(classifyConfidence(0)).toBe("low_data");
      expect(classifyConfidence(10)).toBe("low_data");
    });
  });

  describe("computeRecommendation", () => {
    const params = { min: 1.0 };

    it("returns null when no signal at all", () => {
      const r = computeRecommendation("trust_gate", params, new Map(), 0, 0);
      expect(r).toBeNull();
    });

    it("recommends RELAX with positive avg pnl + many rejects", () => {
      const rejects = new Map([["trust_gate", 200]]);
      const r = computeRecommendation("trust_gate", params, rejects, 1.5, 20);
      expect(r).not.toBeNull();
      expect(r?.direction).toBe("relax");
      expect(r?.recommendedValue).toBeCloseTo(0.9, 5);
      // 1.5 * (200 * 0.1) = 30
      expect(r?.liftEstimateUsd).toBeCloseTo(30, 5);
      expect(r?.confidence).toBe("exploring");
      expect(r?.paramKey).toBe("min");
      expect(r?.currentValue).toBe(1.0);
    });

    it("recommends TIGHTEN with negative avg pnl + accepts > 5", () => {
      const rejects = new Map<string, number>();
      const r = computeRecommendation("sm_score", params, rejects, -2, 10);
      expect(r).not.toBeNull();
      expect(r?.direction).toBe("tighten");
      expect(r?.recommendedValue).toBeCloseTo(1.15, 5);
      // |-2| * (10 * 0.2) = 4
      expect(r?.liftEstimateUsd).toBeCloseTo(4, 5);
    });

    it("returns HOLD when avgPnl positive but rejects below threshold", () => {
      const rejects = new Map([["trust_gate", 50]]);
      const r = computeRecommendation("trust_gate", params, rejects, 1.5, 10);
      expect(r?.direction).toBe("hold");
      expect(r?.liftEstimateUsd).toBe(0);
      expect(r?.recommendedValue).toBe(1.0); // unchanged
    });

    it("returns HOLD when avgPnl zero", () => {
      const rejects = new Map([["trust_gate", 200]]);
      const r = computeRecommendation("trust_gate", params, rejects, 0, 10);
      expect(r?.direction).toBe("hold");
    });

    it("returns HOLD when avgPnl negative but too few accepts", () => {
      const r = computeRecommendation("sm_score", params, new Map(), -2, 3);
      // No rejects, no accepts? acceptedCount=3 > 0 so we proceed, but
      // 3 < TIGHTEN_MIN_ACCEPTS=5 → hold.
      // However the null short-circuit fires only when both myRejects==0 AND
      // acceptedCount==0. With acceptedCount=3 and rejects=0, we fall through
      // to HOLD branch.
      expect(r?.direction).toBe("hold");
    });

    it("confidence reflects sample size", () => {
      const rejects = new Map([["trust_gate", 200]]);
      const stable = computeRecommendation("trust_gate", params, rejects, 1.5, 100);
      expect(stable?.confidence).toBe("stable");
      const lowData = computeRecommendation("trust_gate", params, rejects, 1.5, 5);
      expect(lowData?.confidence).toBe("low_data");
    });
  });

  describe("sortByScore", () => {
    it("sorts by liftEstimateUsd descending", () => {
      const recs = [
        { liftEstimateUsd: 5, filterName: "a" },
        { liftEstimateUsd: 20, filterName: "b" },
        { liftEstimateUsd: 10, filterName: "c" },
      ];
      const sorted = sortByScore(recs);
      expect(sorted.map((r) => r.filterName)).toEqual(["b", "c", "a"]);
    });

    it("breaks ties by filterName ascending", () => {
      const recs = [
        { liftEstimateUsd: 5, filterName: "zebra" },
        { liftEstimateUsd: 5, filterName: "apple" },
        { liftEstimateUsd: 5, filterName: "mango" },
      ];
      const sorted = sortByScore(recs);
      expect(sorted.map((r) => r.filterName)).toEqual(["apple", "mango", "zebra"]);
    });

    it("does not mutate input", () => {
      const recs = [
        { liftEstimateUsd: 1, filterName: "a" },
        { liftEstimateUsd: 99, filterName: "b" },
      ];
      const before = recs.slice();
      sortByScore(recs);
      expect(recs).toEqual(before);
    });
  });
});
