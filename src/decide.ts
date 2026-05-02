import type { ExitAction, ExitConfig, ExitIntent } from "./types/decide.js";
import type { MarketSnapshot } from "./types/market.js";
import type { PositionView } from "./types/position.js";

const TICK_EPS = 1e-9;
const PNL_EPS = 1e-9;

function roundDownToTick(price: number, tickSize: number): number {
  return Math.floor(price / tickSize + TICK_EPS) * tickSize;
}

function outcomeFloor(snap: MarketSnapshot, cfg: ExitConfig): number {
  return Math.max(snap.tickSize, snap.expectedOutcomeValue * cfg.outcomeFloorMultiplier);
}

function pnlPct(pos: PositionView, snap: MarketSnapshot): number {
  if (pos.fillPrice <= 0) return 0;
  return (snap.mark - pos.fillPrice) / pos.fillPrice;
}

function intent(
  action: ExitAction,
  price: number,
  size: number,
  urgency: 1 | 2 | 3 | 4 | 5,
  reason: string,
  gates: readonly string[],
  snapshotTs: number,
): ExitIntent {
  return { action, price, size, urgency, reason, gates, snapshotTs };
}

const HOLD = (reason: string, gates: readonly string[], snap: MarketSnapshot): ExitIntent =>
  intent("hold", 0, 0, 1, reason, gates, snap.markTs);

const FREEZE = (reason: string, gates: readonly string[], snap: MarketSnapshot): ExitIntent =>
  intent("freeze", 0, 0, 5, reason, gates, snap.markTs);

const REDEEM = (snap: MarketSnapshot): ExitIntent =>
  intent("redeem", 0, 0, 4, "market resolved", ["INV-M3"], snap.markTs);

function buildSell(
  action: Extract<ExitAction, "sell_bid_probe" | "sell_bid_aggr" | "sell_fok">,
  rawPrice: number,
  pos: PositionView,
  snap: MarketSnapshot,
  cfg: ExitConfig,
  urgency: 1 | 2 | 3 | 4 | 5,
  reason: string,
  gates: readonly string[],
): ExitIntent {
  const tickAligned = roundDownToTick(rawPrice, snap.tickSize);
  const floor = outcomeFloor(snap, cfg);
  if (tickAligned < floor) {
    return HOLD(
      `${reason} blocked by INV-M2 outcome floor (${floor.toFixed(4)})`,
      [...gates, "INV-M2"],
      snap,
    );
  }
  const size = Math.min(pos.shares, pos.onChainShares);
  if (size <= 0) {
    return HOLD("INV-M1 onChainShares=0", [...gates, "INV-M1"], snap);
  }
  return intent(action, tickAligned, size, urgency, reason, gates, snap.markTs);
}

/**
 * Pure function. No I/O. ExitExecutor is the ONLY thing that mutates state.
 * Decision tree priority — see docs/SPEC.md, docs/architecture.html §08.
 *
 * SL/TP defaults are v1-ported (-15/-17/+20) per CLAUDE.md kickoff decisions,
 * NOT the SPEC §08 numbers (-10/-19/+18).
 */
