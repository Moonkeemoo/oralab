/**
 * P3a CLI: shadow-replay against the `decisions` table populated by P2b.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/shadow-replay.ts \
 *     [--since-hours=24] [--max=10000]
 *
 * Reads N most recent rows from `decisions`, reconstructs (PositionView,
 * MarketSnapshot, originalIntent) for each, re-runs decide_exit with the
 * current DEFAULT_EXIT_CONFIG, and prints a ReplayReport. P3a hard gate
 * (per CLAUDE.md week 7): operator inspects the output before authorising
 * any further LIVE migration.
 */
import process from "node:process";
import { desc, gte } from "drizzle-orm";
import { getDb } from "../src/db/client.js";
import { decisions } from "../src/db/schema.js";
import { formatReport, runReplay, type CapturedDecision } from "../src/replay/shadow_replay.js";
import { DEFAULT_EXIT_CONFIG } from "../src/types/decide.js";
import type { MarketSnapshot } from "../src/types/market.js";
import type { PositionView } from "../src/types/position.js";

interface Args {
  sinceHours: number;
  max: number;
}

function parseArgs(): Args {
  const out: Args = { sinceHours: 24, max: 10_000 };
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (!m) continue;
    if (m[1] === "since-hours") out.sinceHours = Number(m[2]);
    else if (m[1] === "max") out.max = Number(m[2]);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const sinceMs = Date.now() - args.sinceHours * 60 * 60 * 1000;
  const db = getDb();

  console.log(`reading up to ${args.max} decisions since ${new Date(sinceMs).toISOString()}…`);
  const rows = await db.query.decisions.findMany({
    where: gte(decisions.ts, sinceMs),
    orderBy: desc(decisions.ts),
    limit: args.max,
  });
  console.log(`loaded ${rows.length} decisions`);
  if (rows.length === 0) {
    console.log(
      "no decisions in window — run trader briefly with P2b enabled to accumulate, then retry.",
    );
    process.exit(0);
  }

  const captured: CapturedDecision[] = rows.map((r) => {
    const snap = r.inputSnapshot as Record<string, unknown>;
    const posShape = snap["position"] as Record<string, unknown>;
    const intent = r.outputIntent as Record<string, unknown>;
    return {
      pos: {
        id: String(r.positionId ?? "unknown"),
        userId: Number(r.userId),
        walletAddress: "0xreplay",
        conditionId: "0xreplay",
        assetId: "0",
        side: "YES",
        status: posShape["status"] as PositionView["status"],
        shares: Number(posShape["shares"] ?? 0),
        onChainShares: Number(posShape["onChainShares"] ?? 0),
        fillPrice: Number(posShape["fillPrice"] ?? 0),
        peakPrice: Number(posShape["peakPrice"] ?? 0),
        fillTs: Number(posShape["fillTs"] ?? 0),
        lastStateChangeTs: Number(posShape["fillTs"] ?? 0),
        trailArmed: Boolean(posShape["trailArmed"] ?? false),
        sweepCount: Number(posShape["sweepCount"] ?? 0),
        reconciliationDriftPct: Number(posShape["reconciliationDriftPct"] ?? 0),
      },
      snap: {
        conditionId: "0xreplay",
        assetId: "0",
        bid: Number(snap["bid"] ?? 0),
        ask: Number(snap["ask"] ?? 0),
        bidSize: 0,
        askSize: 0,
        mark: Number(snap["mark"] ?? 0),
        markSource: snap["markSource"] as MarketSnapshot["markSource"],
        markTs: Number(snap["markTs"] ?? 0),
        tickSize: Number(snap["tickSize"] ?? 0.01),
        negRisk: false,
        minOrderSize: 5,
        expectedOutcomeValue: Number(snap["expectedOutcomeValue"] ?? 0.5),
        acceptingOrders: Boolean(snap["acceptingOrders"] ?? true),
        umaResolutionStatus: snap["umaResolutionStatus"] as MarketSnapshot["umaResolutionStatus"],
        resolved: Boolean(snap["resolved"] ?? false),
        winningOutcomeIndex: null,
        endDateTs: 0,
        fetchedAt: Number(snap["markTs"] ?? 0),
      },
      originalIntent: {
        action: intent["action"] as never,
        price: Number(intent["price"] ?? 0),
        size: Number(intent["size"] ?? 0),
        urgency: intent["urgency"] as never,
        reason: String(intent["reason"] ?? ""),
        gates: ((r.gates as unknown[]) ?? []) as readonly string[],
        snapshotTs: Number(intent["snapshotTs"] ?? 0),
      },
    };
  });

  const report = runReplay(captured, { cfg: DEFAULT_EXIT_CONFIG });
  console.log("\n" + formatReport(report));
  process.exit(0);
}

await main();
