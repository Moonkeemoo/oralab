/**
 * Seed the 5 newly-ported filters into strategy_filters for strategy_id=1.
 *
 * Idempotent via ON CONFLICT (strategy_id, filter_name) DO UPDATE SET ...
 * so it is safe to re-run; it also lets us update params in-place when we
 * tune thresholds.
 */
import process from "node:process";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db/client.js";

interface FilterRow {
  readonly name: string;
  readonly params: Record<string, number>;
}

const STRATEGY_ID = 1;

const ROWS: readonly FilterRow[] = [
  { name: "recent_reject_cache", params: { cooldownSec: 60 } },
  { name: "price_collapsed", params: { minPrice: 0.02, maxPrice: 0.98 } },
  { name: "slippage_cap", params: { maxSlippageFrac: 0.10 } },
  { name: "remaining_edge", params: { minEdgeFrac: 0.20 } },
  { name: "drawdown_minimal", params: { minDrawdownPct: -0.05 } },
];

async function seed() {
  const db = getDb();

  for (const row of ROWS) {
    await db.execute(sql`
      INSERT INTO strategy_filters (strategy_id, filter_name, enabled, params)
      VALUES (${STRATEGY_ID}, ${row.name}, true, ${JSON.stringify(row.params)}::jsonb)
      ON CONFLICT (strategy_id, filter_name) DO UPDATE
        SET enabled = EXCLUDED.enabled,
            params = EXCLUDED.params
    `);
    console.log(`[seed] upserted strategy_filters: ${row.name}`);
  }
}

async function main() {
  try {
    await seed();
    console.log("[seed] done");
  } catch (err) {
    console.error("[seed] error:", err);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

await main();
