/**
 * Per-(user × strategy) entry serialization.
 *
 * The race condition that opened 5 positions when max=1: 5 concurrent
 * routeWhaleBuy invocations all checked `openPositions.length < 1` before
 * any of their placeBuy/INSERT had completed, so all passed the gate.
 *
 * This module ensures that for any given (userId, strategyId), at most ONE
 * entry decision (filter pipeline → sizing → placeBuy → INSERT) is in flight
 * at a time. Subsequent calls queue behind the previous promise.
 *
 * INV-bulletproof per `feedback_bulletproof_live.md`.
 */

const _queue = new Map<string, Promise<unknown>>();

function key(userId: number, strategyId: number): string {
  return `${userId}:${strategyId}`;
}

export async function serializedEntry<T>(
  userId: number,
  strategyId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const k = key(userId, strategyId);
  const prev = _queue.get(k) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  _queue.set(
    k,
    next.finally(() => {
      // Only clear if we're still the head — a later call may have replaced us
      if (_queue.get(k) === next) _queue.delete(k);
    }),
  );
  return next;
}

/** Test-only — visibility into queue size. */
export function _entryQueueSize(): number {
  return _queue.size;
}

/** Test-only — clear queue (use between test cases). */
export function _resetEntryQueue(): void {
  _queue.clear();
}
