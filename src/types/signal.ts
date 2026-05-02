export type SignalSourceKind = "whale_chain" | "whale_ws" | "sports_ws" | "manual";

export interface Signal {
  readonly id: string;
  readonly userId: number;
  readonly strategyId: string;
  readonly source: SignalSourceKind;
  readonly conditionId: string;
  readonly assetId: string;
  readonly side: "YES" | "NO";
  readonly priceHint: number;
  readonly volumeUsdHint: number;
  readonly payload: Record<string, unknown>;
  readonly receivedTs: number;
}

export interface SignalSource {
  readonly kind: SignalSourceKind;
  start(emit: (signal: Signal) => void): Promise<void>;
  stop(): Promise<void>;
}
