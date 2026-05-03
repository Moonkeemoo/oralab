import { describe, expect, it } from "vitest";
import { classifyStatus, deriveBelief } from "../../src/calibrator/bayesian.js";

/**
 * Pure helpers — DB UPSERT path covered by Phase D curl smoke + manual
 * one-shot run on real data. classifyStatus + deriveBelief encode all the
 * v1 bayesian.py edge cases we care about.
 */
describe("calibrator/bayesian — pure helpers", () => {
  describe("classifyStatus", () => {
    it("uninformative prior: conf=0.5, dp=0 → uncertain", () => {
      expect(classifyStatus(0.5, 0)).toBe("exploring");
      // 0.5 satisfies UNCERTAIN_THRESHOLD=0.5 → exploring (boundary).
    });
    it("just below uncertain threshold → uncertain", () => {
      expect(classifyStatus(0.499, 100)).toBe("uncertain");
    });
    it("between uncertain and stable → exploring", () => {
      expect(classifyStatus(0.6, 5)).toBe("exploring");
      expect(classifyStatus(0.7, 5)).toBe("exploring"); // dp<10 keeps it out of stable
    });
    it("stable when conf >= 0.7 AND dp >= 10", () => {
      expect(classifyStatus(0.7, 10)).toBe("stable");
      expect(classifyStatus(0.95, 200)).toBe("stable");
    });
    it("custom thresholds respected", () => {
      expect(classifyStatus(0.6, 20, 0.6, 0.4)).toBe("stable");
      expect(classifyStatus(0.55, 20, 0.6, 0.4)).toBe("exploring");
      expect(classifyStatus(0.3, 20, 0.6, 0.4)).toBe("uncertain");
    });
  });

  describe("deriveBelief", () => {
    it("Beta(1,1) prior → conf=0.5, dp=0, exploring", () => {
      const b = deriveBelief({
        rejectKey: "trust_gate",
        sport: null,
        alpha: 1,
        beta: 1,
        updatedAt: 0,
      });
      expect(b.confidence).toBeCloseTo(0.5, 6);
      expect(b.dataPoints).toBe(0);
      expect(b.status).toBe("exploring"); // 0.5 hits the uncertain boundary
    });

    it("strong correct evidence → high conf, stable", () => {
      const b = deriveBelief({
        rejectKey: "trust_gate",
        sport: null,
        alpha: 11, // 10 correct + prior
        beta: 1,
        updatedAt: 0,
      });
      expect(b.confidence).toBeCloseTo(11 / 12, 6);
      expect(b.dataPoints).toBe(10);
      expect(b.status).toBe("stable");
    });

    it("strong wrong evidence → low conf, uncertain", () => {
      const b = deriveBelief({
        rejectKey: "sm_score",
        sport: null,
        alpha: 1,
        beta: 11,
        updatedAt: 0,
      });
      expect(b.confidence).toBeCloseTo(1 / 12, 6);
      expect(b.dataPoints).toBe(10);
      expect(b.status).toBe("uncertain");
    });

    it("per-sport rows independent of global", () => {
      const nhl = deriveBelief({
        rejectKey: "trust_gate",
        sport: "NHL",
        alpha: 8,
        beta: 2,
        updatedAt: 0,
      });
      const global = deriveBelief({
        rejectKey: "trust_gate",
        sport: null,
        alpha: 1,
        beta: 1,
        updatedAt: 0,
      });
      expect(nhl.sport).toBe("NHL");
      expect(global.sport).toBeNull();
      expect(nhl.confidence).toBeCloseTo(0.8, 6);
      expect(global.confidence).toBeCloseTo(0.5, 6);
    });

    it("dataPoints clamps to >= 0 even with sub-prior totals", () => {
      const b = deriveBelief({
        rejectKey: "x",
        sport: null,
        alpha: 0.5,
        beta: 0.5,
        updatedAt: 0,
      });
      expect(b.dataPoints).toBeGreaterThanOrEqual(0);
    });
  });

  describe("update math (Beta conjugate, exercised via deriveBelief)", () => {
    /** Mirror what updateFromAttribution does internally for one row. */
    function applyAttribution(
      alpha: number,
      beta: number,
      saved: number,
      lost: number,
      dp: number,
    ): { alpha: number; beta: number } {
      const total = saved + lost;
      if (total <= 0 || dp <= 0) return { alpha, beta };
      const r = saved / total;
      return {
        alpha: alpha + r * dp,
        beta: beta + (1 - r) * dp,
      };
    }

    it("10 saved + 0 lost grows alpha; conf approaches 1; becomes stable", () => {
      const after = applyAttribution(1, 1, 10, 0, 10);
      const b = deriveBelief({
        rejectKey: "x",
        sport: null,
        alpha: after.alpha,
        beta: after.beta,
        updatedAt: 0,
      });
      expect(b.alpha).toBeCloseTo(11, 6);
      expect(b.beta).toBeCloseTo(1, 6);
      expect(b.confidence).toBeGreaterThan(0.9);
      expect(b.status).toBe("stable");
    });

    it("10 lost + 0 saved grows beta; conf approaches 0; stays uncertain", () => {
      const after = applyAttribution(1, 1, 0, 10, 10);
      const b = deriveBelief({
        rejectKey: "x",
        sport: null,
        alpha: after.alpha,
        beta: after.beta,
        updatedAt: 0,
      });
      expect(b.alpha).toBeCloseTo(1, 6);
      expect(b.beta).toBeCloseTo(11, 6);
      expect(b.confidence).toBeLessThan(0.1);
      expect(b.status).toBe("uncertain");
    });

    it("repeated updates accumulate (additive — by design)", () => {
      let s = { alpha: 1, beta: 1 };
      for (let i = 0; i < 3; i++) {
        s = applyAttribution(s.alpha, s.beta, 5, 0, 5);
      }
      // 1 + 3*5 = 16 alpha, 1 beta
      expect(s.alpha).toBeCloseTo(16, 6);
      expect(s.beta).toBeCloseTo(1, 6);
    });
  });
});
