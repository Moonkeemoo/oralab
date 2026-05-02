export type PositionStatus =
  | "PENDING"
  | "FILLED"
  | "OPEN"
  | "EXITING"
  | "RESOLVED"
  | "CLOSED"
  | "FAILED"
  | "FROZEN";

export const VALID_TRANSITIONS: Readonly<Record<PositionStatus, readonly PositionStatus[]>> = {
  PENDING: ["FILLED", "FAILED"],
  FILLED: ["OPEN"],
  FAILED: ["FILLED", "CLOSED"],
  OPEN: ["EXITING", "RESOLVED", "FROZEN"],
  EXITING: ["CLOSED", "OPEN", "FROZEN"],
  RESOLVED: ["CLOSED"],
  CLOSED: [],
  FROZEN: ["OPEN"],
};

export interface PositionView {
  readonly id: string;
  readonly userId: number;
  readonly walletAddress: string;
  readonly conditionId: string;
  readonly assetId: string;
  readonly side: "YES" | "NO";
  readonly status: PositionStatus;
  readonly shares: number;
  readonly onChainShares: number;
  readonly fillPrice: number;
  readonly peakPrice: number;
  readonly fillTs: number;
  readonly lastStateChangeTs: number;
  readonly trailArmed: boolean;
  readonly sweepCount: number;
  readonly reconciliationDriftPct: number;
  readonly sportsHint: {
    type: "game_ended";
    gameId: string;
    score: string;
    league: string;
    at: number;
  } | null;
}
