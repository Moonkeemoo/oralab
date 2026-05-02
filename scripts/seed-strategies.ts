/**
 * Day 2 seed — solo P1 (Taras only).
 *
 * Idempotent: safe to run multiple times. Uses ON CONFLICT DO NOTHING semantics
 * via drizzle's onConflictDoNothing where unique constraints exist.
 *
 * Reads whale data from local v1 archive at:
 *   ~/Documents/GitHub/oralab-v1-archive-2026-05-02.tar.gz
 *
 * If archive is absent, seeds the 4 confirmed-tracked whales only.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db/client.js";
import { strategies, strategyFilters, users, wallets, whales } from "../src/db/schema.js";

const TARAS_WALLET = "0xba462127e57124acf907f00f87543805d9e7ae62";
const TARAS_TELEGRAM_CHAT_ID = 61804306;

const TRACKED_WHALES: readonly string[] = [
  "0xf25758d6994d6640d6d8388203c4aa8ed4960e87",
  "0xec981ed70ae69c5cbcac08c1ba063e734f6bafcd",
  "0x43372356634781eea88d61bbdd7824cdce958882",
  "0x21ecbb95a15822bbdd4ab71345385a6056d95348",
] as const;

const ARCHIVE_PATH = join(homedir(), "Documents/GitHub/oralab-v1-archive-2026-05-02.tar.gz");
const ARCHIVE_EXTRACT_DIR = "/tmp/oralab-seed-extract";

interface WhaleProfile {
  wallet: string;
  classification?: string;
  confidence?: number;
  last_classified?: number;
  last_activity_ts?: number;
  metrics?: Record<string, unknown>;
  sports_domains?: Record<string, unknown>;
  chain_metrics?: Record<string, unknown>;
}

function loadWhaleUniverse(): {
  tracked: readonly string[];
  profiles: Record<string, WhaleProfile>;
} {
  if (!existsSync(ARCHIVE_PATH)) {
    console.warn(`[seed] no v1 archive at ${ARCHIVE_PATH} — seeding 4 tracked whales only`);
    return { tracked: TRACKED_WHALES, profiles: {} };
  }

  if (existsSync(ARCHIVE_EXTRACT_DIR)) rmSync(ARCHIVE_EXTRACT_DIR, { recursive: true });
  mkdirSync(ARCHIVE_EXTRACT_DIR, { recursive: true });
  execSync(`tar xzf ${ARCHIVE_PATH} -C ${ARCHIVE_EXTRACT_DIR}`);

  const stagingPath = join(ARCHIVE_EXTRACT_DIR, "v1-archive-staging/output");
  const profilesRaw = readFileSync(join(stagingPath, "wallet_profiles.json"), "utf8");
  const profiles = JSON.parse(profilesRaw) as Record<string, WhaleProfile>;

  return { tracked: TRACKED_WHALES, profiles };
}

async function seed() {
  const db = getDb();

  console.log("[seed] users");
  await db
    .insert(users)
    .values({
      id: 1,
      telegramChatId: TARAS_TELEGRAM_CHAT_ID,
      telegramUsername: "Moonkee",
      role: "admin",
      locale: "uk",
    })
    .onConflictDoNothing();
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT MAX(id) FROM users), 1))`,
  );

  console.log("[seed] wallets");
  await db
    .insert(wallets)
    .values({
      id: 1,
      userId: 1,
      address: TARAS_WALLET,
      mode: "env",
      signatureType: 1,
    })
    .onConflictDoNothing();
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('wallets', 'id'), GREATEST((SELECT MAX(id) FROM wallets), 1))`,
  );

  console.log("[seed] strategies");
  await db
    .insert(strategies)
    .values({
      id: 1,
      userId: 1,
      name: "sports_whale_follow_v1",
      kind: "whale_follow",
      enabled: true,
      dryRun: true,
      params: {
        budgetUsd: 100,
        baseSizeUsd: 75,
        maxEntryShares: 10,
        traderAllocation: 1.0,
        entryCooldownSec: 120,
        exitReentryCooldownSec: 225.5,
        ghostWindowSec: 600,
        onchainCacheTtlSec: 5,
        sportsOnly: true,
      },
    })
    .onConflictDoNothing();
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('strategies', 'id'), GREATEST((SELECT MAX(id) FROM strategies), 1))`,
  );

  console.log("[seed] strategy_filters — port v1 hard_safety + non-trivial filters");
  await db
    .insert(strategyFilters)
    .values([
      { strategyId: 1, filterName: "hard_safety", enabled: true, params: {} },
      { strategyId: 1, filterName: "sport_only", enabled: true, params: {} },
      {
        strategyId: 1,
        filterName: "stale_trade",
        enabled: true,
        params: { maxAgeSec: 60 },
      },
      {
        strategyId: 1,
        filterName: "price_too_low",
        enabled: true,
        params: { minPrice: 0.05 },
      },
      {
        strategyId: 1,
        filterName: "time_horizon_too_close",
        enabled: true,
        params: { minHoursToResolution: 1 },
      },
      {
        strategyId: 1,
        filterName: "max_open_positions",
        enabled: true,
        params: { max: 5 },
      },
      {
        strategyId: 1,
        filterName: "drawdown_full_stop",
        enabled: true,
        params: { drawdownPctFullStop: 0.35, drawdownPctReduce: 0.2 },
      },
      {
        strategyId: 1,
        filterName: "total_exposure_cap",
        enabled: true,
        params: { capPctOfBudget: 0.5 },
      },
      {
        strategyId: 1,
        filterName: "whale_size_floor",
        enabled: true,
        params: { minWhaleVolumeUsd: 50 },
      },
    ])
    .onConflictDoNothing();

  console.log("[seed] whales — load v1 archive (or fall back to 4 tracked)");
  const { tracked, profiles } = loadWhaleUniverse();
  const trackedSet = new Set(tracked.map((a) => a.toLowerCase()));

  const whaleRows: Array<typeof whales.$inferInsert> = [];

  for (const addr of tracked) {
    const profile = profiles[addr.toLowerCase()];
    whaleRows.push({
      strategyId: 1,
      address: addr.toLowerCase(),
      label: profile?.classification ? `v1:${profile.classification}` : "p1-tracked",
      classification: profile?.classification ?? "UNCLASSIFIED",
      confidence: profile?.confidence ?? 0,
      tracked: true,
      sportsDomains: (profile?.sports_domains ?? {}) as object,
      chainMetrics: (profile?.chain_metrics ?? profile?.metrics ?? {}) as object,
      lastClassifiedAt: profile?.last_classified ? new Date(profile.last_classified * 1000) : null,
      lastActivityAt: profile?.last_activity_ts ? new Date(profile.last_activity_ts * 1000) : null,
    });
  }

  // Optional: bulk-load wider universe (143 NOISE + 2 active in v1 archive) as tracked=false
  // for later filter-audit + classifier work. Skip duplicates with TRACKED set.
  for (const [addr, p] of Object.entries(profiles)) {
    const lc = addr.toLowerCase();
    if (trackedSet.has(lc)) continue;
    whaleRows.push({
      strategyId: 1,
      address: lc,
      label: `v1:${p.classification ?? "?"}`,
      classification: p.classification ?? "UNCLASSIFIED",
      confidence: p.confidence ?? 0,
      tracked: false,
      sportsDomains: (p.sports_domains ?? {}) as object,
      chainMetrics: (p.chain_metrics ?? p.metrics ?? {}) as object,
      lastClassifiedAt: p.last_classified ? new Date(p.last_classified * 1000) : null,
      lastActivityAt: p.last_activity_ts ? new Date(p.last_activity_ts * 1000) : null,
    });
  }

  const BATCH = 200;
  for (let i = 0; i < whaleRows.length; i += BATCH) {
    await db
      .insert(whales)
      .values(whaleRows.slice(i, i + BATCH))
      .onConflictDoNothing();
  }
  console.log(
    `[seed] inserted up to ${whaleRows.length} whale rows (tracked=${tracked.length}, universe=${whaleRows.length - tracked.length})`,
  );

  if (existsSync(ARCHIVE_EXTRACT_DIR)) rmSync(ARCHIVE_EXTRACT_DIR, { recursive: true });
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
