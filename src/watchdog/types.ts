/**
 * Watchdog rule = read-only check returning OK or ALERT { severity, message }.
 *
 * Severity scale (architecture §06 alert rules):
 *   P0 — money loss / stuck position imminent: triggers KILL_SWITCH
 *   P1 — degraded service requiring manual: notify only
 *   P2 — log-only spike or accounting noise
 */

export type Severity = "P0" | "P1" | "P2";

export type RuleResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly severity: Severity;
      readonly message: string;
      readonly fields?: Record<string, unknown> | undefined;
    };

export interface WatchdogRule {
  readonly id: string;
  readonly description: string;
  evaluate(): Promise<RuleResult>;
}

export const OK = (): RuleResult => ({ ok: true });
export const ALERT = (
  severity: Severity,
  message: string,
  fields?: Record<string, unknown>,
): RuleResult => ({ ok: false, severity, message, fields });
