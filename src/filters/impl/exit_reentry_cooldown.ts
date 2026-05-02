import { type Filter, PASS, SKIP } from "../types.js";

/**
 * exit_reentry_cooldown — block re-entry into a recently closed asset.
 * Ported from v1 hard_safety.ExitReentryCooldownFilter.
 *
 * Reads ctx.account.recentlyClosedAssets[] (populated by snapshotAccount with
 * a query against `positions` for CLOSED entries within window).
 */
const DEFAULT_COOLDOWN_SEC = 600;

export const exitReentryCooldown: Filter = {
  name: "exit_reentry_cooldown",
  description: "Block re-entry into recently closed asset within EXIT_REENTRY_COOLDOWN_S",
  evaluate(ctx, params) {
    const cooldownSec = Number(params["exitReentryCooldownSec"] ?? DEFAULT_COOLDOWN_SEC);
    if (cooldownSec <= 0) return PASS({ v: 0, t: 0 });

    const cooldownMs = cooldownSec * 1000;
    const targetAssetId = ctx.signal.assetId;
    const recentlyClosed = ctx.account.recentlyClosedAssets ?? [];
    for (const r of recentlyClosed) {
      if (r.assetId !== targetAssetId) continue;
      const ageMs = ctx.nowMs - r.closedAtTs;
      if (ageMs < cooldownMs) {
        const ageSec = ageMs / 1000;
        return SKIP(
          { v: ageSec, t: cooldownSec },
          `closed ${ageSec.toFixed(0)}s ago < ${cooldownSec}s cooldown`,
        );
      }
    }
    return PASS({ v: 0, t: cooldownSec });
  },
};
