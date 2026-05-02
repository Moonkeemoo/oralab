/**
 * Manually close all on-chain positions via FOK SELL at best bid - slippage.
 * Bypasses KILL_SWITCH (it lives in order_manager.placeSell wrapper); we use
 * ClobClient directly here for emergency exit.
 *
 * For each /positions row:
 *   1. fetch /book → take best bid
 *   2. compute minPrice = bid × (1 - SLIPPAGE_PCT)
 *   3. tick-floor minPrice
 *   4. createAndPostMarketOrder(SELL, amount=shares, price=minPrice) FOK
 *   5. record outcome
 */
import process from "node:process";
import { OrderType, Side, type TickSize } from "@polymarket/clob-client-v2";
import { getBookTop } from "../src/api/book.js";
import { getClobClient } from "../src/api/clob.js";
import { getActivity, getPositions } from "../src/api/data.js";
import { getMarketByTokenId } from "../src/api/gamma.js";

const SLIPPAGE_PCT = Number(process.env["EXIT_SLIPPAGE_PCT"] ?? 0.2);

function tickFloor(price: number, tickSize: number): number {
  return Math.floor(price / tickSize + 1e-9) * tickSize;
}

function asTickSize(t: number): TickSize {
  const s = String(t);
  if (s === "0.1" || s === "0.01" || s === "0.001" || s === "0.0001") return s;
  throw new Error(`unsupported tickSize ${t}`);
}

interface ExitResult {
  asset: string;
  title: string;
  shares: number;
  bid: number;
  sentMinPrice: number;
  ok: boolean;
  filledShares: number;
  errorMsg?: string;
  status?: string;
  orderId?: string;
}

async function exitOne(
  client: ReturnType<typeof getClobClient>["client"],
  pos: { asset: string; size: number; title?: string; conditionId: string },
): Promise<ExitResult> {
  const market = await getMarketByTokenId(pos.asset);
  const tickSize = market?.orderPriceMinTickSize ?? 0.01;
  const negRisk = market?.negRisk ?? false;
  const book = await getBookTop(pos.asset);
  const bid = book.bid;
  if (bid <= 0) {
    return {
      asset: pos.asset,
      title: pos.title ?? "?",
      shares: pos.size,
      bid,
      sentMinPrice: 0,
      ok: false,
      filledShares: 0,
      errorMsg: "no bid available",
    };
  }
  const minPriceRaw = bid * (1 - SLIPPAGE_PCT);
  const minPrice = Math.max(tickFloor(minPriceRaw, tickSize), tickSize);

  console.log(
    `\n→ ${pos.title?.slice(0, 60)}\n  shares=${pos.size}  bid=${bid}  sending FOK SELL at minPrice=${minPrice} (slippage ${SLIPPAGE_PCT * 100}%)`,
  );

  try {
    const resp = (await client.createAndPostMarketOrder(
      {
        tokenID: pos.asset,
        price: minPrice,
        side: Side.SELL,
        amount: pos.size,
      } as Parameters<typeof client.createAndPostMarketOrder>[0],
      { tickSize: asTickSize(tickSize), negRisk },
      OrderType.FAK,
    )) as {
      success?: boolean;
      orderID?: string;
      errorMsg?: string;
      status?: string;
      takingAmount?: string;
      makingAmount?: string;
      transactionsHashes?: string[];
    };

    const filled = Number(resp.takingAmount ?? 0);
    const txCount = resp.transactionsHashes?.length ?? 0;
    const ok = resp.success === true && (filled > 0 || txCount > 0);
    return {
      asset: pos.asset,
      title: pos.title ?? "?",
      shares: pos.size,
      bid,
      sentMinPrice: minPrice,
      ok,
      filledShares: filled,
      errorMsg: resp.errorMsg ?? undefined,
      status: resp.status,
      orderId: resp.orderID,
    };
  } catch (err) {
    return {
      asset: pos.asset,
      title: pos.title ?? "?",
      shares: pos.size,
      bid,
      sentMinPrice: minPrice,
      ok: false,
      filledShares: 0,
      errorMsg: (err as Error).message,
    };
  }
}

async function main(): Promise<void> {
  const { client, walletAddress } = getClobClient();
  console.log("wallet:", walletAddress);

  const positions = await getPositions(walletAddress);
  console.log(`open positions: ${positions.length}`);
  if (positions.length === 0) {
    console.log("nothing to exit");
    return;
  }

  const results: ExitResult[] = [];
  // Sequential to avoid hitting same book twice on same asset within ms
  for (const pos of positions) {
    const r = await exitOne(client, {
      asset: pos.asset,
      size: pos.size,
      title: pos.title,
      conditionId: pos.conditionId,
    });
    results.push(r);
    console.log(
      `  → ok=${r.ok}  filled=${r.filledShares}  status=${r.status ?? "?"}  err=${r.errorMsg ?? ""}`,
    );
    // small delay so book settles
    await new Promise((res) => setTimeout(res, 800));
  }

  console.log("\n=== summary ===");
  for (const r of results)
    console.log(`  ${r.ok ? "✅" : "❌"}  ${r.title.slice(0, 50)}: ${r.filledShares}/${r.shares}`);

  // Pull fresh /positions + /activity to verify
  await new Promise((r) => setTimeout(r, 5_000));
  const stillOpen = await getPositions(walletAddress);
  const recent = await getActivity(walletAddress, { limit: 10, type: "TRADE" });
  console.log(`\nstill open: ${stillOpen.length}`);
  for (const p of stillOpen) console.log(`  ${p.size} shares  ${p.title?.slice(0, 60)}`);
  console.log("\nlast 5 chain trades:");
  for (const a of recent.slice(0, 5))
    console.log(
      `  ${Math.floor(Date.now() / 1000 - a.timestamp)}s ago: ${a.side} ${a.size}@${a.price} → ${a.title?.slice(0, 50)}`,
    );
}

await main();
