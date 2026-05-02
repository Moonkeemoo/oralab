import process from "node:process";
import { type Message, RealTimeDataClient } from "@polymarket/real-time-data-client";
import type { DataActivity } from "../api/data.js";
import { logger } from "../obs/logger.js";

/**
 * RTDS WebSocket feed — Polymarket's official real-time data service.
 *
 * Topic: "activity", Type: "trades" — server-side firehose of ALL trade
 * clearings. Sub-second latency, no rate limits, no per-wallet polling.
 * Source-of-truth: v1 bots/rtds_feed.py — proven via 4 months of prod use.
 *
 * Server-side filter on activity/trades is broken (Polymarket RTDS GitHub
 * issue #34) — we receive ALL trades and filter to tracked whales here.
 *
 * Outputs DataActivity-shaped objects (matches our existing routeWhaleBuy
 * contract) for any whale BUY in the tracked set.
 */

interface RtdsHandler {
  onWhaleBuy(whaleAddress: string, activity: DataActivity): Promise<void> | void;
}

interface RtdsFeedOptions {
  readonly host?: string;
  readonly minUsdValue?: number;
  readonly handler: RtdsHandler;
  readonly isWhaleTracked: (addr: string) => Promise<boolean> | boolean;
}

interface TradePayload {
  size?: number | string;
  amount?: number | string;
  shares?: number | string;
  price?: number | string;
  executionPrice?: number | string;
  side?: string;
  action?: string;
  proxyWallet?: string;
  proxy_wallet?: string;
  user?: string;
  maker?: string;
  taker?: string;
  address?: string;
  timestamp?: number | string;
  ts?: number | string;
  asset?: string;
  token_id?: string;
  conditionId?: string;
  condition_id?: string;
  transactionHash?: string;
  transaction_hash?: string;
  txHash?: string;
  slug?: string;
  marketSlug?: string;
  market?: string;
  outcome?: string;
  outcomeName?: string;
}

function normalizeSide(raw: string | undefined): "BUY" | "SELL" | null {
  const s = (raw ?? "").toUpperCase();
  if (s === "BUY" || s === "MAKER" || s === "LONG") return "BUY";
  if (s === "SELL" || s === "TAKER" || s === "SHORT") return "SELL";
  return null;
}

function pickWallet(p: TradePayload): string | null {
  const w = p.proxyWallet ?? p.proxy_wallet ?? p.user ?? p.maker ?? p.taker ?? p.address;
  if (!w) return null;
  return String(w).toLowerCase();
}

function pickTimestampSec(p: TradePayload): number {
  const raw = Number(p.timestamp ?? p.ts ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return Math.floor(Date.now() / 1000);
  // Heuristic: > 1e12 → milliseconds
  return raw > 1_000_000_000_000 ? Math.floor(raw / 1000) : raw;
}

function pickAssetId(p: TradePayload): string | null {
  return (p.asset ?? p.token_id ?? null) as string | null;
}

function normalizeTrade(payload: TradePayload): DataActivity | null {
  const size = Number(payload.size ?? payload.amount ?? payload.shares ?? 0);
  const price = Number(payload.price ?? payload.executionPrice ?? 0);
  if (!Number.isFinite(size) || !Number.isFinite(price)) return null;
  if (size <= 0 || price <= 0 || price >= 1) return null;

  const side = normalizeSide(payload.side ?? payload.action);
  if (!side) return null;
  const assetId = pickAssetId(payload);
  if (!assetId) return null;
  const conditionId = String(payload.conditionId ?? payload.condition_id ?? "");
  if (!conditionId) return null;

  return {
    asset: assetId,
    conditionId,
    side,
    size,
    price,
    timestamp: pickTimestampSec(payload),
    transactionHash: String(
      payload.transactionHash ?? payload.transaction_hash ?? payload.txHash ?? "",
    ).toLowerCase(),
    fee: 0,
    title: String(payload.slug ?? payload.marketSlug ?? payload.market ?? ""),
  };
}

export class RtdsFeed {
  private client: RealTimeDataClient | null = null;
  private readonly minUsdValue: number;
  private stopped = false;

  constructor(private readonly options: RtdsFeedOptions) {
    this.minUsdValue = options.minUsdValue ?? Number(process.env["RTDS_MIN_USD_VALUE"] ?? 50);
  }

  start(): void {
    this.stopped = false;
    const host =
      this.options.host ?? process.env["RTDS_WS_URL"] ?? "wss://ws-live-data.polymarket.com";
    logger.info({ host, minUsdValue: this.minUsdValue }, "RtdsFeed connecting");

    this.client = new RealTimeDataClient({
      host,
      autoReconnect: true,
      pingInterval: 5_000,
      onConnect: (c) => {
        logger.info("RTDS connected, subscribing to activity/trades");
        c.subscribe({
          subscriptions: [{ topic: "activity", type: "trades" }],
        });
      },
      onMessage: (_c, msg) => void this.handleMessage(msg),
      onStatusChange: (status) => logger.info({ status }, "RTDS status"),
    });
    this.client.connect();
  }

  stop(): void {
    this.stopped = true;
    this.client?.disconnect();
    this.client = null;
    logger.info("RtdsFeed stopped");
  }

  private async handleMessage(msg: Message): Promise<void> {
    if (this.stopped) return;
    if (msg.topic !== "activity" || msg.type !== "trades") return;
    const trade = normalizeTrade(msg.payload as TradePayload);
    if (!trade) return;

    const usdValue = trade.size * trade.price;
    if (usdValue < this.minUsdValue) return;

    const wallet = pickWallet(msg.payload as TradePayload);
    if (!wallet) return;

    const tracked = await this.options.isWhaleTracked(wallet);
    if (!tracked) return;
    if (trade.side !== "BUY") return;

    try {
      await this.options.handler.onWhaleBuy(wallet, trade);
    } catch (err) {
      logger.error({ err, wallet, asset: trade.asset }, "rtds handler threw");
    }
  }
}
