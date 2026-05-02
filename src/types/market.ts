export type MarkSource = "ws_book" | "rest_book" | "chain" | "cached_midpoint";

export type UmaResolutionStatus = "proposed" | "disputed" | "resolved" | null;

export interface MarketSnapshot {
  readonly conditionId: string;
  readonly assetId: string;
  readonly bid: number;
  readonly ask: number;
  readonly bidSize: number;
  readonly askSize: number;
  readonly mark: number;
  readonly markSource: MarkSource;
  readonly markTs: number;
  readonly tickSize: number;
  readonly negRisk: boolean;
  readonly minOrderSize: number;
  readonly expectedOutcomeValue: number;
  readonly acceptingOrders: boolean;
  readonly umaResolutionStatus: UmaResolutionStatus;
  readonly resolved: boolean;
  readonly winningOutcomeIndex: number | null;
  readonly endDateTs: number;
  readonly fetchedAt: number;
}

export interface MarketMetadata {
  readonly conditionId: string;
  readonly slug: string;
  readonly question: string;
  readonly negRisk: boolean;
  readonly tickSize: number;
  readonly minOrderSize: number;
  readonly makerFeeBps: number;
  readonly takerFeeBps: number;
  readonly tokens: readonly { readonly tokenId: string; readonly outcome: string }[];
  readonly endDate: string;
  readonly isSportsMarket: boolean;
  readonly gameId: string | null;
  readonly sportsMarketType: string | null;
}
