import fs from "node:fs";
import process from "node:process";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db/client.js";
import { whales } from "../src/db/schema.js";

const FILE =
  process.env["V1_WALLETS"] ??
  `${process.env["HOME"]}/Documents/GitHub/ora-et-labora/output/wallet_profiles.json`;
const STRATEGY_ID = Number(process.env["IMPORT_STRATEGY_ID"] ?? 1);

interface V1Profile {
  classification?: string;
  confidence?: number;
  metrics?: Record<string, number | undefined>;
  domain_breakdown?: Record<string, unknown>;
  per_domain_classification?: Record<string, unknown>;
  last_classified?: number;
  last_activity_ts?: number;
}

async function main(): Promise<void> {
  if (!fs.existsSync(FILE)) {
    console.error(`v1 profiles file not found: ${FILE}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, V1Profile>;
  const total = Object.keys(raw).length;
  console.log(`source ${FILE}: ${total} entries, importing for strategy ${STRATEGY_ID}…`);

  const db = getDb();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let i = 0;
  for (const [addr, prof] of Object.entries(raw)) {
    i += 1;
    const lower = addr.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(lower)) { skipped += 1; continue; }
    const m = prof.metrics ?? {};
    const winRate = Number(m["win_rate"] ?? 0);
    const avgHoldHours = Number(m["avg_hold_hours"] ?? 0);
    const trustScore = winRate * Math.min(avgHoldHours / 24, 1); // bounded heuristic
    const values = {
      classification: String(prof.classification ?? "NOISE"),
      confidence: Number(prof.confidence ?? 0),
      smScore: Number(m["size_escalation_score"] ?? 0),
      trustScore,
      totalTrades: Number(m["total_trades"] ?? 0),
      winRate,
      avgHoldHours,
      directionalRatio: Number(m["directional_ratio"] ?? 0),
      domainBreakdown: (prof.domain_breakdown ?? {}) as Record<string, unknown>,
      perDomainClassification: (prof.per_domain_classification ?? {}) as Record<string, unknown>,
      lastClassifiedAt: prof.last_classified ? new Date(Number(prof.last_classified) * 1000) : null,
      lastActivityAt: prof.last_activity_ts ? new Date(Number(prof.last_activity_ts) * 1000) : null,
    };
    const existing = await db.query.whales.findFirst({
      where: and(eq(whales.strategyId, STRATEGY_ID), eq(whales.address, lower)),
    });
    if (existing) {
      // Preserve `tracked` flag — operator-controlled
      await db.update(whales).set(values).where(eq(whales.id, existing.id));
      updated += 1;
    } else {
      await db.insert(whales).values({ ...values, strategyId: STRATEGY_ID, address: lower, tracked: false });
      inserted += 1;
    }
    if (i % 100 === 0) console.log(`  ${i}/${total}…`);
  }
  console.log(`done: total=${total} inserted=${inserted} updated=${updated} skipped=${skipped}`);
  process.exit(0);
}

await main();
