import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { killSwitches } from "../db/schema.js";

/**
 * DB-backed runtime kill-switch (separate from KILL_SWITCH env var which
 * is checked at process boot only). Bot commands `/pause` and `/resume`
 * insert / clear rows in `kill_switches` with scope=global.
 *
 * `isRuntimeKillSwitchActive()` is cached for KS_CACHE_MS to avoid hot-
 * loop DB hits on every placeBuy. Trader picks up changes within ~2s.
 */

const SCOPE_GLOBAL = "global";
const KS_CACHE_MS = 2_000;

let cached: { value: boolean; ts: number } = { value: false, ts: 0 };

export async function isRuntimeKillSwitchActive(): Promise<boolean> {
  if (Date.now() - cached.ts < KS_CACHE_MS) return cached.value;
  // DB unavailable (DRY tests with no DATABASE_URL): default to inactive.
  // Production code already gates on env DRY_RUN before this hot-path call,
  // and the env-driven KILL_SWITCH=true is checked first in placeBuy.
  let value = false;
  try {
    const db = getDb();
    const rows = await db.query.killSwitches.findMany({
      where: and(eq(killSwitches.scope, SCOPE_GLOBAL), isNull(killSwitches.clearedAt)),
      limit: 1,
    });
    value = rows.length > 0 && rows[0]?.active === true;
  } catch {
    value = false;
  }
  cached = { value, ts: Date.now() };
  return value;
}

export async function setRuntimeKillSwitch(args: {
  active: boolean;
  reason: string;
}): Promise<void> {
  const db = getDb();
  if (args.active) {
    // Insert new active row (idempotent if one is already open)
    const existing = await db.query.killSwitches.findFirst({
      where: and(eq(killSwitches.scope, SCOPE_GLOBAL), isNull(killSwitches.clearedAt)),
    });
    if (!existing) {
      await db.insert(killSwitches).values({
        scope: SCOPE_GLOBAL,
        scopeId: null,
        active: true,
        reason: args.reason,
        setByUserId: null,
      });
    }
  } else {
    // Clear all open rows
    await db
      .update(killSwitches)
      .set({ active: false, clearedAt: new Date() })
      .where(and(eq(killSwitches.scope, SCOPE_GLOBAL), isNull(killSwitches.clearedAt)));
  }
  cached = { value: args.active, ts: Date.now() };
}

/** Force a refresh on next call. Used by tests. */
export function resetKillSwitchCache(): void {
  cached = { value: false, ts: 0 };
}
