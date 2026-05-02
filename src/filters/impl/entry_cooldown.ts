import { type Filter, PASS, SKIP } from "../types.js";

/**
 * entry_cooldown — block re-entry into the same asset within ENTRY_COOLDOWN_S.
 * Ported from v1 hard_safety.EntryCooldownFilter.
 *
 * v2 note: OpenPositionLite carries no fillTs; filter reduces to "any active
 * position on same asset = reject". This is also enforced by the DB constraint
 * uq_positions_open_per_asset, but expressing it as a filter gives operators
 * an observable rejection trace instead of an exception.
 */
const DEFAULT_COOLDOWN_SEC = 120;

export const entryCooldown: Filter = {
  name: "entry_cooldown",
  description: "Block re-entry into the same asset within ENTRY_COOLDOWN_S",
  evaluate(ctx, params) {
    const cooldownSec = Number(params["entryCooldownSec"] ?? DEFAULT_COOLDOWN_SEC);
    if (cooldownSec <= 0) return PASS({ v: 0, t: 0 });

    const targetAssetId = ctx.signal.assetId;
    for (const p of ctx.account.openPositions ?? []) {
      if (p.assetId === targetAssetId) {
        return SKIP(
          { v: cooldownSec, t: cooldownSec },
          "open position exists for asset within cooldown",
        );
      }
    }
    return PASS({ v: 0, t: cooldownSec });
  },
};
