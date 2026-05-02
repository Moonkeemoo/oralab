import process from "node:process";
import { WebSocket } from "ws";

const url =
  process.env["CLOB_WS_USER_URL"] ?? "wss://ws-subscriptions-clob.polymarket.com/ws/user";
const apiKey = process.env["POLY_API_KEY"];
const apiSecret = process.env["POLY_API_SECRET"];
const apiPassphrase = process.env["POLY_API_PASSPHRASE"];

if (!apiKey || !apiSecret || !apiPassphrase) {
  console.error("missing POLY_API_KEY / POLY_API_SECRET / POLY_API_PASSPHRASE in env");
  process.exit(1);
}

const conditionIds = [
  "0x335e3205193bdd066fd8a2df2d08d593c9d51bb0a6b17ed609a05642ffd39121",
  "0xc7cbfbd66a2d2988a0a806cc7ecb5f5aeb72b97196ec5a66d6d947a4de0dd4f8",
];
const VARIANTS: { label: string; payload: object; tapMs?: number }[] = [
  {
    label: "v5 (per-docs): type:user lowercase + markets:[conditions]",
    payload: {
      type: "user",
      auth: { apiKey, secret: apiSecret, passphrase: apiPassphrase },
      markets: conditionIds,
    },
    tapMs: 30_000,
  },
];

let variantIdx = 0;
const elapsedMs = (start: number): number => Date.now() - start;

function tap(label: string, payload: object, tapMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    console.log(`\n--- variant: ${label} ---`);
    console.log(`> subscribe: ${JSON.stringify(payload).slice(0, 200)}`);
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      console.log(`[${elapsedMs(start)}ms] timeout — closing`);
      ws.close();
    }, tapMs);

    ws.on("open", () => {
      console.log(`[${elapsedMs(start)}ms] open — sending payload`);
      ws.send(JSON.stringify(payload));
    });
    ws.on("message", (data) => {
      const text = data.toString();
      console.log(`[${elapsedMs(start)}ms] msg (${text.length}b): ${text.slice(0, 400)}`);
    });
    ws.on("ping", () => {
      console.log(`[${elapsedMs(start)}ms] ping`);
      ws.pong();
    });
    ws.on("pong", () => console.log(`[${elapsedMs(start)}ms] pong`));
    ws.on("close", (code, reason) => {
      console.log(`[${elapsedMs(start)}ms] close code=${code} reason=${reason.toString()}`);
      clearTimeout(timer);
      resolve();
    });
    ws.on("error", (err) => console.log(`[${elapsedMs(start)}ms] error: ${(err as Error).message}`));
  });
}

(async (): Promise<void> => {
  for (const v of VARIANTS) {
    await tap(v.label, v.payload, v.tapMs ?? 30_000);
    variantIdx += 1;
  }
  console.log(`\ndone (${variantIdx} variants)`);
  process.exit(0);
})();
