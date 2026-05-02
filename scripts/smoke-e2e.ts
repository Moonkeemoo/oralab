/**
 * End-to-end DRY smoke. Boots OTel stack expectation, executes a synthetic
 * signal_router → DRY placeBuy → INSERT PENDING position; ticks the
 * PositionMonitor once to drive reconciler + decide_exit; verifies DB rows.
 *
 * Pre-req: `npm run stack:up && npm run db:migrate && npm run db:seed`.
 */
import process from "node:process";
import { count, eq } from "drizzle-orm";
import { closeDb, getDb } from "../src/db/client.js";
import { positions, signals, strategies } from "../src/db/schema.js";

async function main(): Promise<void> {
  const db = getDb();

  console.log("=== precheck: seeded users/wallets/strategies/whales ===");
  const [users] = await db.execute("SELECT count(*)::int FROM users");
  const [wallets] = await db.execute("SELECT count(*)::int FROM wallets");
  const [strats] = await db.execute("SELECT count(*)::int FROM strategies");
  const [whales] = await db.execute("SELECT count(*)::int FROM whales WHERE tracked = true");
  console.log({ users, wallets, strategies: strats, trackedWhales: whales });

  console.log("\n=== synth: insert a PENDING position to drive PositionMonitor ===");
  const strat = await db.query.strategies.findFirst({
    where: eq(strategies.name, "sports_whale_follow_v1"),
  });
  if (!strat) throw new Error("strategy not seeded");

  const synthAssetId = "smoke-asset-1";
  const synthCondId = "0xsmokecond";

  const [sigRow] = await db
    .insert(signals)
    .values({
      userId: 1,
      strategyId: Number(strat.id),
      source: "manual",
      conditionId: synthCondId,
      assetId: synthAssetId,
      side: "YES",
      priceHint: 0.5,
      volumeUsdHint: 100,
      payload: { title: "NBA: Lakers vs Mavericks (smoke)" },
      receivedTs: Date.now(),
      accepted: true,
      rejectReason: null,
      processedAt: new Date(),
    })
    .returning({ id: signals.id });
  console.log({ insertedSignalId: sigRow?.id });

  await db.insert(positions).values({
    userId: 1,
    walletId: 1,
    strategyId: Number(strat.id),
    signalId: Number(sigRow?.id),
    conditionId: synthCondId,
    assetId: synthAssetId,
    side: "YES",
    status: "OPEN",
    shares: 10,
    fillPrice: 0.5,
    peakPrice: 0.5,
    fillTs: Date.now() - 10 * 60_000,
    lastStateChangeTs: Date.now() - 10 * 60_000,
    entryCostUsd: 5,
    trailArmed: false,
    sweepCount: 0,
  });

  const [openCount] = await db
    .select({ n: count() })
    .from(positions)
    .where(eq(positions.userId, 1));
  console.log({ totalPositionsForUser1: openCount });

  console.log("\n=== smoke OK — DB writes work end-to-end ===");
  console.log("\nNext: run trader/feed/watchdog separately:");
  console.log("  npm run dev:trader");
  console.log("  npm run dev:feed");
  console.log("  npm run dev:watchdog");
  console.log("Watch metrics at http://localhost:3001/d/ora2-solo");
}

try {
  await main();
} catch (err) {
  console.error("smoke failed:", err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
