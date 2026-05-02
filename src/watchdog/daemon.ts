import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { killSwitches } from "../db/schema.js";
import { logger } from "../obs/logger.js";
import { r9BudgetDrift } from "./rules/r9_budget_drift.js";
import { r21Oversell } from "./rules/r21_oversell.js";
import { r22FloorViolation } from "./rules/r22_floor_violation.js";
import type { WatchdogRule } from "./types.js";

/**
 * Watchdog daemon — runs all R-rules every interval, logs alerts.
 *
 *   P0 alert  → set kill_switches.scope=global, active=true
 *   P1 alert  → log + counter (operator notice)
 *   P2 alert  → log only
 *
 * Rules are read-only against DB / data-api. No mutation except
 * kill_switches insertion on P0.
 */

const RULES: WatchdogRule[] = [r9BudgetDrift, r21Oversell, r22FloorViolation];

export class WatchdogDaemon {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(private readonly intervalMs = 30_000) {}

  start(): void {
    if (this.timer) return;
    logger.info({ intervalMs: this.intervalMs, ruleCount: RULES.length }, "Watchdog started");
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    // First run immediately
    void this.runOnce();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      for (const rule of RULES) {
        try {
          const result = await rule.evaluate();
          if (result.ok) {
            logger.debug({ ruleId: rule.id }, "rule pass");
            continue;
          }
          logger.warn(
            { ruleId: rule.id, severity: result.severity, ...result.fields },
            result.message,
          );
          if (result.severity === "P0") {
            await this.engageKillSwitch(rule.id, result.message);
          }
        } catch (err) {
          logger.error({ err, ruleId: rule.id }, "rule threw");
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async engageKillSwitch(ruleId: string, reason: string): Promise<void> {
    const db = getDb();
    const existing = await db.query.killSwitches.findFirst({
      where: eq(killSwitches.scope, "global"),
    });
    if (existing?.active) {
      logger.warn({ ruleId }, "global KILL already active; skipping insert");
      return;
    }
    await db.insert(killSwitches).values({
      scope: "global",
      reason: `R-${ruleId}: ${reason}`,
      active: true,
    });
    logger.error({ ruleId, reason }, "GLOBAL KILL_SWITCH engaged");
  }
}
