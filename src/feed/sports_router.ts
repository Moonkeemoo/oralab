import { and, eq, inArray } from "drizzle-orm";
import { getMarketsByGameId } from "../api/gamma.js";
import { getDb } from "../db/client.js";
import { positions } from "../db/schema.js";
import { logger } from "../obs/logger.js";
import type { ScoreEvent } from "./sports_event_consumer.js";

/**
 * SportsRouter — bridge between SportsEventConsumer and the trading core.
 *
 * MVP rule (P1.5): on `game_ended`, mark every active position whose
 * conditionId is one of this game's markets with `gameEndedHint = true`
 * by writing a small DB note. The PositionMonitor decide_exit doesn't
 * directly act on it yet — it's surfaced for ops/audit and will become
 * an exit-trigger gate in P1.5+ once we have a SportsWsReactorStrategy
 * that owns positions.
 *
 * The router intentionally does NOT enter new positions in P1.5 — that's
 * SportsPreEventStrategy in P4+. P1.5 SportsScoreReactor only manages
 * exits / timing on existing whale-follow positions.
 *
 * `score_change` and `period_change` are logged at debug only for now;
 * the data lands in `sports_events` already so future strategies can
 * consume it.
 */

interface SportsRouterCfg {
  readonly userId: number;
}

const ACTIVE_STATUSES = ["PENDING", "FILLED", "OPEN", "EXITING"] as const;

export class SportsRouter {
  constructor(private readonly cfg: SportsRouterCfg) {}

  async onScoreEvent(event: ScoreEvent): Promise<void> {
    if (event.kind !== "game_ended") {
      logger.debug(
        {
          kind: event.kind,
          gameId: event.gameId,
          score: event.currentScore,
          period: event.currentPeriod,
        },
        "sports event observed",
      );
      return;
    }

    // game_ended path: find markets for this gameId, intersect with our
    // active positions, mark them resolved-pending (reconciler / decide_exit
    // will handle redeem on next snapshot now that the market resolves).
    let markets;
    try {
      markets = await getMarketsByGameId(event.gameId);
    } catch (err) {
      logger.warn({ err, gameId: event.gameId }, "gamma market lookup failed");
      return;
    }
    if (markets.length === 0) {
      logger.debug({ gameId: event.gameId }, "game ended; no Polymarket markets matched");
      return;
    }
    const conditionIds = markets.map((m) => m.conditionId);
    const db = getDb();
    const matched = await db.query.positions.findMany({
      where: and(
        eq(positions.userId, this.cfg.userId),
        inArray(positions.status, [...ACTIVE_STATUSES]),
        inArray(positions.conditionId, conditionIds),
      ),
      columns: { id: true, conditionId: true, status: true },
    });
    if (matched.length === 0) {
      logger.debug(
        { gameId: event.gameId, markets: markets.length },
        "game ended; no active positions in matched markets",
      );
      return;
    }

    const hintPayload = {
      type: "game_ended" as const,
      gameId: String(event.gameId),
      score: event.currentScore ?? "",
      league: event.league ?? "",
      at: Date.now(),
    };

    await db
      .update(positions)
      .set({ sportsHint: hintPayload, updatedAt: new Date() })
      .where(
        inArray(
          positions.id,
          matched.map((p) => p.id),
        ),
      );

    logger.info(
      {
        gameId: event.gameId,
        finalScore: event.currentScore,
        markets: markets.length,
        affectedPositions: matched.map((p) => p.id),
        hint: hintPayload,
      },
      "sports: game ended — sports_hint persisted, decide_exit Gate 8.5 will fire next tick",
    );
  }
}
