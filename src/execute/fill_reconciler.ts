import process from "node:process";
import { WebSocket } from "ws";
import { logger } from "../obs/logger.js";

/**
 * FillReconciler — listens to Polymarket V2 User WebSocket for our wallet's
 * own fills (BUY entries + SELL exits) and forwards events to a handler.
 *
 * Per https://docs.polymarket.com/developers/CLOB/websocket/user-channel:
 *
 *   Subscribe: { type: "user", auth: {apiKey, secret, passphrase}, markets: [conditionId,...] }
 *
 * Server emits two event_type values:
 *   - "trade" — a market or limit order matched. Fields include
 *     `type` ("TRADE"), `id`, `asset_id`, `market`, `owner`, `side`,
 *     `size`, `price`, `status`, `matchtime`, `taker_order_id`,
 *     `maker_orders` array, `transaction_hash` (when on-chain).
 *   - "order" — a placement, partial-update, or cancellation. Fields
 *     include `type` ("PLACEMENT" | "UPDATE" | "CANCELLATION"),
 *     `id`, `asset_id`, `market`, `original_size`, `size_matched`.
 *
 * Subscribe must include markets we're interested in; an empty markets
 * list is silently accepted but yields no events. Server provides no
 * subscribe ack and no app-layer heartbeat — silence is normal idle.
 */

/** Trade event from the user channel (event_type === "trade"). */
export interface UserTradeEvent {
  event_type: "trade";
  type: string; // "TRADE" | "MINED" etc
  id: string;
  asset_id: string;
  market: string;
  owner?: string;
  outcome?: string;
  side: "BUY" | "SELL";
  size: string;
  price: string;
  status?: string; // MATCHED, MINED, CONFIRMED
  matchtime?: string;
  taker_order_id?: string;
  maker_orders?: { order_id: string; matched_amount: string; price: string }[];
  transaction_hash?: string;
  fee_rate_bps?: string;
  timestamp?: string | number;
}

/** Order lifecycle event (event_type === "order"). */
export interface UserOrderEvent {
  event_type: "order";
  type: "PLACEMENT" | "UPDATE" | "CANCELLATION";
  id: string;
  asset_id: string;
  market: string;
  side: "BUY" | "SELL";
  original_size?: string;
  size_matched?: string;
  price?: string;
  order_owner?: string;
  timestamp?: string | number;
}

export type UserWsEvent = UserTradeEvent | UserOrderEvent;

export interface FillHandler {
  onFill(event: UserTradeEvent): Promise<void> | void;
  onCancel(event: UserOrderEvent): Promise<void> | void;
}

interface FillReconcilerCfg {
  url: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  walletAddress: string;
  handler: FillHandler;
  /**
   * Condition IDs to subscribe to. Required — empty list yields no events.
   * Caller (main.ts) supplies the union of all open positions' conditionIds.
   */
  marketsProvider: () => Promise<readonly string[]> | readonly string[];
  /**
   * Optional callback fired on every successful WS auth (initial + reconnect).
   * Used by main.ts to backfill any missed fills via /activity REST.
   */
  onConnect?: (cfg: { walletAddress: string }) => Promise<void> | void;
  /**
   * If true, log every inbound WS message at debug level. Useful for
   * verifying the server's actual event shape during integration. Off by
   * default to keep production logs quiet.
   */
  traceRaw?: boolean;
}

export class FillReconciler {
  private ws: WebSocket | null = null;
  /**
   * Reconnect backoff: 5s → 10s → 20s → 60s capped. Reset only after a
   * connection is held STABLE_RESET_MS without disconnect (raw connect alone
   * isn't enough — Polymarket can accept the WS, hold it for 30s, then drop).
   */
  private backoffMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly stableResetMs: number;
  private stableResetTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastBackfillTs = 0;
  private readonly backfillCooldownMs: number;

