# Whale classifier — port from v1 (P2c)

The classifier columns on `whales` (sm_score, trust_score, win_rate,
domain_breakdown, per_domain_classification) are populated for the
imported v1 wallet corpus by `scripts/import-v1-whales.ts`.

A continuous classifier daemon — that re-aggregates last-90-day on-chain
trades per wallet and re-assigns classification — is NOT yet ported.
Lives in v1 `~/Documents/GitHub/ora-et-labora/core/whales/` (Python).

P2c milestone will land `src/whale/classifier.ts` running hourly + a
`recordWhaleTrade()` hook on the chain listener (P3+ scope).

Until then: classifier values are point-in-time snapshots from the
import. Re-import periodically as a workaround.
