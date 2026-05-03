/**
 * settings — typed loader for calibrator_settings.
 *
 * Mirrors v1 calibrator/settings.py defaults. Values can be overridden via
 * the calibrator_settings DB table (one row per key); missing keys fall
 * back to DEFAULTS. POST /api/calibrator/settings writes individual keys.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { calibratorSettings } from "../db/schema.js";
import { logger } from "../obs/logger.js";

export type CalibratorMode = "manual" | "watch" | "auto";

/**
 * v1-parity defaults. Numbers all in their natural units (seconds, fractions,
 * USD). Mode default = 'watch' per kickoff decision (auto wiring exists but
 * gates on Phase F replay before flipping).
 */
export const DEFAULTS = {
  MIN_LIFT_THRESHOLD: 0.08,
  IMPORTANCE_WIN_RATE: 3,
  IMPORTANCE_PROFIT_FACTOR: 3,
  IMPORTANCE_AVG_PNL: 2,
  IMPORTANCE_PASS_RATE: 1,
  IMPORTANCE_SL_RATE: 2,
  IMPORTANCE_TP_HIT_RATE: 1.5,
  IMPORTANCE_EXIT_EFFICIENCY: 1,
  IMPORTANCE_LEFT_ON_TABLE: 1,
  CF_TRACKING_WINDOW_SEC: 6 * 3600,
  CF_CHECK_INTERVAL_SEC: 5 * 60,
  CF_MAX_PENDING: 1000,
  CAL_RUN_INTERVAL_SEC: 30 * 60,
  CAL_MIN_TRADES: 20,
  CAL_MAX_STEP: 0.15,
  CAL_MAX_RECS: 3,
  CAL_MIN_TRADES_PER_SPORT: 15,
  PER_SPORT_ENABLED: true,
  SPORT_OVERRIDE_MAX_DELTA: 0.5,
  DECAY_HALF_LIFE_SEC: 7 * 86400,
  DECAY_MIN_WEIGHT: 0.05,
  BAYES_STABLE_THRESHOLD: 0.7,
  BAYES_UNCERTAIN_THRESHOLD: 0.5,
  BAYES_AUTO_MIN_CONF: 0.7,
  SAFETY_WR_DROP_ROLLBACK: 0.08,
  SAFETY_VERIFY_TRADES_N: 5,
  SAFETY_VERIFY_TIMEOUT_SEC: 7200,
  MODE: "watch" as CalibratorMode,
} as const;

export type SettingsShape = {
  -readonly [K in keyof typeof DEFAULTS]: typeof DEFAULTS[K];
};

export type SettingKey = keyof SettingsShape;

const NUMERIC_KEYS = new Set<SettingKey>(
  (Object.keys(DEFAULTS) as SettingKey[]).filter((k) => {
    const v = DEFAULTS[k];
    return typeof v === "number";
  }),
);

/**
 * Load all settings: read calibrator_settings rows, overlay onto DEFAULTS.
 * Missing keys → defaults. Type coercion: numeric keys read valueNum;
 * MODE reads valueText. PER_SPORT_ENABLED stored as 1/0 in valueNum.
 */
export async function loadSettings(): Promise<SettingsShape> {
  const out: SettingsShape = { ...DEFAULTS };
  try {
    const db = getDb();
    const rows = await db.select().from(calibratorSettings);
    for (const r of rows) {
      const k = r.key as SettingKey;
      if (!(k in DEFAULTS)) continue;
      if (k === "MODE") {
        const v = r.valueText;
        if (v === "manual" || v === "watch" || v === "auto") {
          out.MODE = v;
        }
        continue;
      }
      if (k === "PER_SPORT_ENABLED") {
        if (typeof r.valueNum === "number") {
          (out as { PER_SPORT_ENABLED: boolean }).PER_SPORT_ENABLED = r.valueNum > 0;
        } else if (r.valueText) {
          (out as { PER_SPORT_ENABLED: boolean }).PER_SPORT_ENABLED = r.valueText === "true";
        }
        continue;
      }
      if (typeof r.valueNum === "number" && NUMERIC_KEYS.has(k)) {
        // Cast through unknown to keep TS happy across the heterogeneous union.
        (out as unknown as Record<string, number>)[k] = r.valueNum;
      }
    }
  } catch (err) {
    logger.warn({ err }, "calibrator settings load failed; using defaults");
  }
  return out;
}

/**
 * Write a single setting. UPSERT on key. Numeric goes to valueNum; MODE goes
 * to valueText; PER_SPORT_ENABLED stored as 1/0 in valueNum. Validates key
 * against DEFAULTS — unknown keys throw so the caller can surface 400.
 */
export async function setSetting(key: SettingKey, value: number | string | boolean): Promise<void> {
  if (!(key in DEFAULTS)) {
    throw new Error(`unknown calibrator setting key: ${String(key)}`);
  }
  const db = getDb();
  let valueNum: number | null = null;
  let valueText: string | null = null;

  if (key === "MODE") {
    if (value !== "manual" && value !== "watch" && value !== "auto") {
      throw new Error(`MODE must be manual|watch|auto, got: ${String(value)}`);
    }
    valueText = value;
  } else if (key === "PER_SPORT_ENABLED") {
    const b = typeof value === "boolean" ? value : value === "true" || value === 1;
    valueNum = b ? 1 : 0;
  } else {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new Error(`${String(key)} must be a finite number, got: ${String(value)}`);
    }
    valueNum = n;
  }

  const existing = await db
    .select()
    .from(calibratorSettings)
    .where(eq(calibratorSettings.key, key))
    .limit(1);
  if (existing[0]) {
    await db
      .update(calibratorSettings)
      .set({ valueNum, valueText, updatedAt: new Date() })
      .where(eq(calibratorSettings.key, key));
  } else {
    await db.insert(calibratorSettings).values({ key, valueNum, valueText });
  }
}

/**
 * Fetch importance map for compute_weights. Pure projection of loaded
 * settings; KPI names match KPI_SPEC keys.
 */
export function importanceMap(settings: SettingsShape): Record<string, number> {
  return {
    win_rate: settings.IMPORTANCE_WIN_RATE,
    profit_factor: settings.IMPORTANCE_PROFIT_FACTOR,
    avg_pnl: settings.IMPORTANCE_AVG_PNL,
    pass_rate: settings.IMPORTANCE_PASS_RATE,
    sl_rate: settings.IMPORTANCE_SL_RATE,
    tp_hit_rate: settings.IMPORTANCE_TP_HIT_RATE,
    exit_efficiency: settings.IMPORTANCE_EXIT_EFFICIENCY,
    left_on_table: settings.IMPORTANCE_LEFT_ON_TABLE,
  };
}