  constructor(private cfg: FillReconcilerCfg) {
    const numEnv = (k: string, fallback: number): number =>
      Number(process.env[k] ?? fallback);
    this.minBackoffMs = numEnv("FILL_WS_MIN_BACKOFF_MS", 5_000);
    this.maxBackoffMs = numEnv("FILL_WS_MAX_BACKOFF_MS", 60_000);
    this.stableResetMs = numEnv("FILL_WS_STABLE_RESET_MS", 60_000);
    this.backfillCooldownMs = numEnv("FILL_WS_BACKFILL_COOLDOWN_MS", 5 * 60_000);
    this.backoffMs = this.minBackoffMs;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.stableResetTimer) {
      clearTimeout(this.stableResetTimer);
      this.stableResetTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const log = logger.child({ component: "fill_reconciler", url: this.cfg.url });
    log.info("connecting to user WS");

    const ws = new WebSocket(this.cfg.url);
    this.ws = ws;

    ws.on("open", () => {
      log.info("connected; sending auth");
      // Schedule stable-reset: only drop backoff to floor if we hold the
      // connection for stableResetMs. A server that accepts then drops at
      // 30s shouldn't trigger 1s reconnects forever.
      if (this.stableResetTimer) clearTimeout(this.stableResetTimer);
      this.stableResetTimer = setTimeout(() => {
        if (this.backoffMs !== this.minBackoffMs) {
          log.debug({ heldMs: this.stableResetMs }, "WS held stable — resetting backoff");
          this.backoffMs = this.minBackoffMs;
        }
      }, this.stableResetMs);
      this.stableResetTimer.unref?.();

      Promise.resolve(this.cfg.marketsProvider())
        .then((markets) => {
          const payload = {
            type: "user",
            auth: {
              apiKey: this.cfg.apiKey,
              secret: this.cfg.apiSecret,
              passphrase: this.cfg.apiPassphrase,
            },
            markets: [...markets],
          };
          ws.send(JSON.stringify(payload));
          log.info({ marketCount: markets.length }, "user WS subscribed");

          if (this.cfg.onConnect) {
            const sinceLast = Date.now() - this.lastBackfillTs;
            if (sinceLast < this.backfillCooldownMs) {
              log.debug(
                { sinceLastSec: Math.round(sinceLast / 1000), cooldownSec: this.backfillCooldownMs / 1000 },
                "skipping /activity backfill — within cooldown",
              );
            } else {
              this.lastBackfillTs = Date.now();
              Promise.resolve(this.cfg.onConnect({ walletAddress: this.cfg.walletAddress })).catch(
                (err) => log.warn({ err }, "onConnect callback threw"),
              );
            }
          }
        })
        .catch((err) => log.error({ err }, "marketsProvider threw — closing WS"));
    });

    ws.on("message", (data: Buffer) => {
      void this.handleMessage(data, log);
    });

    ws.on("ping", () => {
      try {
        ws.pong();
      } catch (err) {
        log.warn({ err }, "pong send failed");
      }
    });

    ws.on("close", (code, reason) => {
      log.warn({ code, reason: reason.toString() }, "user WS closed");
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      log.error({ err }, "user WS error");
    });
  }

  private async handleMessage(data: Buffer, log: typeof logger): Promise<void> {
    const text = data.toString();
    if (this.cfg.traceRaw) {
      log.debug({ raw: text.slice(0, 1024) }, "user WS raw inbound");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      log.warn({ len: data.length, sample: text.slice(0, 80) }, "user WS got non-JSON");
      return;
    }
    if (Array.isArray(parsed)) {
      for (const event of parsed) await this.dispatch(event as UserWsEvent, log);
      return;
    }
    await this.dispatch(parsed as UserWsEvent, log);
  }

  private async dispatch(event: UserWsEvent, log: typeof logger): Promise<void> {
    if (event.event_type === "trade") {
      log.info(
        {
          orderID: event.taker_order_id ?? event.id,
          side: event.side,
          size: event.size,
          price: event.price,
          status: event.status,
          tx: event.transaction_hash,
        },
        "fill received",
      );
      try {
        await this.cfg.handler.onFill(event);
      } catch (err) {
        log.error({ err, orderID: event.id }, "fill handler threw");
      }
      return;
    }
    if (event.event_type === "order") {
      if (event.type === "CANCELLATION") {
        log.info({ orderID: event.id }, "order canceled");
        try {
          await this.cfg.handler.onCancel(event);
        } catch (err) {
          log.error({ err, orderID: event.id }, "cancel handler threw");
        }
        return;
      }
      log.debug(
        { orderID: event.id, type: event.type, matched: event.size_matched },
        "order lifecycle",
      );
      return;
    }
    log.debug(
      {
        event_type: (event as { event_type?: unknown }).event_type,
        sample: JSON.stringify(event).slice(0, 200),
      },
      "user WS unmapped event",
    );
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.stableResetTimer) {
      clearTimeout(this.stableResetTimer);
      this.stableResetTimer = null;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    setTimeout(() => this.connect(), delay).unref?.();
  }
}

export function fillReconcilerFromEnv(
  handler: FillHandler,
  marketsProvider: () => Promise<readonly string[]> | readonly string[],
  onConnect?: (cfg: { walletAddress: string }) => Promise<void> | void,
): FillReconciler {
  const url =
    process.env["CLOB_WS_USER_URL"] ?? "wss://ws-subscriptions-clob.polymarket.com/ws/user";
  const required = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`env ${k} not set`);
    return v;
  };
  return new FillReconciler({
    url,
    apiKey: required("POLY_API_KEY"),
    apiSecret: required("POLY_API_SECRET"),
    apiPassphrase: required("POLY_API_PASSPHRASE"),
    walletAddress: required("POLY_WALLET_ADDRESS"),
    handler,
    marketsProvider,
    traceRaw: (process.env["FILL_WS_TRACE_RAW"] ?? "false").toLowerCase() === "true",
    ...(onConnect ? { onConnect } : {}),
  });
}
