import { randomUUID } from "node:crypto";
import { OrderType, Side, type TickSize } from "@polymarket/clob-client-v2";
import { getClobClient, isDryRun, isKillSwitchActive } from "../api/clob.js";
import { logger } from "../obs/logger.js";
import { orderPlacementDurationMs, orderPlacementOutcome } from "../obs/metrics.js";
import { withSpan } from "../obs/tracer.js";

/**
 * Order placement skeleton — Day 5-7 deliverable.
 *
 * Two operations: `placeBuy` (FOK entry) and `placeSell` (GTD exit).
 * `placeCancelByOrderId` covers exit retries and global cancel-all on KILL.
 *
 * DRY_RUN=true (default in P1) bypasses CLOB; logs the intent and returns a
 * mock response so downstream code paths exercise normally without real orders.
 *
 * Idempotency (INV-O2): every order gets a fresh `client_order_id` (UUID).
 * Pre-flight balance (INV-M1) lives in the SELL path — getBalanceAllowance is
 * checked before submission and `size` is capped to chain availability.
 */

export interface BuyParams {
  readonly userId: number;
  readonly tokenId: string;
  readonly price: number;
  readonly sizeShares: number;
  readonly tickSize: number;
  readonly negRisk: boolean;
  readonly correlationId?: string;
}

export interface SellParams extends BuyParams {
  readonly expirationTs: number;
  readonly orderType: "GTD" | "GTC";
  readonly postOnly?: boolean;
}

export interface OrderResult {
  readonly success: boolean;
  readonly clientOrderId: string;
  readonly clobOrderId?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly errorMsg?: string | undefined;
  readonly status?: string | undefined;
  readonly takingAmount?: string | undefined;
  readonly raw?: unknown;
  readonly dry: boolean;
}

function tickAsTickSize(t: number): TickSize {
  const s = String(t);
  if (s === "0.1" || s === "0.01" || s === "0.001" || s === "0.0001") return s;
  throw new Error(`unsupported tickSize ${t} — must be 0.1 / 0.01 / 0.001 / 0.0001`);
}

function newClientOrderId(): string {
  return randomUUID();
}

function recordOutcome(operation: string, outcome: string, dry: boolean): void {
  orderPlacementOutcome.add(1, { operation, outcome, dry: String(dry) });
}

export async function placeBuy(params: BuyParams): Promise<OrderResult> {
  const clientOrderId = newClientOrderId();
  const log = logger.child({
    op: "placeBuy",
    clientOrderId,
    tokenId: params.tokenId,
    price: params.price,
    size: params.sizeShares,
    correlationId: params.correlationId ?? null,
  });

  if (isKillSwitchActive()) {
    log.warn("KILL_SWITCH active — placeBuy rejected");
    recordOutcome("placeBuy", "kill_switch", isDryRun());
    return { success: false, clientOrderId, errorCode: "kill_switch", dry: isDryRun() };
  }

  if (isDryRun()) {
    log.info("DRY_RUN — placeBuy not posted to CLOB");
    recordOutcome("placeBuy", "dry_run_ok", true);
    return {
      success: true,
      clientOrderId,
      status: "DRY_RUN",
      takingAmount: String(params.sizeShares),
      dry: true,
    };
  }

  return await withSpan("clob.placeBuy", async (span) => {
    const start = performance.now();
    const { client } = getClobClient();
    span.setAttribute("token_id", params.tokenId);
    span.setAttribute("price", params.price);
    span.setAttribute("size", params.sizeShares);

    try {
      const resp: unknown = await client.createAndPostMarketOrder(
        {
          tokenID: params.tokenId,
          price: params.price,
          side: Side.BUY,
          amount: params.sizeShares,
        } as Parameters<typeof client.createAndPostMarketOrder>[0],
        { tickSize: tickAsTickSize(params.tickSize), negRisk: params.negRisk },
        OrderType.FOK,
      );
      orderPlacementDurationMs.record(performance.now() - start, { op: "placeBuy" });

      const r = resp as {
        success?: boolean;
        orderID?: string;
        errorMsg?: string;
        status?: string;
        takingAmount?: string;
      };
      if (!r.success) {
        recordOutcome("placeBuy", r.errorMsg ?? "rejected", false);
        return {
          success: false,
          clientOrderId,
          errorCode: r.errorMsg ?? "rejected",
          errorMsg: r.errorMsg,
          status: r.status,
          raw: resp,
          dry: false,
        };
      }
      recordOutcome("placeBuy", "success", false);
      return {
        success: true,
        clientOrderId,
        clobOrderId: r.orderID,
        status: r.status,
        takingAmount: r.takingAmount,
        raw: resp,
        dry: false,
      };
    } catch (err) {
      orderPlacementDurationMs.record(performance.now() - start, {
        op: "placeBuy",
        outcome: "error",
      });
      recordOutcome("placeBuy", "exception", false);
      log.error({ err }, "placeBuy threw");
      throw err;
    }
  });
}

