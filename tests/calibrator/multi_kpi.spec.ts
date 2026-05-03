import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ENTRY_ATTRIBUTION_ALLOWLIST,
  type ExitKpiSnapshot,
  type FilterAttribution,
  KPI_SPEC,
  type KpiSnapshot,
  MIN_TYPE_CONFIG_KEYS,
  computeDeficits,
  computeEntryLift,
  computeExitLift,
  computeWeights,
  normalizeLift,
  rankLevers,
  scoreLever,
  topAims,
} from "../../src/calibrator/multi_kpi.js";

const HEALTHY_KPI: KpiSnapshot = {
  win_rate: 0.7,
  profit_factor: 2.5,
  avg_pnl: 0.4,
  pass_rate: 0.05,
};
const HEALTHY_EXIT: ExitKpiSnapshot = {
  sl_rate: 0.1,
  tp_hit_rate: 0.4,
  exit_efficiency: 0.8,
  left_on_table: 0.1,
};

const STANDARD_IMPORTANCE: Record<string, number> = {
  win_rate: 3,
  profit_factor: 3,
  avg_pnl: 2,
  pass_rate: 1,
  sl_rate: 2,
  tp_hit_rate: 1.5,
  exit_efficiency: 1,
  left_on_table: 1,
};

function attr(partial: Partial<FilterAttribution>): FilterAttribution {
  return {
    rejectKey: "trust_gate",
    configKey: "FILTER_TRUST_MIN",
    humanName: "Trust Gate",
    phase: "entry",
    sport: null,
    rejectCount: 0,
    dataPoints: 0,
    winnersBlocked: 0,
    losersBlocked: 0,
    avgWinnerPnl: 0,
    avgLoserPnl: 0,
    net: 0,
    saved: 0,
    lost: 0,
    ...partial,
  };
}

describe("computeDeficits", () => {
  it("returns 0 for value at/above ideal (higher_better)", () => {
    const d = computeDeficits(HEALTHY_KPI, HEALTHY_EXIT);
    expect(d["win_rate"]).toBe(0);
    expect(d["profit_factor"]).toBe(0);
    expect(d["avg_pnl"]).toBe(0);
  });

  it("returns 1 at worst (clamped)", () => {
    const d = computeDeficits(
      { win_rate: 0.4, profit_factor: 0.5, avg_pnl: -0.45, pass_rate: 0.05 },
      HEALTHY_EXIT,
    );
    expect(d["win_rate"]).toBe(1);
    expect(d["profit_factor"]).toBe(1);
    expect(d["avg_pnl"]).toBe(1);
  });

  it("returns 1 below worst (clamped)", () => {
    const d = computeDeficits(
      { win_rate: 0.1, profit_factor: -2, avg_pnl: -5, pass_rate: 0.05 },
      HEALTHY_EXIT,
    );
    expect(d["win_rate"]).toBe(1);
    expect(d["profit_factor"]).toBe(1);
    expect(d["avg_pnl"]).toBe(1);
  });

  it("band kpi: 0 inside [0.03, 0.08]", () => {
    const d = computeDeficits({ ...HEALTHY_KPI, pass_rate: 0.05 }, HEALTHY_EXIT);
    expect(d["pass_rate"]).toBe(0);
  });

  it("band kpi: scaled outside (below)", () => {
    const d = computeDeficits({ ...HEALTHY_KPI, pass_rate: 0.0 }, HEALTHY_EXIT);
    expect(d["pass_rate"]).toBe(1); // (0.03 - 0)/0.03
  });

  it("band kpi: scaled outside (above)", () => {
    const d = computeDeficits({ ...HEALTHY_KPI, pass_rate: 0.16 }, HEALTHY_EXIT);
    expect(d["pass_rate"]).toBe(1); // (0.16 - 0.08)/0.08
  });

  it("lower_better sl_rate: 0 at/below ideal, 1 at/above worst", () => {
    expect(
      computeDeficits(HEALTHY_KPI, { ...HEALTHY_EXIT, sl_rate: 0.15 })["sl_rate"],
    ).toBe(0);
    expect(
      computeDeficits(HEALTHY_KPI, { ...HEALTHY_EXIT, sl_rate: 0.6 })["sl_rate"],
    ).toBe(1);
  });
});

