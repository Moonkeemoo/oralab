import { and, eq, like } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { runtimeConfig } from "../db/schema.js";

const CACHE_MS = 2_000;

interface CacheEntry {
  ts: number;
  value: Record<string, unknown>;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(scope: string, prefix: string): string {
  return `${scope}::${prefix}`;
}

export async function getRuntimeConfig(
  scope: string,
  keyPrefix: string,
): Promise<Record<string, unknown>> {
  const k = cacheKey(scope, keyPrefix);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.value;
  let value: Record<string, unknown> = {};
  try {
    const db = getDb();
    const rows = await db.query.runtimeConfig.findMany({
      where: and(eq(runtimeConfig.scope, scope), like(runtimeConfig.key, `${keyPrefix}%`)),
    });
    value = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    value = {};
  }
  cache.set(k, { ts: Date.now(), value });
  return value;
}

export async function setRuntimeConfig(args: {
  scope: string;
  key: string;
  value: unknown;
  setByUserId?: number | null;
}): Promise<void> {
  const db = getDb();
  const existing = await db.query.runtimeConfig.findFirst({
    where: and(eq(runtimeConfig.scope, args.scope), eq(runtimeConfig.key, args.key)),
  });
  if (existing) {
    await db
      .update(runtimeConfig)
      .set({
        value: args.value as object,
        setByUserId: args.setByUserId ?? null,
        setAt: new Date(),
      })
      .where(eq(runtimeConfig.id, existing.id));
  } else {
    await db.insert(runtimeConfig).values({
      scope: args.scope,
      key: args.key,
      value: args.value as object,
      setByUserId: args.setByUserId ?? null,
    });
  }
  for (const k of cache.keys()) {
    const [s, p] = k.split("::");
    if (s === args.scope && args.key.startsWith(p ?? "")) cache.delete(k);
  }
}

export function resetRuntimeConfigCache(): void {
  cache.clear();
}
