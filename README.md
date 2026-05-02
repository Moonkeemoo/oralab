# Ora et Labora v2

Sports-focused Polymarket auto-trading bot. TypeScript native, on CLOB V2.

- **Master design:** `docs/architecture.html` (open in browser)
- **Constitution:** `docs/SPEC.md` (10 invariants, decide_exit, state machine)
- **API surface:** `docs/POLYMARKET_API.md`
- **QA patterns:** `docs/TESTS.md` (30 critical patterns from v1 incidents)
- **CLOB V2 reality:** `docs/clob-v2-research.html`
- **Repo kickoff hand-off:** `docs/REPO_KICKOFF.md`
- **Claude collab config:** `docs/CLAUDE_SETUP.md`
- **Claude orientation map:** `CLAUDE.md`

## Quick start

```bash
npm install
cp .env.example .env       # fill in secrets
docker-compose up -d postgres
npm run db:push
npm run dev:trader         # DRY mode
npm test
```

## Phase plan

| Phase | Weeks | Goal |
|---|---|---|
| Spike | 1 | Scaffold + observability + spikes |
| P1 | 2-3 | Solo sports bot, DRY |
| P1.5 | 4 | SportsScoreReactor (alpha) |
| P2 | 5-6 | Mini App + decision log |
| P3a-b | 7-8 | DRY validation + LIVE cutover |
| P3c+ | 11+ | Multi-user (BYO + custodial) |

Full plan: `docs/architecture.html` §15.
