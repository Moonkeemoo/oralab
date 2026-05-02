import process from "node:process";
import { fetchJson } from "./http.js";

/**
 * CLOB /book client — REAL bid/ask source. NEVER /midpoint (QA-180).
 *
 * Bid/ask arrays are NOT guaranteed sorted — always Math.max for top bid,
 * Math.min for top ask. Returns the top-of-book pair plus the full snapshot
 * timestamp.
 */

const CLOB_URL = process.env["CLOB_URL"] ?? "https://clob.polymarket.com";

interface BookEntry {
  price: string;
  size: string;
}

interface BookRaw {
  market: string;
  asset_id: string;
  bids: BookEntry[];
  asks: BookEntry[];
  hash: string;
  timestamp: string;
}

export interface BookTop {
  readonly assetId: string;
  readonly conditionId: string;
  readonly bid: number;
  readonly ask: number;
  readonly bidSize: number;
  readonly askSize: number;
  readonly timestampMs: number;
}

function topBidAsk(book: BookRaw): { bid: number; bidSize: number; ask: number; askSize: number } {
  let bid = 0;
  let bidSize = 0;
  for (const b of book.bids) {
    const p = Number(b.price);
    if (p > bid) {
      bid = p;
      bidSize = Number(b.size);
    }
  }
  let ask = 1;
  let askSize = 0;
  for (const a of book.asks) {
    const p = Number(a.price);
    if (p < ask) {
      ask = p;
      askSize = Number(a.size);
    }
  }
  return { bid, bidSize, ask, askSize };
}

export async function getBookTop(tokenId: string): Promise<BookTop> {
  const url = `${CLOB_URL}/book?token_id=${tokenId}`;
  const raw = await fetchJson<BookRaw>(url);
  const { bid, bidSize, ask, askSize } = topBidAsk(raw);
  return {
    assetId: raw.asset_id,
    conditionId: raw.market,
    bid,
    ask,
    bidSize,
    askSize,
    timestampMs: Number(raw.timestamp),
  };
}
