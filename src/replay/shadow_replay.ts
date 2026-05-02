import { decideExit } from "../decide.js";
import type { ExitConfig, ExitIntent } from "../types/decide.js";
import type { MarketSnapshot } from "../types/market.js";
import type { PositionView } from "../types/position.js";

/**
 * Shadow-replay engine (P3a).
 *
 * Takes a stream of historical (PositionView, MarketSnapshot, originalIntent)
 * tuples — typically from the `decisions` table populated by P2b — and
 * re-runs decide_exit with the CURRENT code + config. Reports per-tuple
 * drift and aggregate statistics. P3a hard gate: if a strategy change
 * produces materially worse simulated P&L vs captured original, it does
 * not ship to LIVE.
 *
 * "Materially worse" thresholds are intentionally caller-defined — what
 * counts as a regression depends on which gate moved. The engine's job is
 * to surface the diffs.
 */

export interface CapturedDecision {
  pos: PositionView;
  snap: MarketSnapshot;
  originalIntent: ExitIntent;
  /** Optional ground-truth: did this position eventually exit at this price? */
  realizedPriceUsd?: number;
  /** Optional ground-truth net P&L USD if known. */
  realizedPnlUsd?: number;
}

export interface ReplayDelta {
  index: number;
  positionId: string;
  originalAction: ExitIntent["action"];
  newAction: ExitIntent["action"];
  changed: boolean;
  /** Was the original a SELL of any kind? */
  originalIsSell: boolean;
  /** Is the new intent a SELL of any kind? */
  newIsSell: boolean;
  /** Price drift if both sells. */
  priceDelta: number | null;
  newGates: readonly string[];
  originalGates: readonly string[];
}

export interface ReplayReport {
  total: number;
  unchanged: number;
  changed: number;
  actionMatrix: Record<string, Record<string, number>>;
  newSellsAdded: number;
  newSellsDropped: number;
  averagePriceDeltaWhenBothSell: number | null;
  /** Simulated P&L impact ONLY when realized values are available. */
  simulatedPnlImpactUsd: number | null;
  details: ReplayDelta[];
}

export interface ReplayCfg {
  /** Override exit config; default = the position's strategy config from prod. */
  cfg: ExitConfig;
  /** Cap details list to keep report compact. Default 100. */
  maxDetails?: number;
  /** Only return changed deltas in details. Default true. */
  detailsChangedOnly?: boolean;
}

function isSell(action: ExitIntent["action"]): boolean {
  return action === "sell_bid_probe" || action === "sell_bid_aggr" || action === "sell_fok";
}

export function runReplay(
  captured: readonly CapturedDecision[],
  replayCfg: ReplayCfg,
): ReplayReport {
  const matrix: Record<string, Record<string, number>> = {};
  const details: ReplayDelta[] = [];
  let unchanged = 0;
  let changed = 0;
  let newSellsAdded = 0;
  let newSellsDropped = 0;
  let priceDeltaSum = 0;
  let priceDeltaCount = 0;
  let simulatedImpact = 0;
  let simulatedImpactSeen = 0;

  const detailsChangedOnly = replayCfg.detailsChangedOnly ?? true;
  const maxDetails = replayCfg.maxDetails ?? 100;

  captured.forEach((c, i) => {
    const newIntent = decideExit(c.pos, c.snap, replayCfg.cfg);
    const oa = c.originalIntent.action;
    const na = newIntent.action;
    matrix[oa] ??= {};
    matrix[oa][na] = (matrix[oa][na] ?? 0) + 1;

    const oldSell = isSell(oa);
    const newSell = isSell(na);
    if (newSell && !oldSell) newSellsAdded += 1;
    if (oldSell && !newSell) newSellsDropped += 1;
    if (oldSell && newSell) {
      const delta = newIntent.price - c.originalIntent.price;
      priceDeltaSum += delta;
      priceDeltaCount += 1;
    }

    const isSame = oa === na && Math.abs(newIntent.price - c.originalIntent.price) < 1e-6;
    if (isSame) unchanged += 1;
    else changed += 1;

    // Simulated P&L impact: only meaningful when we know what would have
    // been realized at the original action. Negative impact means the new
    // strategy would have done worse.
    if (c.realizedPnlUsd !== undefined && oldSell !== newSell) {
      // Crude: if new strategy DROPPED the sell, we forfeit the realized pnl.
      // If it ADDED a sell, we gain (or lose) something we don't know — set 0.
      if (oldSell && !newSell) {
        simulatedImpact -= c.realizedPnlUsd;
        simulatedImpactSeen += 1;
      }
    }

    if (!detailsChangedOnly || !isSame) {
      if (details.length < maxDetails) {
        details.push({
          index: i,
          positionId: c.pos.id,
          originalAction: oa,
          newAction: na,
          changed: !isSame,
          originalIsSell: oldSell,
          newIsSell: newSell,
          priceDelta: oldSell && newSell ? newIntent.price - c.originalIntent.price : null,
          newGates: newIntent.gates,
          originalGates: c.originalIntent.gates,
        });
      }
    }
  });

  return {
    total: captured.length,
    unchanged,
    changed,
    actionMatrix: matrix,
    newSellsAdded,
    newSellsDropped,
    averagePriceDeltaWhenBothSell: priceDeltaCount > 0 ? priceDeltaSum / priceDeltaCount : null,
    simulatedPnlImpactUsd: simulatedImpactSeen > 0 ? simulatedImpact : null,
    details,
  };
}

/** Pretty-print a ReplayReport for CLI output. */
export function formatReport(r: ReplayReport): string {
  const lines: string[] = [];
  lines.push(`shadow-replay over ${r.total} captured decisions`);
  lines.push(`  unchanged: ${r.unchanged}  changed: ${r.changed}`);
  lines.push(`  new SELLs added (was non-sell, now sell): ${r.newSellsAdded}`);
  lines.push(`  SELLs dropped (was sell, now non-sell):   ${r.newSellsDropped}`);
  if (r.averagePriceDeltaWhenBothSell !== null) {
    lines.push(
      `  avg SELL price delta (new-old) when both sell: ${r.averagePriceDeltaWhenBothSell.toFixed(4)}`,
    );
  }
  if (r.simulatedPnlImpactUsd !== null) {
    lines.push(`  simulated P&L impact (USD): ${r.simulatedPnlImpactUsd.toFixed(2)}`);
  }
  lines.push("\naction matrix (rows=original → cols=new):");
  for (const orig of Object.keys(r.actionMatrix).sort()) {
    const inner = r.actionMatrix[orig] ?? {};
    const counts = Object.entries(inner)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`  ${orig.padEnd(18)} → ${counts}`);
  }
  if (r.details.length > 0) {
    lines.push(`\nfirst ${r.details.length} changed details:`);
    for (const d of r.details.slice(0, 10)) {
      const arrow = `${d.originalAction} → ${d.newAction}`;
      const px = d.priceDelta !== null ? ` Δprice=${d.priceDelta.toFixed(4)}` : "";
      lines.push(`  pos ${d.positionId}  ${arrow}${px}`);
    }
  }
  return lines.join("\n");
}
