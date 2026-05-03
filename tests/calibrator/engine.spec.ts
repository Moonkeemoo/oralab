import { describe, expect, it } from "vitest";
import {
  checklistConditions,
  classifyConfidenceTier,
  countTradesBySport,
} from "../../src/calibrator/engine.js";
import { DEFAULTS } from "../../src/calibrator/settings.js";

/**
 * Pure-helper coverage for the refactored engine. The full runCycle path
 * (counterfactual → bayesian → multi_kpi → rank → persist → apply) is
 * integration-tested via Phase D curl smoke against the live DB; doing it
 * cleanly in vitest would require a much heavier fixture harness than the
 * Phase A pure tests already supply.
 *
 * Replaces the v1 MVP engine.spec.ts (computeRecommendation/extractTunable/
 * sortByScore) — those helpers were folded into the multi_kpi.ts ranker.
 */
describe("calibrator/engine — pure helpers", () => {
  describe("classifyConfidenceTier", () => {
    it("returns stable above BAYES_STABLE_THRESHOLD", () => {
      expect(classifyConfidenceTier(DEFAULTS.BAYES_STABLE_THRESHOLD)).toBe("stable");
      expect(classifyConfidenceTier(0.95)).toBe("stable");
    });
    it("returns exploring above BAYES_UNCERTAIN_THRESHOLD but below stable", () => {
      expect(classifyConfidenceTier(0.5)).toBe("exploring");
      expect(classifyConfidenceTier(0.69)).toBe("exploring");
    });
    it("returns low_data below BAYES_UNCERTAIN_THRESHOLD", () => {
      expect(classifyConfidenceTier(0.1)).toBe("low_data");
      expect(classifyConfidenceTier(0)).toBe("low_data");
    });
  });

  describe("countTradesBySport", () => {
    it("counts per sport and bucket null separately", () => {
      const m = countTradesBySport([
        { sport: "NHL" },
        { sport: "NHL" },
        { sport: "NBA" },
        { sport: null },
      ]);
      expect(m.get("NHL")).toBe(2);
      expect(m.get("NBA")).toBe(1);
      expect(m.get(null)).toBe(1);
    });
    it("returns empty map for empty input", () => {
      expect(countTradesBySport([]).size).toBe(0);
    });
  });

  describe("checklistConditions", () => {
    const baseSettings = { ...DEFAULTS };
    it("manual mode never passes", () => {
      const r = checklistConditions({
        mode: "manual",
        closedTrades: 100,
        topScore: 1,
        daemonAlive: true,
        settings: baseSettings,
      });
      expect(r.ok).toBe(false);
      expect(r.reasons).toContain("mode=manual");
    });
    it("watch mode with sufficient data passes", () => {
      const r = checklistConditions({
        mode: "watch",
        closedTrades: baseSettings.CAL_MIN_TRADES + 10,
        topScore: baseSettings.MIN_LIFT_THRESHOLD + 0.01,
        daemonAlive: true,
        settings: baseSettings,
      });
      expect(r.ok).toBe(true);
      expect(r.reasons).toEqual([]);
    });
    it("trades < CAL_MIN_TRADES fails with reason", () => {
      const r = checklistConditions({
        mode: "watch",
        closedTrades: 1,
        topScore: 1,
        daemonAlive: true,
        settings: baseSettings,
      });
      expect(r.ok).toBe(false);
      expect(r.reasons.some((x) => x.startsWith("trades<"))).toBe(true);
    });
    it("topScore < MIN_LIFT_THRESHOLD fails with reason", () => {
      const r = checklistConditions({
        mode: "watch",
        closedTrades: 100,
        topScore: 0.001,
        daemonAlive: true,
        settings: baseSettings,
      });
      expect(r.ok).toBe(false);
      expect(r.reasons.some((x) => x.startsWith("top_score<"))).toBe(true);
    });
    it("daemon dead fails with reason", () => {
      const r = checklistConditions({
        mode: "watch",
        closedTrades: 100,
        topScore: 1,
        daemonAlive: false,
        settings: baseSettings,
      });
      expect(r.ok).toBe(false);
      expect(r.reasons).toContain("daemon_dead");
    });
    it("auto mode passes when all 4 conditions met", () => {
      const r = checklistConditions({
        mode: "auto",
        closedTrades: 50,
        topScore: 0.5,
        daemonAlive: true,
        settings: baseSettings,
      });
      expect(r.ok).toBe(true);
    });
  });
});
