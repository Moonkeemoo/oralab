import process from "node:process";
import { ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { logger } from "../obs/logger.js";

let _client: ClobClient | null = null;
let _walletAddress: string | null = null;

interface ClobEnv {
  privateKey: Hex;
  walletAddress: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  host: string;
  chainId: number;
  signatureType: number;
}

function readEnv(): ClobEnv {
  const required = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`env ${name} not set`);
    return v;
  };

  const privateKey = required("POLY_PRIVATE_KEY") as Hex;
  if (!privateKey.startsWith("0x") || privateKey.length !== 66) {
    throw new Error("POLY_PRIVATE_KEY must be 0x-prefixed 32-byte hex");
  }

  return {
    privateKey,
    walletAddress: required("POLY_WALLET_ADDRESS"),
    apiKey: required("POLY_API_KEY"),
    apiSecret: required("POLY_API_SECRET"),
    apiPassphrase: required("POLY_API_PASSPHRASE"),
    host: process.env["CLOB_URL"] ?? "https://clob.polymarket.com",
    chainId: Number(process.env["CHAIN_ID"] ?? 137),
    signatureType: 1,
  };
}

/**
 * Lazy ClobClient singleton. Initialized on first call. Reuses viem WalletClient
 * for signing. signatureType=1 (proxy/funder) for solo P1 — same as v1.
 *
 * No `builderConfig` is passed: the Polymarket Builder Program is not available
 * to us per kickoff decisions (see CLAUDE.md). Order payloads omit `builder` field.
 */
export function getClobClient(): { client: ClobClient; walletAddress: string } {
  if (_client) {
    if (!_walletAddress) throw new Error("ClobClient initialized without wallet address");
    return { client: _client, walletAddress: _walletAddress };
  }

  const env = readEnv();
  const account = privateKeyToAccount(env.privateKey);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  _client = new ClobClient({
    host: env.host,
    chain: env.chainId,
    signer: walletClient,
    creds: {
      key: env.apiKey,
      secret: env.apiSecret,
      passphrase: env.apiPassphrase,
    },
    signatureType: env.signatureType,
    funderAddress: env.walletAddress,
  });
  _walletAddress = env.walletAddress;

  logger.info(
    {
      host: env.host,
      chainId: env.chainId,
      signatureType: env.signatureType,
      signerDerivedAddress: account.address,
      funderAddress: env.walletAddress,
    },
    "ClobClient initialized",
  );

  return { client: _client, walletAddress: _walletAddress };
}

export function isDryRun(): boolean {
  return (process.env["DRY_RUN"] ?? "true").toLowerCase() === "true";
}

export function isKillSwitchActive(): boolean {
  return (process.env["KILL_SWITCH"] ?? "false").toLowerCase() === "true";
}