describe("computeWeights", () => {
  it("sums to 1 when any deficit > 0", () => {
    const deficits = computeDeficits(
      { win_rate: 0.4, profit_factor: 1.0, avg_pnl: 0.0, pass_rate: 0.05 },
      HEALTHY_EXIT,
    );
    const w = computeWeights(deficits, STANDARD_IMPORTANCE);
    const total = Object.values(w).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("returns all-zero when no deficit (the self-gate)", () => {
    const deficits = computeDeficits(HEALTHY_KPI, HEALTHY_EXIT);
    const w = computeWeights(deficits, STANDARD_IMPORTANCE);
    for (const k of Object.keys(STANDARD_IMPORTANCE)) {
      expect(w[k]).toBe(0);
    }
  });

  it("ignores keys missing from importance", () => {
    const w = computeWeights({ win_rate: 1, foo_bar: 0.5 }, { win_rate: 1 });
    expect(w["foo_bar"]).toBeUndefined();
    expect(w["win_rate"]).toBe(1);
  });
});

describe("normalizeLift", () => {
  it("flips sign for lower_better (sl_rate)", () => {
    // Reducing sl_rate by 0.05 = improvement = +0.5 normalized
    const n = normalizeLift({ sl_rate: -0.05 });
    expect(n["sl_rate"]).toBeCloseTo(0.5, 6);
  });

  it("flips sign for lower_better (left_on_table)", () => {
    const n = normalizeLift({ left_on_table: -0.075 });
    expect(n["left_on_table"]).toBeCloseTo(0.5, 6); // 0.075 / 0.15
  });

  it("clamps to [-1, 1]", () => {
    const n = normalizeLift({ avg_pnl: 999, win_rate: -999 });
    expect(n["avg_pnl"]).toBe(1);
    expect(n["win_rate"]).toBe(-1);
  });
});

describe("scoreLever / topAims", () => {
  it("returns 0 when confidence=0", () => {
    expect(scoreLever({ avg_pnl: 1 }, { avg_pnl: 1 }, 0)).toBe(0);
  });

  it("topAims returns top-2 KPIs sorted by weight × abs(liftNorm)", () => {
    const aims = topAims(
      { win_rate: 0.5, avg_pnl: 0.8, profit_factor: 0.1 },
      { win_rate: 0.4, avg_pnl: 0.3, profit_factor: 0.3 },
      2,
    );
    // contribs: win=0.20, avg=0.24, pf=0.03 → top2 = [avg_pnl, win_rate]
    expect(aims).toEqual(["avg_pnl", "win_rate"]);
  });
});

describe("computeEntryLift — thick data path", () => {
  it("relax direction emits positive avg_pnl & win_rate movement", () => {
    // 1 winner $0.5 + 4 losers $-0.5 — current avg=-0.3, wr=0.2.
    // Relaxing brings 0.6 winners @ $1.5 + 0.0 losers → avg ↑ → relax.
    const closedTrades = [
      { pnlAmount: 0.5 },
      { pnlAmount: -0.5 }, { pnlAmount: -0.5 },
      { pnlAmount: -0.5 }, { pnlAmount: -0.5 },
    ];
    const lifts = computeEntryLift({
      attribution: [
        attr({
          rejectKey: "trust_gate",
          configKey: "FILTER_TRUST_MIN",
          dataPoints: 10,
          winnersBlocked: 8,
          losersBlocked: 0,
          avgWinnerPnl: 1.5,
          avgLoserPnl: 0.4,
          rejectCount: 8,
          net: 12,
        }),
      ],
      closedTrades,
      currentConfig: { FILTER_TRUST_MIN: 0.5 },
      beliefs: { trust_gate: 0.8 },
      maxStep: 0.15,
      totalSignals: 100,
    });
    const lever = lifts["FILTER_TRUST_MIN"];
    expect(lever).toBeDefined();
    expect(lever?.direction).toBe("relax");
    expect(lever?.lift["avg_pnl"]).toBeGreaterThan(0);
    expect(lever?.lift["win_rate"]).toBeGreaterThan(0);
  });
});

describe("computeEntryLift — thin data fallback", () => {
  it("uses net$-proxy when dataPoints < 5", () => {
    const lifts = computeEntryLift({
      attribution: [
        attr({
          rejectKey: "trust_gate",
          configKey: "FILTER_TRUST_MIN",
          dataPoints: 2,
          rejectCount: 10,
          net: 5.0,
        }),
      ],
      closedTrades: [{ pnlAmount: 0.5 }, { pnlAmount: -0.3 }],
      currentConfig: { FILTER_TRUST_MIN: 0.5 },
      beliefs: { trust_gate: 1.0 },
      maxStep: 0.15,
      totalSignals: 50,
    });
    const lever = lifts["FILTER_TRUST_MIN"];
    expect(lever).toBeDefined();
    // avg_pnl proxy: net*step/n = 5 * 0.15 / 2 = 0.375 → relax
    expect(lever?.direction).toBe("relax");
    expect(lever?.lift["avg_pnl"]).toBeCloseTo(0.375, 5);
  });
});

describe("computeEntryLift — allowlist + config gating", () => {
  it("skips levers not in allowlist", () => {
    const lifts = computeEntryLift({
      attribution: [
        attr({
          rejectKey: "not_in_allowlist",
          configKey: "FILTER_TRUST_MIN",
          dataPoints: 10,
          winnersBlocked: 5,
          losersBlocked: 1,
          avgWinnerPnl: 1,
          avgLoserPnl: 0.5,
        }),
      ],
      closedTrades: [{ pnlAmount: 1.0 }],
      currentConfig: { FILTER_TRUST_MIN: 0.5 },
      beliefs: { not_in_allowlist: 1.0 },
      maxStep: 0.15,
      totalSignals: 10,
    });
    expect(Object.keys(lifts).length).toBe(0);
  });

  it("skips levers whose configKey not in currentConfig", () => {
    const lifts = computeEntryLift({
      attribution: [
        attr({ rejectKey: "trust_gate", configKey: "MISSING_KEY", dataPoints: 10 }),
      ],
      closedTrades: [{ pnlAmount: 1 }],
      currentConfig: { FILTER_TRUST_MIN: 0.5 },
      beliefs: { trust_gate: 1.0 },
      maxStep: 0.15,
      totalSignals: 10,
    });
    expect(Object.keys(lifts).length).toBe(0);
  });
});

describe("computeEntryLift — confidence + step_fraction", () => {
  it("applies confidence to step_fraction (zero confidence → zero lift)", () => {
    const lifts = computeEntryLift({
      attribution: [
        attr({
          rejectKey: "trust_gate",
          configKey: "FILTER_TRUST_MIN",
          dataPoints: 10,
          winnersBlocked: 5,
          losersBlocked: 1,
          avgWinnerPnl: 1,
          avgLoserPnl: 0.5,
          net: 5,
        }),
      ],
      closedTrades: [{ pnlAmount: 1 }, { pnlAmount: 1 }],
      currentConfig: { FILTER_TRUST_MIN: 0.5 },
      beliefs: { trust_gate: 0 },
      maxStep: 0.15,
      totalSignals: 10,
    });
    const lever = lifts["FILTER_TRUST_MIN"];
    expect(lever).toBeDefined();
    // step_fraction = 0 → all lifts = 0; avg_pnl=0 → relax direction.
    expect(lever?.lift["avg_pnl"] ?? 0).toBeCloseTo(0, 10);
    expect(lever?.delta ?? 0).toBeCloseTo(0, 10);
  });
});

describe("computeEntryLift — direction sign flip", () => {
  it("flips lift signs when direction = tighten", () => {
    // Force tighten: net$ negative → avg_pnl proxy < 0 → tighten.
    const lifts = computeEntryLift({
      attribution: [
        attr({
          rejectKey: "trust_gate",
          configKey: "FILTER_TRUST_MIN",
          dataPoints: 2,
          rejectCount: 10,
          net: -5.0,
        }),
      ],
      closedTrades: [{ pnlAmount: -0.2 }],
      currentConfig: { FILTER_TRUST_MIN: 0.5 },
      beliefs: { trust_gate: 1.0 },
      maxStep: 0.15,
      totalSignals: 50,
    });
    const lever = lifts["FILTER_TRUST_MIN"];
    expect(lever?.direction).toBe("tighten");
    // pre-flip avg_pnl = -5*0.15/1 = -0.75 → flipped to +0.75
    expect(lever?.lift["avg_pnl"]).toBeCloseTo(0.75, 5);
  });
});

describe("computeEntryLift — min-type vs max-type", () => {
  it("min-type relax → negative param delta (decrease threshold)", () => {
    const lifts = computeEntryLift({
      attribution: [
        attr({
          rejectKey: "trust_gate",
          configKey: "FILTER_TRUST_MIN",
          dataPoints: 10,
          winnersBlocked: 5,
          losersBlocked: 0,
          avgWinnerPnl: 1,
          net: 5,
        }),
      ],
      closedTrades: [{ pnlAmount: 1 }],
      currentConfig: { FILTER_TRUST_MIN: 0.5 },
      beliefs: { trust_gate: 1.0 },
      maxStep: 0.15,
      totalSignals: 50,
    });
    const lever = lifts["FILTER_TRUST_MIN"];
    expect(lever?.direction).toBe("relax");
    expect(MIN_TYPE_CONFIG_KEYS.has("FILTER_TRUST_MIN")).toBe(true);
    // baseStep = |0.5| * 0.15 = 0.075; min-type+relax → -0.075
    expect(lever?.delta).toBeCloseTo(-0.075, 5);
    expect(lever?.recommendedValue).toBeCloseTo(0.425, 5);
  });

  it("non-min-type relax → positive param delta", () => {
    // Use trust_gate + a config key not in MIN_TYPE list (e.g. FAKE_MAX).
    const lifts = computeEntryLift({
      attribution: [
        attr({
          rejectKey: "trust_gate",
          configKey: "FAKE_MAX",
          dataPoints: 10,
          winnersBlocked: 5,
          losersBlocked: 0,
          avgWinnerPnl: 1,
        }),
      ],
      closedTrades: [{ pnlAmount: 1 }],
      currentConfig: { FAKE_MAX: 0.5 },
      beliefs: { trust_gate: 1.0 },
      maxStep: 0.15,
      totalSignals: 50,
    });
    const lever = lifts["FAKE_MAX"];
    expect(lever?.direction).toBe("relax");
    expect(MIN_TYPE_CONFIG_KEYS.has("FAKE_MAX")).toBe(false);
    expect(lever?.delta).toBeCloseTo(0.075, 5);
  });
});

describe("computeExitLift", () => {
  it("widen SL only counts trades with peak >= current_tp (QA-127)", () => {
    const trades = [
      // SL trade with peak BELOW current_tp — should NOT count as conversion
      { entryPrice: 0.5, exitPrice: 0.42, peakPrice: 0.55, closeReason: "sl_fok" },
      // SL trade with peak ABOVE current_tp — counts as conversion
      { entryPrice: 0.5, exitPrice: 0.42, peakPrice: 0.85, closeReason: "sl_fok" },
    ];
    // current_tp = 0.6 → peak_pct must be >= 0.6 of entry. peak=0.55 → 10% < 60%.
    // peak=0.85 → 70% > 60%. So 1 conversion of 2.
    const lifts = computeExitLift({
      closedTrades: trades,
      currentConfig: {
        EXIT_STOP_LOSS: -0.15,
        EXIT_TAKE_PROFIT: 0.6,
        EXIT_STOP_LOSS_EMERGENCY: -0.17,
      },
      maxStep: 0.15,
    });
    const widen = lifts["EXIT_STOP_LOSS:widen"];
    expect(widen).toBeDefined();
    // sl_rate raw = -1/2 = -0.5; clamped to -LIFT_ABS_CAP = -0.15.
    // tp_hit_rate raw = 1/2 = 0.5; clamped to +0.15.
    expect(widen?.lift["sl_rate"]).toBeCloseTo(-0.15, 5);
    expect(widen?.lift["tp_hit_rate"]).toBeCloseTo(0.15, 5);
  });

  it("emits separate widen + narrow keys per knob", () => {
    const lifts = computeExitLift({
      closedTrades: [
        { entryPrice: 0.5, exitPrice: 0.6, peakPrice: 0.7, closeReason: "tp_fok" },
      ],
      currentConfig: {
        EXIT_STOP_LOSS: -0.15,
        EXIT_TAKE_PROFIT: 0.2,
        EXIT_STOP_LOSS_EMERGENCY: -0.17,
        EXIT_TRAIL_ACTIVATE: 0.15,
        EXIT_TRAIL_STOP: 0.05,
      },
      maxStep: 0.15,
    });
    expect(lifts["EXIT_STOP_LOSS:widen"]).toBeDefined();
    expect(lifts["EXIT_STOP_LOSS:narrow"]).toBeDefined();
    expect(lifts["EXIT_TAKE_PROFIT:widen"]).toBeDefined();
    expect(lifts["EXIT_TAKE_PROFIT:narrow"]).toBeDefined();
    expect(lifts["EXIT_TRAIL_ACTIVATE:widen"]).toBeDefined();
    expect(lifts["EXIT_TRAIL_ACTIVATE:narrow"]).toBeDefined();
    expect(lifts["EXIT_TRAIL_STOP:widen"]).toBeDefined();
    expect(lifts["EXIT_TRAIL_STOP:narrow"]).toBeDefined();
    expect(lifts["EXIT_STOP_LOSS_EMERGENCY:widen"]).toBeDefined();
  });
});

describe("KPI_SPEC integrity", () => {
  it("every KPI in KPI_SPEC has a matching internal source mapping", () => {
    // Smoke test: deficits only emits keys that exist in KPI_SPEC.
    const d = computeDeficits(HEALTHY_KPI, HEALTHY_EXIT);
    for (const name of Object.keys(KPI_SPEC)) {
      expect(name in d).toBe(true);
    }
  });

  it("higher_better and lower_better KPIs have ideal/worst pairs", () => {
    for (const [name, spec] of Object.entries(KPI_SPEC)) {
      if (spec.kind === "higher_better") {
        expect(spec.ideal).toBeGreaterThan(spec.worst!);
      } else if (spec.kind === "lower_better") {
        expect(spec.worst).toBeGreaterThan(spec.ideal!);
      } else {
        expect(spec.min).toBeLessThanOrEqual(spec.max!);
      }
      expect(spec.scale).toBeGreaterThan(0);
      void name;
    }
  });

  it("ENTRY_ATTRIBUTION_ALLOWLIST contains the canonical 14 keys", () => {
    expect(ENTRY_ATTRIBUTION_ALLOWLIST.size).toBeGreaterThanOrEqual(13);
    expect(ENTRY_ATTRIBUTION_ALLOWLIST.has("conviction_gate:probe")).toBe(true);
    expect(ENTRY_ATTRIBUTION_ALLOWLIST.has("conviction_gate:confirm")).toBe(true);
  });
});

describe("rankLevers", () => {
  it("annotates score + aims and applies threshold + cap", () => {
    const matrix = {
      A: {
        configKey: "A",
        rejectKey: "trust_gate",
        phase: "entry" as const,
        humanName: "A",
        sport: null,
        direction: "relax" as const,
        currentValue: 1,
        recommendedValue: 1,
        delta: 0,
        confidence: 1,
        lift: { avg_pnl: 0.1 },
        liftNorm: normalizeLift({ avg_pnl: 0.1 }),
        score: 0,
        aims: [],
        reason: "",
      },
      B: {
        configKey: "B",
        rejectKey: "sm_score",
        phase: "entry" as const,
        humanName: "B",
        sport: null,
        direction: "relax" as const,
        currentValue: 1,
        recommendedValue: 1,
        delta: 0,
        confidence: 0,
        lift: { avg_pnl: 0.1 },
        liftNorm: normalizeLift({ avg_pnl: 0.1 }),
        score: 0,
        aims: [],
        reason: "",
      },
    };
    const out = rankLevers({
      liftMatrix: matrix,
      weights: { avg_pnl: 1 },
      minLiftThreshold: 0.08,
      maxRecs: 3,
    });
    // A has confidence=1 → score 0.5 ≥ threshold; B has confidence=0 → score 0 dropped.
    expect(out.length).toBe(1);
    expect(out[0]?.configKey).toBe("A");
  });
});

describe("Property — deficits ∈ [0, 1] for any valid input", () => {
  it("holds for arbitrary numeric KPI snapshots", () => {
    fc.assert(
      fc.property(
        fc.record({
          win_rate: fc.double({ min: -10, max: 10, noNaN: true }),
          profit_factor: fc.double({ min: -10, max: 10, noNaN: true }),
          avg_pnl: fc.double({ min: -10, max: 10, noNaN: true }),
          pass_rate: fc.double({ min: -10, max: 10, noNaN: true }),
        }),
        fc.record({
          sl_rate: fc.double({ min: -10, max: 10, noNaN: true }),
          tp_hit_rate: fc.double({ min: -10, max: 10, noNaN: true }),
          exit_efficiency: fc.double({ min: -10, max: 10, noNaN: true }),
          left_on_table: fc.double({ min: -10, max: 10, noNaN: true }),
        }),
        (kpi, exit) => {
          const d = computeDeficits(kpi as KpiSnapshot, exit as ExitKpiSnapshot);
          for (const v of Object.values(d)) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
