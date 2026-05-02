import process from "node:process";
import { getClobClient } from "../src/api/clob.js";

async function main(): Promise<void> {
  const orderId = process.argv[2];
  if (!orderId) {
    console.error("usage: check-order.ts <orderId>");
    process.exit(1);
  }
  const { client } = getClobClient();
  // raw HTTP — CLOB has GET /order/{id} per POLYMARKET_API.md
  const host = process.env["CLOB_URL"] ?? "https://clob.polymarket.com";
  // Use the SDK's auth header builder via direct call
  try {
    const open = await client.getOpenOrders();
    console.log("open orders count:", JSON.stringify(open, null, 2).slice(0, 1000));
  } catch (err) {
    console.error("getOpenOrders failed:", (err as Error).message);
  }
  try {
    const url = `${host}/order/${orderId}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    console.log("HTTP", res.status, await res.text());
  } catch (err) {
    console.error("direct GET failed:", (err as Error).message);
  }
}
await main();
