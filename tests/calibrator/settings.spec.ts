import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/client.js";
import {
  DEFAULTS,
  importanceMap,
  loadSettings,
  setSetting,
} from "../../src/calibrator/settings.js";

const TEST_KEYS = ["MIN_LIFT_THRESHOLD", "PER_SPORT_ENABLED", "MODE"] as const;

async function dbAvailable(): Promise<boolean> {
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

let havDb = false;
const beforeValues: Record<string, { valueNum: number | null; valueText: string | null } | null> = {};

beforeAll(async () => {
  havDb = await dbAvailable();
  if (havDb) {
    const db = getDb();
    for (const k of TEST_KEYS) {
      const rows = (await db.execute(
        sql`SELECT value_num, value_text FROM calibrator_settings WHERE key = ${k}`,
      )) as unknown as Array<{ value_num: number | null; value_text: string | null }>;
      beforeValues[k] = rows[0]
        ? { valueNum: rows[0].value_num, valueText: rows[0].value_text }
        : null;
    }
  }
});

afterAll(async () => {
  if (havDb) {
    const db = getDb();
    for (const k of TEST_KEYS) {
      const before = beforeValues[k];
      if (before === null) {
        await db.execute(sql`DELETE FROM calibrator_settings WHERE key = ${k}`);
      } else if (before) {
        await db.execute(sql`
          UPDATE calibrator_settings SET value_num = ${before.valueNum}, value_text = ${before.valueText}, updated_at = now() WHERE key = ${k}
        `);
      }
    }
  }
  await closeDb();
});

describe("calibrator/settings", () => {
  it("DEFAULTS round-trip via loadSettings when no rows exist", async () => {
    if (!havDb) return;
    const s = await loadSettings();
    // Sanity checks against canonical defaults from v1.
    expect(s.MIN_LIFT_THRESHOLD).toBe(DEFAULTS.MIN_LIFT_THRESHOLD);
    expect(s.CAL_MIN_TRADES).toBe(DEFAULTS.CAL_MIN_TRADES);
    expect(s.MODE === "manual" || s.MODE === "watch" || s.MODE === "auto").toBe(true);
  });

  it("setSetting overrides numeric key + loadSettings reflects it", async () => {
    if (!havDb) return;
    await setSetting("MIN_LIFT_THRESHOLD", 0.123);
    const s = await loadSettings();
    expect(s.MIN_LIFT_THRESHOLD).toBeCloseTo(0.123, 6);
  });

  it("setSetting persists MODE as text", async () => {
    if (!havDb) return;
    await setSetting("MODE", "manual");
    const s = await loadSettings();
    expect(s.MODE).toBe("manual");
  });

  it("setSetting throws on unknown key", async () => {
    await expect(
      setSetting("NOT_A_KEY" as never, 1),
    ).rejects.toThrow(/unknown calibrator setting/);
  });

  it("setSetting throws on bad MODE value", async () => {
    await expect(
      setSetting("MODE", "yolo"),
    ).rejects.toThrow(/MODE must be/);
  });

  it("setSetting accepts boolean for PER_SPORT_ENABLED", async () => {
    if (!havDb) return;
    await setSetting("PER_SPORT_ENABLED", false);
    const s = await loadSettings();
    expect(s.PER_SPORT_ENABLED).toBe(false);
    await setSetting("PER_SPORT_ENABLED", true);
    const s2 = await loadSettings();
    expect(s2.PER_SPORT_ENABLED).toBe(true);
  });

  describe("importanceMap", () => {
    it("projects settings into KPI_SPEC keys", () => {
      const map = importanceMap({ ...DEFAULTS });
      expect(map["win_rate"]).toBe(DEFAULTS.IMPORTANCE_WIN_RATE);
      expect(map["sl_rate"]).toBe(DEFAULTS.IMPORTANCE_SL_RATE);
      expect(Object.keys(map).length).toBe(8);
    });
  });
});