export function decideExit(pos: PositionView, snap: MarketSnapshot, cfg: ExitConfig): ExitIntent {
  // Terminal states — no action
  if (pos.status === "CLOSED" || pos.status === "FAILED") {
    return HOLD(`terminal status=${pos.status}`, [], snap);
  }

  // Gate 1 — INV-D3 reconciliation conflict
  if (pos.status === "FROZEN") {
    return FREEZE("status=FROZEN (reconciler set)", ["INV-D3"], snap);
  }
  if (pos.reconciliationDriftPct >= 0.05) {
    return FREEZE(
      `reconciliation drift ${(pos.reconciliationDriftPct * 100).toFixed(1)}%`,
      ["INV-D3"],
      snap,
    );
  }

  // Gate 2 — market RESOLVED
  if (snap.resolved || snap.umaResolutionStatus === "resolved") {
    return REDEEM(snap);
  }

  // Gate 3 — INV-M1 on-chain size = 0
  if (pos.onChainShares <= 0) {
    return HOLD("onChainShares=0", ["INV-M1"], snap);
  }

  // Gate 4 — UMA window / not accepting orders / pre-OPEN states
  if (snap.umaResolutionStatus === "proposed" || snap.umaResolutionStatus === "disputed") {
    return HOLD(`UMA ${snap.umaResolutionStatus}`, [], snap);
  }
  if (!snap.acceptingOrders) {
    return HOLD("market not accepting orders", [], snap);
  }
  if (pos.status === "PENDING" || pos.status === "FILLED" || pos.status === "RESOLVED") {
    return HOLD(`status=${pos.status} not OPEN/EXITING`, [], snap);
  }

  // Gate 5 — INV-D2 / QA-165 post-entry 5s debounce on ws_book source
  const sincFillMs = snap.markTs - pos.fillTs;
  if (
    snap.markSource === "ws_book" &&
    sincFillMs >= 0 &&
    sincFillMs < cfg.postEntryDebounceSeconds * 1000
  ) {
    return HOLD(
      `post-fill ${(sincFillMs / 1000).toFixed(1)}s < ${cfg.postEntryDebounceSeconds}s on ws_book`,
      ["INV-D2", "QA-165"],
      snap,
    );
  }

  // Gate 6 — INV-D2 mark stale or wide spread or untrusted source
  if (snap.markSource === "cached_midpoint") {
    return HOLD("mark from cached_midpoint (QA-180)", ["INV-D1", "INV-D2", "QA-180"], snap);
  }
  const markAgeS = (snap.fetchedAt - snap.markTs) / 1000;
  if (markAgeS > cfg.markStaleSeconds) {
    return HOLD(`mark age ${markAgeS.toFixed(0)}s > ${cfg.markStaleSeconds}s`, ["INV-D2"], snap);
  }
  if (snap.bid <= 0 || snap.ask >= 1) {
    return HOLD(`dead book bid=${snap.bid} ask=${snap.ask}`, ["INV-D2"], snap);
  }
  const midpoint = (snap.bid + snap.ask) / 2;
  const spreadFrac = (snap.ask - snap.bid) / midpoint;
  if (spreadFrac > 0.5) {
    return HOLD(
      `spread ${(spreadFrac * 100).toFixed(0)}% > 50% (QA-180)`,
      ["INV-D2", "QA-180"],
      snap,
    );
  }

  // From here: market state is sane, mark trustworthy, position OPEN/EXITING.
  const pnl = pnlPct(pos, snap);

  // Gate 7 — SL emergency (default -17%)
  if (pnl <= cfg.stopLossEmergency + PNL_EPS) {
    if (pos.sweepCount >= 2) {
      // Last resort: FOK at floor. price = floor exactly so M2 passes.
      const floor = outcomeFloor(snap, cfg);
      return buildSell(
        "sell_fok",
        floor,
        pos,
        snap,
        cfg,
        5,
        `SL emergency ${(pnl * 100).toFixed(1)}% sweep=${pos.sweepCount} → FOK at floor`,
        ["SL-E"],
      );
    }
    return buildSell(
      "sell_bid_probe",
      snap.bid + snap.tickSize,
      pos,
      snap,
      cfg,
      5,
      `SL emergency ${(pnl * 100).toFixed(1)}% bid+1tick`,
      ["SL-E"],
    );
  }

  // Gate 8 — TP (default +20%)
  if (pnl >= cfg.takeProfit - PNL_EPS) {
    return buildSell(
      "sell_bid_probe",
      snap.bid + snap.tickSize,
      pos,
      snap,
      cfg,
      3,
      `TP ${(pnl * 100).toFixed(1)}% bid+1tick`,
      ["TP"],
    );
  }

  // Gate 9 — Trailing stop
  // Armed once peak crossed fillPrice * (1 + trailActivate)
  const trailArmedThreshold = pos.fillPrice * (1 + cfg.trailActivate);
  const isArmed = pos.trailArmed || pos.peakPrice >= trailArmedThreshold;
  if (isArmed) {
    const trailFloor = pos.peakPrice * (1 - cfg.trailStop);
    if (snap.mark <= trailFloor) {
      return buildSell(
        "sell_bid_probe",
        snap.bid + snap.tickSize,
        pos,
        snap,
        cfg,
        3,
        `trail giveback peak=${pos.peakPrice.toFixed(3)} → mark=${snap.mark.toFixed(3)}`,
        ["TRAIL"],
      );
    }
  }

  // Gate 10 — SL standard (default -15%) with min age guard
  const positionAgeS = (snap.markTs - pos.fillTs) / 1000;
  if (pnl <= cfg.stopLoss + PNL_EPS && positionAgeS >= cfg.minStopLossAgeSeconds) {
    if (pos.sweepCount >= 1) {
      return buildSell(
        "sell_bid_aggr",
        snap.bid - snap.tickSize,
        pos,
        snap,
        cfg,
        4,
        `SL standard ${(pnl * 100).toFixed(1)}% sweep=${pos.sweepCount} → bid-1tick aggr`,
        ["SL"],
      );
    }
    return buildSell(
      "sell_bid_probe",
      snap.bid + snap.tickSize,
      pos,
      snap,
      cfg,
      4,
      `SL standard ${(pnl * 100).toFixed(1)}% bid+1tick`,
      ["SL"],
    );
  }

  // Gate 11 — default
  return HOLD("no exit signal", [], snap);
}
