import { getDb } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import { logger } from "../obs/logger.js";

export type AuditActor = "mini_app" | "bot" | "trader" | "reconciler" | "calibrator" | "test";

export interface AuditEntry {
  actor: AuditActor | string;
  userId?: number | null;
  action: string;
  target?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Append a row to audit_log. Fire-and-forget — DB errors are logged and
 * swallowed so audit failures never block the caller's flow.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    const db = getDb();
    await db.insert(auditLog).values({
      ts: Date.now(),
      actor: entry.actor,
      userId: entry.userId ?? null,
      action: entry.action,
      target: entry.target ?? null,
      payload: entry.payload ?? {},
    });
  } catch (err) {
    logger.warn({ err, action: entry.action }, "audit_log insert failed");
  }
}
