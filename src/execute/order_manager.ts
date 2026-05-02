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

/**
 * UserMarketOrderV2.amount semantics (clob-client-v2 v1.0.2):
 *   BUY  → USD ($) to spend
 *   SELL → shares to sell
 *
 * BuyParams therefore carries `usdAmount` (USD to spend) NOT shares.
 * Actual filled shares come from the fill events.
 */
export interface BuyParams {
  readonly userId: number;
  readonly tokenId: string;
  readonly price: number;
  readonly usdAmount: number;
  readonly tickSize: number;
  readonly negRisk: boolean;
  readonly correlationId?: string;
}

export interface SellParams {
  readonly userId: number;
  readonly tokenId: string;
  readonly price: number;
  readonly sizeShares: number;
  readonly tickSize: number;
  readonly negRisk: boolean;
  readonly correlationId?: string;
  readonly expirationTs: number;
  /**
   * Sell mode. GTD/GTC use createAndPostOrder (limit). FOK/FAK use
   * createAndPostMarketOrder (market) — for emergency dump-at-floor exits.
   */
  readonly orderType: "GTD" | "GTC" | "FOK" | "FAK";
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
    usdAmount: params.usdAmount,
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
      takingAmount: String(params.usdAmount),
      dry: true,
    };
  }

  return await withSpan("clob.placeBuy", async (span) => {
    const start = performance.now();
    const { client } = getClobClient();
    span.setAttribute("token_id", params.tokenId);
    span.setAttribute("price", params.price);
    span.setAttribute("usd_amount", params.usdAmount);

    // Pre-flight pUSD: refuse to attempt if we don't have at least usdAmount
    // of collateral available. Saves a CLOB roundtrip on a doomed order and
    // avoids any chance of partial-overshoot.
    let effectiveUsd = params.usdAmount;
    try {
      const ba = (await client.getBalanceAllowance({
        asset_type: "COLLATERAL",
      } as Parameters<typeof client.getBalanceAllowance>[0])) as {
        balance?: string | number;
      };
      // pUSD is 6-decimal ERC20; SDK returns raw integer string of microunits
      const microUnits = Number(ba.balance ?? 0);
      const pUsdAvailable = microUnits / 1e6;
      if (pUsdAvailable < params.usdAmount) {
        log.warn(
          { pUsdAvailable, requested: params.usdAmount },
          "INV-M1 pre-flight: pUSD < requested usdAmount; capping or rejecting",
        );
        if (pUsdAvailable <= 0) {
          recordOutcome("placeBuy", "no_pusd", false);
          return {
            success: false,
            clientOrderId,
            errorCode: "no_pusd",
            status: "PREFLIGHT_REJECTED",
            dry: false,
          };
        }
        effectiveUsd = pUsdAvailable;
      }
    } catch (err) {
      log.warn({ err }, "getBalanceAllowance(COLLATERAL) failed; proceeding with intent amount");
    }

    try {
      const resp: unknown = await client.createAndPostMarketOrder(
        {
          tokenID: params.tokenId,
          price: params.price,
          side: Side.BUY,
          // UserMarketOrderV2.amount for BUY is USD to spend (clob-client-v2 docs).
          amount: effectiveUsd,
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
        makingAmount?: string;
        transactionsHashes?: string[];
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
      // FOK semantics: must fill immediately or be killed. Polymarket V2 returns
      // success=true with status="delayed" + empty making/taking when the FOK
      // couldn't match (book moved, partial-only, etc). Treat that as failure.
      const filledShares = Number(r.takingAmount ?? 0);
      const txCount = r.transactionsHashes?.length ?? 0;
      if (filledShares <= 0 && txCount === 0) {
        log.warn(
          { status: r.status, making: r.makingAmount, taking: r.takingAmount, txs: txCount },
          "placeBuy success=true but FOK didn't fill — treating as kill",
        );
        recordOutcome("placeBuy", "fok_unfilled", false);
        return {
          success: false,
          clientOrderId,
          clobOrderId: r.orderID,
          errorCode: "fok_unfilled",
          status: r.status ?? "FOK_KILLED",
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

  // KILL_SWITCH must NEVER block SELL: if there's a problem we always need to
  // be able to exit existing positions. KILL only halts NEW BUYs.
  // Per `feedback_bulletproof_live.md`.

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
      const isMarketOrder = params.orderType === "FOK" || params.orderType === "FAK";
      const resp: unknown = isMarketOrder
        ? await client.createAndPostMarketOrder(
            {
              tokenID: params.tokenId,
              price: params.price,
              side: Side.SELL,
              amount: effectiveSize,
            } as Parameters<typeof client.createAndPostMarketOrder>[0],
            { tickSize: tickAsTickSize(params.tickSize), negRisk: params.negRisk },
            params.orderType === "FOK" ? OrderType.FOK : OrderType.FAK,
          )
        : await client.createAndPostOrder(
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
        makingAmount?: string;
        transactionsHashes?: string[];
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
      // For FOK SELL: must fill immediately or be killed. Same delayed-with-no-fill
      // pattern as BUY — treat as failure so executor retries with widened slippage.
      if (params.orderType === "FOK") {
        const filled = Number(r.takingAmount ?? 0);
        const txCount = r.transactionsHashes?.length ?? 0;
        if (filled <= 0 && txCount === 0) {
          log.warn(
            { status: r.status, taking: r.takingAmount, txs: txCount },
            "placeSell FOK didn't fill — treating as kill",
          );
          recordOutcome("placeSell", "fok_unfilled", false);
          return {
            success: false,
            clientOrderId,
            clobOrderId: r.orderID,
            errorCode: "fok_unfilled",
            status: r.status ?? "FOK_KILLED",
            raw: resp,
            dry: false,
          };
        }
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

/**
 * QA-174: actively enumerate open orders for an asset and cancel them all.
 * Avoid double-placing on sweep retries. Idempotent: returns count cancelled.
 */
export async function cancelOpenOrdersForAsset(
  assetId: string,
  side?: "BUY" | "SELL",
): Promise<{ cancelled: number }> {
  if (isDryRun()) return { cancelled: 0 };
  return await withSpan("clob.cancel_for_asset", async (span) => {
    span.setAttribute("asset_id", assetId);
    if (side) span.setAttribute("side", side);
    try {
      const { client } = getClobClient();
      const open = (await client.getOpenOrders()) as
        | { id: string; asset_id?: string; side?: string }[]
        | { results?: { id: string; asset_id?: string; side?: string }[] };
      const list = Array.isArray(open) ? open : (open.results ?? []);
      const matches = list.filter(
        (o) => o.asset_id === assetId && (!side || (o.side ?? "").toUpperCase() === side),
      );
      let cancelled = 0;
      for (const o of matches) {
        try {
          await client.cancelOrder({ orderID: o.id });
          cancelled += 1;
        } catch (err) {
          logger.warn({ err, orderId: o.id }, "cancelOpenOrdersForAsset: cancel one failed");
        }
      }
      span.setAttribute("cancelled", cancelled);
      return { cancelled };
    } catch (err) {
      logger.warn({ err, assetId }, "cancelOpenOrdersForAsset: enumerate failed");
      return { cancelled: 0 };
    }
  });
}
