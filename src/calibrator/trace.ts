/**
 * trace — Layer 0 of the v1 calibrator architecture.
 *
 * Ported from `~/Documents/GitHub/ora-et-labora/calibrator/trace.py`. v1
 * appended JSONL rows; v2 writes to calibrator_trace table.
 *
 * Every cycle gets a unique cycleId (`cyc-{ts}-{rand4}`). Each phase logs
 * one event: cycle_start, cycle_complete, deficits, weights, lift_matrix,
 * recommendation, apply, rollback. Powers Лог tab + replay debugging.
 */
import { randomBytes } from "node:crypto";
import { and, desc, gte, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { calibratorTrace } from "../db/schema.js";
import { logger } from "../obs/logger.js";

export type EventType =
  | "cycle_start"
  | "cycle_complete"
  | "recommendation"
  | "apply"
  | "rollback"
  | "weights"
  | "lift_matrix"
  | "deficits";

export interface TraceRow {
  id: number;
  cycleId: string;
  eventType: EventType;
  payload: Record<string, unknown>;
  ts: number;
}

export interface GetTraceOpts {
  since?: number;
  limit?: number;
  eventTypes?: readonly EventType[];
  cycleId?: string;
}

/**
 * Generate a fresh cycle id. Format: `cyc-{epochMs}-{4-hex}`. Sortable by
 * timestamp + collision-resistant for our throughput (<10/min).
 */
export function newCycleId(): string {
  return `cyc-${Date.now()}-${randomBytes(2).toString("hex")}`;
}

/**
 * Append a trace event. Best-effort: logs warn on failure but never throws —
 * trace is observability, not control flow.
 */
export async function logTrace(
  cycleId: string,
  eventType: EventType,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const db = getDb();
    await db.insert(calibratorTrace).values({
      cycleId,
      eventType,
      payload,
      ts: Date.now(),
    });
  } catch (err) {
    logger.warn({ err, cycleId, eventType }, "calibrator trace insert failed");
  }
}

/**
 * Read trace rows. Defaults: last 100 rows, all event types, no cycleId
 * filter. since is epoch ms.
 */
export async function getTrace(opts: GetTraceOpts = {}): Promise<TraceRow[]> {
  const db = getDb();
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));

  const conditions = [];
  if (opts.since !== undefined) {
    conditions.push(gte(calibratorTrace.ts, opts.since));
  }
  if (opts.eventTypes && opts.eventTypes.length > 0) {
    conditions.push(inArray(calibratorTrace.eventType, opts.eventTypes as string[]));
  }
  if (opts.cycleId) {
    conditions.push(inArray(calibratorTrace.cycleId, [opts.cycleId]));
  }

  const rows = await db
    .select()
    .from(calibratorTrace)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(calibratorTrace.ts))
    .limit(limit);

  return rows.map<TraceRow>((r) => ({
    id: r.id,
    cycleId: r.cycleId,
    eventType: r.eventType as EventType,
    payload: (r.payload as Record<string, unknown>) ?? {},
    ts: r.ts,
  }));
}
