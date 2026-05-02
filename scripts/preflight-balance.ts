/**
 * Pre-flight: read pUSD balance + token allowance via clob-client-v2.
 * READ-ONLY — never posts an order. Safe to run with DRY_RUN=true OR false.
 */
import process from "node:process";
import { getClobClient } from "../src/api/clob.js";

async function main(): Promise<void> {
  const { client, walletAddress } = getClobClient();
  console.log("wallet:", walletAddress);

  try {
    const collateral = await client.getBalanceAllowance({
      asset_type: "COLLATERAL",
    } as Parameters<typeof client.getBalanceAllowance>[0]);
    console.log("pUSD (collateral) balance:", JSON.stringify(collateral, null, 2));
  } catch (err) {
    console.error("getBalanceAllowance(COLLATERAL) failed:", (err as Error).message);
    process.exitCode = 1;
  }
}

await main();
