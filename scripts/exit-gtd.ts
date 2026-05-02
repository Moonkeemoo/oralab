/**
 * GTD limit-SELL fallback for FOK/FAK kills. Places SELL at bid (or bid+1tick
 * to attract maker side) for 60s.
 */
import process from "node:process";
import { OrderType, Side, type TickSize } from "@polymarket/clob-client-v2";
import { getBookTop } from "../src/api/book.js";
import { getClobClient } from "../src/api/clob.js";
import { getPositions } from "../src/api/data.js";
import { getMarketByTokenId } from "../src/api/gamma.js";

function tickFloor(price: number, tickSize: number): number {
  return Math.floor(price / tickSize + 1e-9) * tickSize;
}

function asTickSize(t: number): TickSize {
  const s = String(t);
  if (s === "0.1" || s === "0.01" || s === "0.001" || s === "0.0001") return s;
  throw new Error(`unsupported tickSize ${t}`);
}

async function main(): Promise<void> {
  const { client, walletAddress } = getClobClient();
  console.log("wallet:", walletAddress);
  const positions = await getPositions(walletAddress);
  console.log(`open: ${positions.length}`);

  for (const pos of positions) {
    const market = await getMarketByTokenId(pos.asset);
    const tickSize = market?.orderPriceMinTickSize ?? 0.01;
    const negRisk = market?.negRisk ?? false;
    const book = await getBookTop(pos.asset);

    // Limit order at bid: hits next taker (or sits 60s); aligned to tick.
    const limitPrice = tickFloor(book.bid, tickSize);
    if (limitPrice <= 0) {
      console.log(`skip (no bid): ${pos.title?.slice(0, 50)}`);
      continue;
    }
    const expiration = Math.floor(Date.now() / 1000) + 60;
    console.log(
      `\n→ ${pos.title?.slice(0, 60)}\n  shares=${pos.size}  bid=${book.bid}  GTD SELL at ${limitPrice} expires=+60s`,
    );

    try {
      const resp = (await client.createAndPostOrder(
        {
          tokenID: pos.asset,
          price: limitPrice,
          side: Side.SELL,
          size: pos.size,
          expiration,
        } as Parameters<typeof client.createAndPostOrder>[0],
        { tickSize: asTickSize(tickSize), negRisk },
        OrderType.GTD,
        false,
      )) as {
        success?: boolean;
        orderID?: string;
        status?: string;
        errorMsg?: string;
        takingAmount?: string;
        transactionsHashes?: string[];
      };

      console.log(
        `  → success=${resp.success}  status=${resp.status}  taking=${resp.takingAmount ?? 0}  txs=${resp.transactionsHashes?.length ?? 0}  err=${resp.errorMsg ?? ""}`,
      );
    } catch (err) {
      console.error(`  → threw: ${(err as Error).message}`);
    }
  }
  console.log("\nGTD orders posted; will sit in book for 60s.");
}

await main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
