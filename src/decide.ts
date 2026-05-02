import type { ExitConfig, ExitIntent } from "./types/decide.js";
import type { MarketSnapshot } from "./types/market.js";
import type { PositionView } from "./types/position.js";

/**
 * Pure function. No I/O. ExitExecutor is the ONLY thing that mutates state.
 *
 * Decision tree priority (see docs/SPEC.md, docs/architecture.html §08):
 *  1. INV-D3 reconciliation conflict → FREEZE
 *  2. market RESOLVED → REDEEM
 *  3. on-chain size = 0 → HOLD (INV-M1)
 *  4. UMA window / NOT_ACCEPTING / CLOSED → HOLD
 *  5. INV-D2 post-entry WS_BOOK debounce 5s → HOLD
 *  6. INV-D2 mark stale or wide spread → HOLD
 *  7. SL emergency (-17%): bid+1tick probe → FOK at floor
 *  8. TP (+20%): bid+1tick GTD
 *  9. trailing armed + giveback breach: bid+1tick GTD
 * 10. SL standard (-15%): bid+1tick probe → bid-1tick aggressive
 * 11. default → HOLD
 *
 * Every SELL filtered through outcomeFloor (INV-M2). price < floor → HOLD.
 *
 * SL/TP defaults are v1-ported (-15/-17/+20), NOT SPEC §08 (-10/-19/+18).
 * See CLAUDE.md "Kickoff decisions" for rationale.
 */
export function decideExit(
  _pos: PositionView,
  _snap: MarketSnapshot,
  _cfg: ExitConfig,
): ExitIntent {
  throw new Error("decideExit not yet implemented — see tests/decide.spec.ts (red phase)");
}
