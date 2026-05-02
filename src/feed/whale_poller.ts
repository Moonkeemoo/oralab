import process from "node:process";
import { type DataActivity, getActivity } from "../api/data.js";
import { logger } from "../obs/logger.js";

/**
 * WhaleActivityPoller — polls data-api /activity per whale on an interval and
 * emits new BUY events as Signals upstream. Sufficient for P1; chain listener
 * is the lower-latency backup planned for P2 if poll lag becomes an issue.
 *
 * Per-whale state:
 *   lastSeenTs — newest activity timestamp observed; only events with
 *   timestamp > lastSeenTs are emitted.
 *
 * Backoff: on HTTP failure, the next tick logs + retries; failures are not
 * counted against any circuit breaker here (INV-O1 lives at higher layer).
 */

interface PollerHandler {
  onWhaleBuy(whaleAddress: string, activity: DataActivity): Promise<void> | void;
}

interface PollerOptions {
  readonly whaleAddresses: readonly string[];
  readonly intervalMs?: number;
  readonly concurrency?: number;
  readonly handler: PollerHandler;
}

export class WhaleActivityPoller {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private readonly lastSeenTs = new Map<string, number>();
  private inFlight = new Set<string>();

  constructor(private readonly options: PollerOptions) {
    this.intervalMs = options.intervalMs ?? Number(process.env["WHALE_POLL_INTERVAL_MS"] ?? 5_000);
    this.concurrency = options.concurrency ?? Number(process.env["WHALE_POLL_CONCURRENCY"] ?? 8);
  }

  start(): void {
    if (this.timer) return;
    // Seed lastSeenTs to NOW so we ignore historic activity. Without this,
    // first poll dumps every recent whale BUY (50 by default) — most are old
    // and against already-resolved markets, drowning the pipeline in noise.
    const nowSec = Math.floor(Date.now() / 1000);
    for (const addr of this.options.whaleAddresses) {
      this.lastSeenTs.set(addr, nowSec);
    }
    logger.info(
      {
        count: this.options.whaleAddresses.length,
        intervalMs: this.intervalMs,
        seedFromTs: nowSec,
      },
      "WhaleActivityPoller started",
    );
    this.timer = setInterval(() => {
      void this.tickAll();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info("WhaleActivityPoller stopped");
  }

  /** Public for testing — runs one round across all whales. */
  async tickAll(): Promise<void> {
    // Bounded concurrency: at most `this.concurrency` /activity requests in
    // flight at once. With 1500 whales and concurrency=8 that's ≤ 8 req/s
    // peak instead of 1500 simultaneous — keeps us under data-api rate limits.
    const queue = [...this.options.whaleAddresses];
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const w = queue.shift();
        if (!w) return;
        await this.tickOne(w);
      }
    });
    await Promise.all(workers);
  }

  private async tickOne(whaleAddr: string): Promise<void> {
    if (this.inFlight.has(whaleAddr)) return;
    this.inFlight.add(whaleAddr);
    try {
      const activity = await getActivity(whaleAddr, { limit: 50, type: "TRADE" });
      const lastSeen = this.lastSeenTs.get(whaleAddr) ?? 0;
      const newest = activity.reduce((m, a) => Math.max(m, a.timestamp), lastSeen);

      const fresh = activity.filter((a) => a.timestamp > lastSeen && a.side === "BUY");
      // Newest events come first in the API; emit in chronological order.
      fresh.sort((a, b) => a.timestamp - b.timestamp);
      for (const a of fresh) {
        try {
          await this.options.handler.onWhaleBuy(whaleAddr, a);
        } catch (err) {
          logger.error(
            { err, whale: whaleAddr, asset: a.asset, ts: a.timestamp },
            "whale BUY handler threw",
          );
        }
      }
      if (newest > lastSeen) this.lastSeenTs.set(whaleAddr, newest);
    } catch (err) {
      logger.warn({ err, whale: whaleAddr }, "whale poll fetch failed (will retry next tick)");
    } finally {
      this.inFlight.delete(whaleAddr);
    }
  }
}
