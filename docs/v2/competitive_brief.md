# Competitive Brief — week-1 spike

> Polymarket copy-trading / auto-trading landscape as of May 2026. Output of `docs/REPO_KICKOFF.md` §8 Day 4-5 spike. Companion to `filter_audit.md`.

## Direct competitors

### PolyCop (Telegram bot)
> [polycopbot.com](https://polycopbot.com/) · [polycop.io](https://polycop.io/) · [CoinCodeCap review](https://coincodecap.com/polycop-telegram-bot-review-polymarket-copy-trading-sniper)

**The most directly comparable product.** Telegram-native. Three modes:
- **Copy mode** — paste a wallet address, bot mirrors trades
- **Sniper mode** — limit order at target price, fills when crossed
- **AFK mode** — user-defined entry/exit conditions, runs 24/7

**Custody:** non-custodial. Private key generated inside the Telegram session, **never sent to any server**. Same posture as our planned BYO P3c flow.

**Pricing:** flat **0.5% per executed trade**. No subscription, no deposit/withdrawal fees, no gas (PolyCop covers gas), no charge on unfilled orders. Minimum deposit $10 ($50 for copy mode).

**Distribution:** every fill / close / alert via Telegram notification. PnL queryable from chat.

### PolyCopyTrade (web platform)
> [polycopytrade.space](https://www.polycopytrade.space/) · [polycopytrade.net](https://www.polycopytrade.net/)

Separate product despite confusable name. Web-based, subscription tiers:
- **Starter** $99/mo — entry-level
- **Professional** $299/mo — advanced risk mgmt, multi-trader portfolios
- **Enterprise** $499/mo — full-stack tools

Customizable copy ratios 0.1x–1x. Per-trade hard caps + daily loss limits. Liquidity filters. Non-custodial. Marketing claims 10k+ active traders, $50M+ cumulative volume, 127% avg user profit increase (treat last with salt — no audit cited).

### PredictEngine (no-code bot builder)
> [predictengine.ai](https://www.predictengine.ai/blog/best-prediction-market-bots-2026)

No-code bot builder for Polymarket. Lower technical bar than PolyCop. Less control. Aimed at non-developers.

## Adjacent / signal-only

### YN Signals
24/7 alert aggregator across Polymarket / Kalshi / Limitless. Telegram alerts on: new markets, odds anomalies, large whale transactions. **Does not execute** — pure signal layer. Could become a complementary alpha source for our sports strategy.

### Polysights
AI-powered Polymarket analytics. 30+ custom metrics, news insights, AI summaries. Read-only dashboards.

### Polymarket ecosystem map
> [defiprime.com guide](https://defiprime.com/definitive-guide-to-the-polymarket-ecosystem) · [aarora4/Awesome-Prediction-Market-Tools](https://github.com/aarora4/Awesome-Prediction-Market-Tools)

170+ tools, bots, dashboards, indexers, analytics products — large ecosystem. Most are signal/analytics; few execute autonomously with strategy isolation.

## Where Ora et Labora v2 differentiates

| Axis | PolyCop | Ora v2 |
|---|---|---|
| Custody | Non-custodial (TG session PK) | Non-custodial BYO via ERC-1271 + custodial opt-in (P3c) |
| Distribution | Telegram bot | Telegram **bot + Mini App** (richer UI for monitoring + control) |
| Strategy modes | Copy / Sniper / AFK | Whale follow + **SportsScoreReactor (real-time game state)** + future SportsPreEventStrategy |
| Sports specialty | General-purpose | **Sports-first** in P1; sports WS feed integration P1.5 |
| Alpha source | Whale wallet copy + user rules | Whale + **Polymarket sports WS** (no auth, score-event reactive) |
| Strategy isolation | Single config per session | **Per-strategy isolation** — multiple strategies can run side-by-side per user (P3c) |
| Pricing | 0.5% per trade | TBD — pricing waitlist gate at week 9-10 (architecture §17). Likely match or undercut PolyCop's 0.5% |
| Open architecture | Closed | Strategy interface designed for plug-in alpha sources (P4+ external odds, calibrator) |
| Latency target | Not published | p99 ≤ 3s whale → BUY (architecture §06) — measurable, observable |
| Observability | Telegram notifications only | OTEL + Prometheus + Loki + Grafana from Day 1 |
| Reconciliation safety | Not published | Continuous chain reconciliation with grace periods (INV-D3); freeze on >5% drift |

## Where competitors win

- **Time-to-market.** PolyCop is live, has users, has trade history. We are ~weeks 1 of 11+ to public.
- **Volume base.** PolyCopyTrade claims $50M cumulative volume; we start at zero.
- **Generality.** PolyCop covers all of Polymarket; we deliberately scope sports-first in P1.
- **Pricing simplicity.** PolyCop's "no subscription, 0.5% per trade" is easy to communicate. We need to match this clarity.

## Differentiation pitch (1-line)

> "Sports-first Polymarket auto-trading on CLOB V2 — react to game scores in real-time, not just to whales; non-custodial smart wallet primary; Telegram Mini App for richer ops; built with the v1 incident book baked into 10 invariants and 30 negative tests."

## Open product questions (move into pricing waitlist test)

1. Will sports-WS-reactor produce enough alpha to beat PolyCop's pure whale-copy on sports markets? (validate during P1.5 capture log → P3a shadow-replay)
2. Is "sports-first" too narrow a wedge for paid acquisition, or does it convert better than general-purpose? (waitlist test at week 9-10)
3. Pricing: match 0.5% per trade, undercut, or differentiate via subscription? Wait for waitlist responses.
4. Is BYO via ERC-1271 onboarding too friction-heavy for a user already comfortable with PolyCop's "PK-in-TG-session" UX? Onboarding A/B at P3c.

## Re-do at week 9-10 (deep-dive deliverable)

This brief is shallow on UX/UI compare. Architecture §17 calls for a deeper deep-dive at week 9-10 with:
- Screenshots of PolyCop / PolyCopyTrade onboarding flows
- Pricing benchmark table with confirmed numbers
- Specific user-switching reasons (interview 3-5 PolyCop users from waitlist responses)

## Sources

- [PolyCop Telegram bot](https://polycopbot.com/)
- [PolyCop product site](https://polycop.io/)
- [PolyCop review on CoinCodeCap](https://coincodecap.com/polycop-telegram-bot-review-polymarket-copy-trading-sniper)
- [PolyCopyTrade web platform](https://www.polycopytrade.space/)
- [PredictEngine — Best Prediction Market Bots 2026](https://www.predictengine.ai/blog/best-prediction-market-bots-2026)
- [Best Polymarket Trading Bots — Quicknode](https://www.quicknode.com/builders-guide/best/top-10-polymarket-trading-bots)
- [Definitive Guide to the Polymarket Ecosystem (defiprime)](https://defiprime.com/definitive-guide-to-the-polymarket-ecosystem)
- [Awesome-Prediction-Market-Tools (GitHub list)](https://github.com/aarora4/Awesome-Prediction-Market-Tools)
- [Best Prediction Market Apps May 2026 (VegasInsider)](https://www.vegasinsider.com/prediction-markets/best-prediction-market-apps/)
