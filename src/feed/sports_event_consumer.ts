import process from "node:process";
import { sql } from "drizzle-orm";
import { WebSocket } from "ws";
import { getDb } from "../db/client.js";
import { sportsEvents } from "../db/schema.js";
import { logger } from "../obs/logger.js";

/**
 * SportsEventConsumer — subscribes to wss://sports-api.polymarket.com/ws
 * and emits semantic ScoreEvent messages on detected state changes.
 *
 * Per docs/POLYMARKET_API.md: no auth, no subscribe message; auto-streams
 * all active sports events. Each inbound message is a full game-state
 * snapshot (gameId, score, period, live, ended, eventState{type, …}).
 *
 * Diff semantics (MVP):
 *   - "score_change": `score` string changed for a known gameId
 *   - "period_change": `period` changed
 *   - "game_ended": `ended` flipped false → true OR `status` became final-like
 *
 * Persists every snapshot to `sports_events` (UPSERT by gameId) so other
 * services have audit access. Reconnect with exponential backoff.
 */

export interface SportsRawSnapshot {
  gameId: number | string;
  leagueAbbreviation?: string;
  homeTeam?: string;
  awayTeam?: string;
  status?: string;
  score?: string;
  period?: string;
  live?: boolean;
  ended?: boolean;
  eventState?: {
    type?: string;
    score?: string;
    period?: string;
    live?: boolean;
    ended?: boolean;
    tournamentName?: string;
  };
}

export type ScoreEventKind = "score_change" | "period_change" | "game_ended";

export interface ScoreEvent {
  readonly kind: ScoreEventKind;
  readonly gameId: string;
  readonly league: string;
  readonly previousScore: string | null;
  readonly currentScore: string | null;
  readonly previousPeriod: string | null;
  readonly currentPeriod: string | null;
  readonly status: string;
  readonly ended: boolean;
  readonly snapshotTs: number;
  readonly raw: SportsRawSnapshot;
}

export type ScoreEventHandler = (event: ScoreEvent) => Promise<void> | void;

interface ConsumerCfg {
  url: string;
  handler: ScoreEventHandler;
  /** Persist every snapshot to sports_events. Default true. */
  persistSnapshots?: boolean;
}

/**
 * Heuristic — Polymarket marks games as "ended" via boolean and/or status
 * string. Treat any of these as terminal.
 */
const FINAL_STATUSES = new Set([
  "finished",
  "final",
  "ended",
  "closed",
  "complete",
  "completed",
  "ft",
]);

function isFinal(snapshot: SportsRawSnapshot): boolean {
  if (snapshot.ended === true) return true;
  if (snapshot.eventState?.ended === true) return true;
  const status = (snapshot.status ?? "").toLowerCase();
  return FINAL_STATUSES.has(status);
}

function gameIdString(s: SportsRawSnapshot): string {
  return String(s.gameId);
}

export class SportsEventConsumer {
  private ws: WebSocket | null = null;
  private prev = new Map<string, { score: string | null; period: string | null; ended: boolean }>();
  private backoffMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private stopped = false;

  constructor(private cfg: ConsumerCfg) {
    const numEnv = (k: string, fallback: number): number => Number(process.env[k] ?? fallback);
    this.minBackoffMs = numEnv("SPORTS_WS_MIN_BACKOFF_MS", 5_000);
    this.maxBackoffMs = numEnv("SPORTS_WS_MAX_BACKOFF_MS", 60_000);
    this.backoffMs = this.minBackoffMs;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const log = logger.child({ component: "sports_event_consumer", url: this.cfg.url });
    log.info("connecting to sports WS");
    const ws = new WebSocket(this.cfg.url);
    this.ws = ws;

    ws.on("open", () => {
      log.info("connected — auto-stream begins");
      this.backoffMs = this.minBackoffMs;
    });
    ws.on("message", (data: Buffer) => {
      void this.handleMessage(data, log);
    });
    ws.on("close", (code, reason) => {
      log.warn({ code, reason: reason.toString() }, "sports WS closed");
      this.scheduleReconnect();
    });
    ws.on("error", (err) => log.error({ err }, "sports WS error"));
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    setTimeout(() => this.connect(), delay).unref?.();
  }

  private async handleMessage(data: Buffer, log: typeof logger): Promise<void> {
    let snap: SportsRawSnapshot;
    try {
      snap = JSON.parse(data.toString()) as SportsRawSnapshot;
    } catch {
      log.debug({ len: data.length }, "non-JSON sports message");
      return;
    }
    if (!snap.gameId) return;

    const gameId = gameIdString(snap);
    const score = snap.score ?? snap.eventState?.score ?? null;
    const period = snap.period ?? snap.eventState?.period ?? null;
    const ended = isFinal(snap);
    const league = snap.leagueAbbreviation ?? snap.eventState?.type ?? "unknown";
    const status = snap.status ?? "unknown";

    if (this.cfg.persistSnapshots !== false) {
      try {
        await this.persistSnapshot(snap, gameId, league, score, period, status);
      } catch (err) {
        log.warn({ err, gameId }, "sports event persist failed");
      }
    }

    const events = this.diff(gameId, score, period, ended, league, status, snap);
    for (const e of events) {
      try {
        await this.cfg.handler(e);
      } catch (err) {
        log.error({ err, gameId, kind: e.kind }, "score event handler threw");
      }
    }
  }

  /** Compare against in-memory prev state; emit one event per detected change. */
  private diff(
    gameId: string,
    score: string | null,
    period: string | null,
    ended: boolean,
    league: string,
    status: string,
    raw: SportsRawSnapshot,
  ): ScoreEvent[] {
    const prev = this.prev.get(gameId) ?? { score: null, period: null, ended: false };
    this.prev.set(gameId, { score, period, ended });

    if (prev.ended) return []; // already terminal — ignore further messages

    const out: ScoreEvent[] = [];
    const base = {
      gameId,
      league,
      previousScore: prev.score,
      currentScore: score,
      previousPeriod: prev.period,
      currentPeriod: period,
      status,
      ended,
      snapshotTs: Date.now(),
      raw,
    };

    if (prev.score !== null && score !== null && prev.score !== score) {
      out.push({ ...base, kind: "score_change" });
    }
    if (prev.period !== null && period !== null && prev.period !== period) {
      out.push({ ...base, kind: "period_change" });
    }
    if (!prev.ended && ended) {
      out.push({ ...base, kind: "game_ended" });
    }
    return out;
  }

  private async persistSnapshot(
    snap: SportsRawSnapshot,
    gameId: string,
    league: string,
    score: string | null,
    period: string | null,
    status: string,
  ): Promise<void> {
    const db = getDb();
    await db
      .insert(sportsEvents)
      .values({
        gameId,
        league,
        homeTeam: snap.homeTeam ?? null,
        awayTeam: snap.awayTeam ?? null,
        score: score === null ? {} : { value: score },
        period,
        status,
        startedAt: null,
        raw: snap as unknown as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: sportsEvents.gameId,
        set: {
          score: score === null ? {} : { value: score },
          period,
          status,
          raw: snap as unknown as Record<string, unknown>,
          fetchedAt: sql`NOW()`,
        },
      });
  }
}

export function sportsEventConsumerFromEnv(handler: ScoreEventHandler): SportsEventConsumer {
  const url = process.env["SPORTS_WS_URL"] ?? "wss://sports-api.polymarket.com/ws";
  return new SportsEventConsumer({ url, handler });
}