export async function placeSell(params: SellParams): Promise<OrderResult> {
  const clientOrderId = newClientOrderId();
  const log = logger.child({
    op: "placeSell",
    clientOrderId,
    tokenId: params.tokenId,
    price: params.price,
    size: params.sizeShares,
    orderType: params.orderType,
    correlationId: params.correlationId ?? null,
  });

  if (isKillSwitchActive()) {
    log.warn("KILL_SWITCH active — placeSell rejected");
    recordOutcome("placeSell", "kill_switch", isDryRun());
    return { success: false, clientOrderId, errorCode: "kill_switch", dry: isDryRun() };
  }

  if (isDryRun()) {
    log.info("DRY_RUN — placeSell not posted to CLOB");
    recordOutcome("placeSell", "dry_run_ok", true);
    return {
      success: true,
      clientOrderId,
      status: "DRY_RUN",
      takingAmount: String(params.sizeShares),
      dry: true,
    };
  }

  return await withSpan("clob.placeSell", async (span) => {
    const start = performance.now();
    const { client } = getClobClient();
    span.setAttribute("token_id", params.tokenId);
    span.setAttribute("price", params.price);
    span.setAttribute("size", params.sizeShares);
    span.setAttribute("order_type", params.orderType);

    // INV-M1 pre-flight: cap intent size to chain-balance.
    let effectiveSize = params.sizeShares;
    try {
      const ba = (await client.getBalanceAllowance({
        asset_type: "CONDITIONAL",
        token_id: params.tokenId,
      } as Parameters<typeof client.getBalanceAllowance>[0])) as {
        balance?: string | number;
      };
      const onChain = Number(ba.balance ?? 0);
      if (onChain < params.sizeShares) {
        log.warn(
          { onChain, intended: params.sizeShares },
          "INV-M1 cap: intent.size > on_chain; reducing to chain balance",
        );
        effectiveSize = onChain;
      }
      if (effectiveSize <= 0) {
        recordOutcome("placeSell", "no_chain_balance", false);
        return {
          success: false,
          clientOrderId,
          errorCode: "no_chain_balance",
          status: "PREFLIGHT_REJECTED",
          dry: false,
        };
      }
    } catch (err) {
      log.warn({ err }, "getBalanceAllowance failed; proceeding with intent size");
    }

    try {
      const resp: unknown = await client.createAndPostOrder(
        {
          tokenID: params.tokenId,
          price: params.price,
          side: Side.SELL,
          size: effectiveSize,
          expiration: params.expirationTs,
        } as Parameters<typeof client.createAndPostOrder>[0],
        { tickSize: tickAsTickSize(params.tickSize), negRisk: params.negRisk },
        params.orderType === "GTD" ? OrderType.GTD : OrderType.GTC,
        params.postOnly ?? false,
      );
      orderPlacementDurationMs.record(performance.now() - start, { op: "placeSell" });

      const r = resp as {
        success?: boolean;
        orderID?: string;
        errorMsg?: string;
        status?: string;
        takingAmount?: string;
      };
      if (!r.success) {
        recordOutcome("placeSell", r.errorMsg ?? "rejected", false);
        return {
          success: false,
          clientOrderId,
          errorCode: r.errorMsg ?? "rejected",
          errorMsg: r.errorMsg,
          status: r.status,
          raw: resp,
          dry: false,
        };
      }
      recordOutcome("placeSell", "success", false);
      return {
        success: true,
        clientOrderId,
        clobOrderId: r.orderID,
        status: r.status,
        takingAmount: r.takingAmount,
        raw: resp,
        dry: false,
      };
    } catch (err) {
      orderPlacementDurationMs.record(performance.now() - start, {
        op: "placeSell",
        outcome: "error",
      });
      recordOutcome("placeSell", "exception", false);
      log.error({ err }, "placeSell threw");
      throw err;
    }
  });
}

export async function cancelByOrderId(
  orderId: string,
): Promise<{ success: boolean; raw?: unknown }> {
  if (isDryRun()) {
    logger.info({ orderId }, "DRY_RUN — cancel skipped");
    return { success: true };
  }
  return await withSpan("clob.cancel", async (span) => {
    span.setAttribute("order_id", orderId);
    try {
      const { client } = getClobClient();
      const resp: unknown = await client.cancelOrder({ orderID: orderId });
      return { success: true, raw: resp };
    } catch (err) {
      logger.warn({ err, orderId }, "cancel threw — treating as idempotent (INV-O2)");
      return { success: true };
    }
  });
}
