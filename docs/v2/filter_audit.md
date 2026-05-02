# Filter Audit — week-1 spike

> Source: `oralab-v1-archive-2026-05-02.tar.gz` → `output/decision_log.jsonl` (live) + `output/archive/decision_log-*.jsonl.gz` (archived).  
> Window: 2026-05-02T11:30:29 → 2026-05-02T12:14:25 (~43.9 minutes)  
> Total decisions: 1466  
> Generated: 2026-05-02T14:51:39

> ⚠ **Caveat:** the audit window is much smaller than the planned 30 days. v1 was largely down
> after CLOB V2 launched 2026-04-27 (`order_version_mismatch`), so the decision log captured only
> the brief windows where the bot was up. "cut" decisions in this window may be premature —
> a filter labeled `review` may simply not have had inputs that would trigger it. Re-run the audit
> against captured logs once v2 has 7+ days of DRY data (P3a).

## Method

- `fire_count` = decisions where the filter appeared in `filter_values` (it was checked)
- `skip_count` = decisions where `skip_reason === filter_name` (it caused a skip)
- `port` = `hard_safety` always; OR skip_count > 0; OR fire_count ≥ 100
- `cut` = fire_count = 0 in window (filter never reached pipeline → dead)
- `review` = fired but never caused skip in window — manual judgment

## Decision table

| Filter | Fire | Skip | Skip % | Last fired | Decision |
|---|---:|---:|---:|---|:---:|
| `whale_size_floor` | 1009 | 563 | 55.8% | 2026-05-02T12:14:25 | **port** |
| `price_too_high` | 224 | 224 | 100.0% | 2026-05-02T12:14:17 | **port** |
| `conviction_gate` | 436 | 191 | 43.8% | 2026-05-02T12:14:22 | **port** |
| `market_volume` | 119 | 117 | 98.3% | 2026-05-02T12:13:19 | **port** |
| `trust_gate` | 245 | 77 | 31.4% | 2026-05-02T12:14:22 | **port** |
| `sm_score` | 54 | 49 | 90.7% | 2026-05-02T12:13:05 | **port** |
| `max_open_positions` | 1097 | 40 | 3.6% | 2026-05-02T12:14:25 | **port** |
| `price_too_low` | 1109 | 10 | 0.9% | 2026-05-02T12:14:25 | **port** |
| `bid_ask_spread_wide` | 10 | 10 | 100.0% | 2026-05-02T11:58:04 | **port** |
| `stale_trade` | 1339 | 0 | 0.0% | 2026-05-02T12:14:25 | **port** |
| `time_horizon_too_close` | 1097 | 0 | 0.0% | 2026-05-02T12:14:25 | **port** |
| `drawdown_full_stop` | 1009 | 0 | 0.0% | 2026-05-02T12:14:25 | **port** |
| `total_exposure_cap` | 1009 | 0 | 0.0% | 2026-05-02T12:14:25 | **port** |
| `price_impact` | 2 | 0 | 0.0% | 2026-05-02T12:01:48 | _review_ |
| `slippage` | 2 | 0 | 0.0% | 2026-05-02T12:01:48 | _review_ |
| `price_collapsed` | 2 | 0 | 0.0% | 2026-05-02T12:01:48 | _review_ |
| `remaining_edge` | 2 | 0 | 0.0% | 2026-05-02T12:01:48 | _review_ |
| `tp_unreachable` | 2 | 0 | 0.0% | 2026-05-02T12:01:48 | _review_ |
| `correlation_cap` | 2 | 0 | 0.0% | 2026-05-02T12:01:48 | _review_ |
| `drawdown_minimal` | 2 | 0 | 0.0% | 2026-05-02T12:01:48 | _review_ |
| `max_positions_per_event` | 2 | 0 | 0.0% | 2026-05-02T12:01:48 | _review_ |

## Summary

- **Port** (carry to v2): 13
- **Cut** (dead in window): 0
- **Review** (manual judgment needed): 8

## Notes

- `hard_safety` is unconditional port (money-safety; see CLAUDE.md kickoff decisions).
- `review` filters: fired but never caused skip in window. Likely 'always-pass with current params' — keep but consider tightening params, OR cut if confirmed dead.
- v1 used Python filters in `core/filters/`; v2 ports logic to TypeScript with `Strategy.evaluate()` filter pipeline. See `docs/architecture.html` §10.
