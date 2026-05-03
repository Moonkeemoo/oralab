import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/client.js";
import { getTrace, logTrace, newCycleId } from "../../src/calibrator/trace.js";

/**
 * Integration test against the local Postgres at $DATABASE_URL. Each test
 * uses a unique cycleId so parallel test runs don't collide; cleanup
 * scrubs only those rows we created.
 */

const TEST_CYCLE_PREFIX = "cyc-test-trace-";
const RUN_TAG = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

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

beforeAll(async () => {
  havDb = await dbAvailable();
});

afterAll(async () => {
  if (havDb) {
    try {
      const db = getDb();
      await db.execute(
        sql`DELETE FROM calibrator_trace WHERE cycle_id LIKE ${`${TEST_CYCLE_PREFIX}${RUN_TAG}%`}`,
      );
    } catch {
      // ignore — best-effort cleanup
    }
  }
  await closeDb();
});

describe("calibrator/trace", () => {
  describe("newCycleId", () => {
    it("returns unique sortable ids", () => {
      const a = newCycleId();
      const b = newCycleId();
      expect(a).toMatch(/^cyc-\d+-[0-9a-f]{4}$/);
      expect(b).toMatch(/^cyc-\d+-[0-9a-f]{4}$/);
      expect(a).not.toBe(b);
    });
  });

  describe("logTrace + getTrace roundtrip", () => {
    it("inserts a row and reads it back by cycleId", async () => {
      if (!havDb) return;
      const cycleId = `${TEST_CYCLE_PREFIX}${RUN_TAG}-roundtrip`;
      await logTrace(cycleId, "cycle_start", { foo: "bar" });
      const rows = await getTrace({ cycleId, limit: 10 });
      expect(rows.length).toBe(1);
      expect(rows[0]?.eventType).toBe("cycle_start");
      expect(rows[0]?.payload).toEqual({ foo: "bar" });
    });

    it("filters by eventType", async () => {
      if (!havDb) return;
      const cycleId = `${TEST_CYCLE_PREFIX}${RUN_TAG}-filter-evt`;
      await logTrace(cycleId, "cycle_start", { a: 1 });
      await logTrace(cycleId, "weights", { w: { x: 1 } });
      await logTrace(cycleId, "cycle_complete", { ok: true });

      const onlyWeights = await getTrace({
        cycleId,
        eventTypes: ["weights"],
        limit: 50,
      });
      expect(onlyWeights.length).toBe(1);
      expect(onlyWeights[0]?.eventType).toBe("weights");
    });

    it("filters by since (epoch ms)", async () => {
      if (!havDb) return;
      const cycleId = `${TEST_CYCLE_PREFIX}${RUN_TAG}-since`;
      await logTrace(cycleId, "cycle_start", { a: 1 });
      const cutoff = Date.now() + 1; // anything after this
      await new Promise((r) => setTimeout(r, 5));
      await logTrace(cycleId, "cycle_complete", { b: 2 });

      const after = await getTrace({ cycleId, since: cutoff, limit: 10 });
      expect(after.every((r) => r.ts >= cutoff)).toBe(true);
      expect(after.find((r) => r.eventType === "cycle_complete")).toBeDefined();
    });

    it("respects limit and orders by ts desc", async () => {
      if (!havDb) return;
      const cycleId = `${TEST_CYCLE_PREFIX}${RUN_TAG}-limit`;
      await logTrace(cycleId, "cycle_start", { i: 0 });
      await logTrace(cycleId, "weights", { i: 1 });
      await logTrace(cycleId, "cycle_complete", { i: 2 });

      const lim2 = await getTrace({ cycleId, limit: 2 });
      expect(lim2.length).toBe(2);
      // newest first
      expect(lim2[0]?.ts).toBeGreaterThanOrEqual(lim2[1]?.ts ?? 0);
    });
  });
});
