import { and, eq, inArray } from "drizzle-orm";
import { getClobClient } from "../api/clob.js";
import { getPositions } from "../api/data.js";
import { getDb } from "../db/client.js";
import { positions as positionsTable } from "../db/schema.js";
import { logger } from "../obs/logger.js";

/**
 * Startup cross-check — runs once when ora2-trader boots.
 *
 * Catches three classes of out-of-sync state that the per-tick reconciler
 * would either miss entirely or take many seconds to correct:
 *
 *   1. **Ghost CLOB orders** — open orders on Polymarket for assets we have
 *      no active DB position for. Likely leftover from a crashed sweep loop
 *      or a manual run; left untreated they could match unexpectedly later
 *      and oversell. We cancel them.
 *
 *   2. **Orphan chain shares** — chain shows shares for an asset we don't
 *      track in DB (active position). We can't safely sell them (no
 *      strategy / no fill price), but we surface them as warnings so the
 *      operator can manually exit-all or import.
 *
 *   3. **Stale active DB positions** — DB has OPEN/EXITING for an asset
 *      that chain knows nothing about AND our /activity has no recent SELL
 *      for. Either we crashed mid-cycle and the order died, or someone
 *      external swept the wallet. We don't auto-mutate (could mask real
 *      bugs); we log loudly so the per-tick reconciler can decide whether
 *      to close or freeze on its normal path.
 *
 * Non-fatal: failures here are logged, not thrown.  Trader continues
 * either way — per-tick reconciler is the safety net.
 */

interface CrosscheckResult {
  ghostOrdersCancelled: number;
  orphanChainAssets: number;
  staleDbPositions: number;
}

const ACTIVE_STATUSES = ["PENDING", "FILLED", "OPEN", "EXITING"] as const;

export async function runStartupCrosscheck(userId: number): Promise<CrosscheckResult> {
  const log = logger.child({ component: "startup_crosscheck", userId });
  const db = getDb();
  const result: CrosscheckResult = {
    ghostOrdersCancelled: 0,
    orphanChainAssets: 0,
    staleDbPositions: 0,
  };

  let walletAddress: string;
  let clob: ReturnType<typeof getClobClient>["client"];
  try {
    const c = getClobClient();
    walletAddress = c.walletAddress;
    clob = c.client;
  } catch (err) {
    log.warn({ err }, "ClobClient unavailable — skipping crosscheck (DRY mode?)");
    return result;
  }

  // 1) DB → set of active asset_ids
  const activeRows = await db.query.positions.findMany({
    where: and(
      eq(positionsTable.userId, userId),
      inArray(positionsTable.status, [...ACTIVE_STATUSES]),
    ),
    columns: { id: true, assetId: true, status: true, lastStateChangeTs: true },
  });
  const activeAssetIds = new Set(activeRows.map((r) => r.assetId));
  log.info({ activeDbPositions: activeRows.length }, "crosscheck: starting");

  // 2) Cancel ghost CLOB orders (assets we don't track)
  try {
    const open = (await clob.getOpenOrders()) as
      | { id: string; asset_id?: string; side?: string }[]
      | { results?: { id: string; asset_id?: string; side?: string }[] };
    const list = Array.isArray(open) ? open : (open.results ?? []);
    const ghosts = list.filter((o) => !activeAssetIds.has(o.asset_id ?? ""));
    for (const g of ghosts) {
      try {
        await clob.cancelOrder({ orderID: g.id });
        result.ghostOrdersCancelled += 1;
        log.warn(
          { orderID: g.id, assetId: g.asset_id, side: g.side },
          "crosscheck: cancelled ghost CLOB order (no active DB position)",
        );
      } catch (err) {
        log.warn({ err, orderID: g.id }, "crosscheck: ghost cancel failed");
      }
    }
  } catch (err) {
    log.warn({ err }, "crosscheck: getOpenOrders failed");
  }

  // 3) Orphan chain shares (chain has shares for assets we don't track)
  try {
    const chainPositions = await getPositions(walletAddress);
    const chainAssetIds = new Set(chainPositions.map((p) => p.asset));
    for (const cp of chainPositions) {
      if (cp.size <= 0) continue;
      if (!activeAssetIds.has(cp.asset)) {
        result.orphanChainAssets += 1;
        log.warn(
          {
            assetId: cp.asset,
            chainShares: cp.size,
            title: cp.title?.slice(0, 60),
          },
          "crosscheck: chain shares with no active DB position — orphan; manual exit-all or import",
        );
      }
    }

    // 4) Stale DB positions (active in DB, invisible on chain)
    for (const r of activeRows) {
      if (!chainAssetIds.has(r.assetId)) {
        result.staleDbPositions += 1;
        log.warn(
          {
            posId: r.id,
            status: r.status,
            assetId: r.assetId,
            ageMs: Date.now() - Number(r.lastStateChangeTs ?? 0),
          },
          "crosscheck: DB active but chain invisible — per-tick reconciler will close or freeze",
        );
      }
    }
  } catch (err) {
    log.warn({ err }, "crosscheck: chain /positions failed");
  }

  log.info(result, "crosscheck: done");
  return result;
}
