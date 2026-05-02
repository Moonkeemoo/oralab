import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { whales } from "../db/schema.js";

/**
 * Given a wallet address, return the strategy_id that's tracking it.
 * Returns null if address is unknown OR is in DB with tracked=false.
 */

interface WhaleMatch {
  readonly strategyId: number;
  readonly classification: string;
  readonly confidence: number;
}

const _cache = new Map<string, WhaleMatch | null>();
const _cacheLoadedAt = { ts: 0 };
const CACHE_TTL_MS = 60_000;

async function loadAll(): Promise<void> {
  const db = getDb();
  const rows = await db.query.whales.findMany({
    where: eq(whales.tracked, true),
  });
  _cache.clear();
  for (const row of rows) {
    _cache.set(row.address.toLowerCase(), {
      strategyId: Number(row.strategyId),
      classification: row.classification,
      confidence: row.confidence,
    });
  }
  _cacheLoadedAt.ts = Date.now();
}

export async function matchWhale(address: string): Promise<WhaleMatch | null> {
  if (Date.now() - _cacheLoadedAt.ts > CACHE_TTL_MS) {
    await loadAll();
  }
  return _cache.get(address.toLowerCase()) ?? null;
}

export async function refreshWhaleCache(): Promise<void> {
  await loadAll();
}

/**
 * Test/admin only — replace cache contents in-process.
 */
export function _setWhaleCache(entries: Iterable<readonly [string, WhaleMatch | null]>): void {
  _cache.clear();
  for (const [k, v] of entries) _cache.set(k.toLowerCase(), v);
  _cacheLoadedAt.ts = Date.now();
}
