import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { positions, strategies, strategyFilters, whales } from "../db/schema.js";
import { canAffordEntry } from "../execute/budget.js";
import { type ConfiguredFilter, runPipeline } from "../filters/pipeline.js";
import type { AccountState, FilterContext, MarketState } from "../filters/types.js";
import { logger } from "../obs/logger.js";
import { DEFAULT_EXIT_CONFIG, type ExitConfig } from "../types/decide.js";
import type { MarketMetadata } from "../types/market.js";
import type { Signal } from "../types/signal.js";
import type { Decision, Strategy, StrategyConfig } from "../types/strategy.js";

/**
 * WhaleFollowStrategy — P1 sports-only signal copy strategy.
 *
 * Pipeline:
 *   1. lookup whale row (skip if untracked)
 *   2. build FilterContext from signal + DB state + market metadata
 *   3. run configured filters
 *   4. if pass: compute sizing → enter; else skip with reason
 *
 * Sizing: size_usd = base × conviction_mult, capped by max_entry_shares × price
 * and by available budget.
 *
 * exitConfig() returns the v1-ported defaults (-15/-17/+20) loaded from
 * src/types/decide.ts DEFAULT_EXIT_CONFIG. Per-strategy override possible
 * via strategy.params.exitConfig.* — not used in P1.
 */

interface WhaleRow {
  classification: string;
  confidence: number;
  tracked: boolean;
}

interface WhaleFollowParams {
  baseSizeUsd: number;
  maxEntryShares: number;
  budgetUsd: number;
}

function readParams(strategyParams: Record<string, unknown>): WhaleFollowParams {
  return {
    baseSizeUsd: Number(strategyParams["baseSizeUsd"] ?? 75),
    maxEntryShares: Number(strategyParams["maxEntryShares"] ?? 10),
    budgetUsd: Number(strategyParams["budgetUsd"] ?? 100),
  };
}

export class WhaleFollowStrategy implements Strategy {
  readonly id: string;
  readonly kind = "whale_follow" as const;

  constructor(readonly config: StrategyConfig) {
    this.id = config.id;
  }

  signalSources(): never[] {
    // Wired up in P1 main.ts via FeedConsumer; Strategy itself is stateless.
    return [];
  }

  exitConfig(): ExitConfig {
    return DEFAULT_EXIT_CONFIG;
  }

  sizing(decision: Extract<Decision, { kind: "enter" }>, balance: number): number {
    const params = readParams(this.config.params);
    const conviction = decision.conviction;
    const sizeUsd = Math.min(params.baseSizeUsd * conviction, balance);
    const sharesByUsd = sizeUsd / Math.max(decision.priceCap, 0.01);
    return Math.min(sharesByUsd, params.maxEntryShares);
  }

  async evaluate(signal: Signal, market: MarketMetadata): Promise<Decision> {
    const log = logger.child({ strategy: this.id, signalId: signal.id });
    const strategyId = Number(this.config.id);
    const userId = signal.userId;

    const whale = await this.lookupWhale(
      strategyId,
      signal.payload["whaleAddress"] as string | undefined,
    );
    if (!whale?.tracked) {
      return { kind: "skip", reason: "untracked_whale" };
    }

    const [account, marketState, configured] = await Promise.all([
      this.snapshotAccount(userId, strategyId),
      this.marketState(signal, market),
      this.loadConfiguredFilters(strategyId),
    ]);

    const ctx: FilterContext = {
      signal,
      account,
      market: marketState,
      whale: {
        address: signal.payload["whaleAddress"] as string,
        tracked: whale.tracked,
        classification: whale.classification,
        confidence: whale.confidence,
        convictionScore: Number(signal.payload["convictionScore"] ?? 0),
        trustScore: Number(signal.payload["trustScore"] ?? 0),
        smScore: Number(signal.payload["smScore"] ?? 0),
        signalAgeSec: Math.max(0, (Date.now() - signal.receivedTs) / 1000),
      },
      nowMs: Date.now(),
    };

    const result = runPipeline(ctx, configured);
    if (!result.passed) {
      log.debug({ skipReason: result.skipReason }, "filter pipeline rejected entry");
      return { kind: "skip", reason: result.skipReason ?? "pipeline_rejected" };
    }

    const params = readParams(this.config.params);
    const conviction = ctx.whale.convictionScore;
    const proposedUsd = Math.min(params.baseSizeUsd * conviction, account.availableUsd);
    const afford = await canAffordEntry(userId, strategyId, proposedUsd);
    if (!afford.ok) {
      return { kind: "skip", reason: "budget_exhausted" };
    }

    return {
      kind: "enter",
      side: signal.side,
      priceCap: signal.priceHint,
      sizeUsdHint: proposedUsd,
      conviction,
    };
  }

  private async lookupWhale(strategyId: number, addr?: string): Promise<WhaleRow | null> {
    if (!addr) return null;
    const db = getDb();
    const row = await db.query.whales.findFirst({
      where: and(eq(whales.strategyId, strategyId), eq(whales.address, addr.toLowerCase())),
    });
    if (!row) return null;
    return {
      classification: row.classification,
      confidence: row.confidence,
      tracked: row.tracked,
    };
  }

  private async snapshotAccount(userId: number, strategyId: number): Promise<AccountState> {
    const db = getDb();
    const strat = await db.query.strategies.findFirst({ where: eq(strategies.id, strategyId) });
    const params = readParams((strat?.params as Record<string, unknown>) ?? {});

    const open = await db.query.positions.findMany({
      where: and(
        eq(positions.userId, userId),
        eq(positions.strategyId, strategyId),
        inArray(positions.status, ["PENDING", "FILLED", "OPEN", "EXITING"] as const),
      ),
    });

    const totalExposureUsd = open.reduce((acc, p) => acc + Number(p.entryCostUsd ?? 0), 0);
    const committedUsd = open
      .filter((p) => p.status === "OPEN")
      .reduce((acc, p) => acc + Number(p.entryCostUsd ?? 0), 0);
    const availableUsd = Math.max(0, params.budgetUsd - committedUsd);

    return {
      userId,
      budgetUsd: params.budgetUsd,
      availableUsd,
      drawdownPct: 0,
      openPositions: open.map((p) => ({
        id: Number(p.id),
        conditionId: p.conditionId,
        assetId: p.assetId,
        entryCostUsd: Number(p.entryCostUsd ?? 0),
        status: p.status as "PENDING" | "FILLED" | "OPEN" | "EXITING",
      })),
      totalExposureUsd,
      cashPnl24hUsd: 0,
    };
  }

  private async marketState(signal: Signal, market: MarketMetadata): Promise<MarketState> {
    return {
      conditionId: signal.conditionId,
      assetId: signal.assetId,
      bid: signal.priceHint,
      ask: signal.priceHint,
      mark: signal.priceHint,
      hoursToResolution: 24,
      volumeUsd: Number(signal.payload["marketVolumeUsd"] ?? 0),
      liquidityUsd: Number(signal.payload["marketLiquidityUsd"] ?? 0),
      tickSize: market.tickSize,
      negRisk: market.negRisk,
      minOrderSize: market.minOrderSize,
    };
  }

  private async loadConfiguredFilters(strategyId: number): Promise<readonly ConfiguredFilter[]> {
    const db = getDb();
    const rows = await db.query.strategyFilters.findMany({
      where: eq(strategyFilters.strategyId, strategyId),
    });
    return rows.map((r) => ({
      name: r.filterName,
      enabled: r.enabled,
      params: (r.params as Record<string, number | string | boolean>) ?? {},
    }));
  }
}
