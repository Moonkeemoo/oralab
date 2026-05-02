import { logger } from "../obs/logger.js";

/**
 * INV-O2 bounded HTTP: timeout=5s default, retry 3× with exponential backoff
 * (200ms → 400ms → 800ms). Idempotency for non-GET callers handled at higher
 * layer. Pass `User-Agent: Mozilla/5.0` always — Polymarket data-api 403's the
 * default Node UA.
 */

export interface FetchJsonOpts {
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly headers?: Record<string, string>;
  readonly init?: RequestInit;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Ora-et-Labora-v2)",
  Accept: "application/json",
};

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} ${url}`);
    this.name = "HttpError";
  }
}

export async function fetchJson<T>(url: string, opts: FetchJsonOpts = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  let lastErr: unknown;
  let backoff = 200;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...opts.init,
        signal: ac.signal,
        headers: { ...DEFAULT_HEADERS, ...opts.headers, ...(opts.init?.headers ?? {}) },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new HttpError(res.status, url, body);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      logger.debug({ url, attempt, err: (err as Error).message }, "fetchJson retry");
      await delay(backoff);
      backoff *= 2;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr;
}
