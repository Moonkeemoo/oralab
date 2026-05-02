import process from "node:process";
import { WebSocket } from "ws";
import { logger } from "../obs/logger.js";

/**
 * FillReconciler — listens to Polymarket User WebSocket for our wallet's
 * own fills (BUY entries + SELL exits), and forwards events to a handler.
 *
 * Day 5-7 skeleton: connection lifecycle, auth, reconnect with exponential
 * backoff, heartbeat, type-safe event interface. The actual handler that
 * writes to `fills` table + transitions positions lives in P1 week 2-3
 * alongside ExitExecutor.
 *
 * Auth: server expects {type: "User", auth: {apiKey, secret, passphrase}}.
 * Heartbeat: server pings every ~5s; respond pong within 10s.
 * Reconnect: 1s → 2s → 4s → 8s → 16s capped, reset on successful connect.
 */

export interface OwnFillEvent {
  type: "OrderFilled";
  orderID: string;
  market: string;
  asset_id: string;
  side: "BUY" | "SELL";
  size: string;
  price: string;
  fee: string;
  transactionHash: string;
  timestamp: number;
}

export interface OrderCanceledEvent {
  type: "OrderCanceled";
  orderID: string;
  reason?: string;
  timestamp: number;
}

export type UserWsEvent = OwnFillEvent | OrderCanceledEvent;

export interface FillHandler {
  onFill(event: OwnFillEvent): Promise<void> | void;
  onCancel(event: OrderCanceledEvent): Promise<void> | void;
}

interface FillReconcilerCfg {
  url: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  walletAddress: string;
  handler: FillHandler;
}

export class FillReconciler {
  private ws: WebSocket | null = null;
  private backoffMs = 1_000;
  private readonly maxBackoffMs = 16_000;
  private stopped = false;

  constructor(private cfg: FillReconcilerCfg) {}

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
    const log = logger.child({ component: "fill_reconciler", url: this.cfg.url });
    log.info("connecting to user WS");

    const ws = new WebSocket(this.cfg.url);
    this.ws = ws;

    ws.on("open", () => {
      log.info("connected; sending auth");
      this.backoffMs = 1_000;
      ws.send(
        JSON.stringify({
          type: "User",
          auth: {
            apiKey: this.cfg.apiKey,
            secret: this.cfg.apiSecret,
            passphrase: this.cfg.apiPassphrase,
          },
          markets: [],
        }),
      );
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      log.warn({ len: data.length }, "user WS got non-JSON");
      return;
    }
    if (Array.isArray(parsed)) {
      for (const event of parsed) await this.dispatch(event as UserWsEvent, log);
      return;
    }
    await this.dispatch(parsed as UserWsEvent, log);
  }

  private async dispatch(event: UserWsEvent, log: typeof logger): Promise<void> {
    if (event.type === "OrderFilled") {
      log.info(
        {
          orderID: event.orderID,
          side: event.side,
          size: event.size,
          txHash: event.transactionHash,
        },
        "fill received",
      );
      try {
        await this.cfg.handler.onFill(event);
      } catch (err) {
        log.error({ err, orderID: event.orderID }, "fill handler threw");
      }
      return;
    }
    if (event.type === "OrderCanceled") {
      log.info({ orderID: event.orderID, reason: event.reason }, "cancel received");
      try {
        await this.cfg.handler.onCancel(event);
      } catch (err) {
        log.error({ err, orderID: event.orderID }, "cancel handler threw");
      }
      return;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    setTimeout(() => this.connect(), delay).unref?.();
  }
}

export function fillReconcilerFromEnv(
  handler: FillHandler,
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
    ...(onConnect ? { onConnect } : {}),
  });
}
