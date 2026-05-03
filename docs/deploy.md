# Hetzner native deploy (no Docker)

> Production v2 of `Moonkeemoo/oralab` runs natively on a single Hetzner CPX22 box.
> No Docker. 6 systemd units + Caddy reverse proxy + Postgres 16 + Node 20.

## Box

- Host: `ora@204.168.239.121` (`OraLab-ubuntu-4gb-hel1-1`, Helsinki, Ubuntu 24.04)
- 4 GiB RAM, 75 GiB disk
- DNS: `oralab.xyz` → 204.168.239.121 (Caddy auto-issues Let's Encrypt cert)
- App root: `/opt/ora2` (owned by `ora`)
- Logs: `/var/log/ora2/{api,trader,feed,bot,watchdog,calibrator}.log`

SSH: `ssh ora@204.168.239.121` (Taras's mac key trusted, BatchMode-safe).

## Services (systemd)

| Unit | Entry file | Notes |
|---|---|---|
| ora2-api | src/api/main.ts | REST on :8081 (Caddy proxies /api, /app, /dash, /static) |
| ora2-trader | src/main.ts | PositionMonitor + MarketBookWs + DryFillSimulator (DRY) / FillReconciler (LIVE) |
| ora2-feed | src/feed/main.ts | RTDS + sports WS → entries |
| ora2-bot | src/notify/main.ts | Telegram long-poll (`@Oralab_bot`) |
| ora2-watchdog | src/watchdog/main.ts | DB invariant rules every 30s |
| ora2-calibrator | src/calibrator/main.ts | Cycle every CAL_RUN_INTERVAL (default 1h) |

All units share `EnvironmentFile=/opt/ora2/.env`. Restart on failure with 5s backoff.

Manage:
```bash
sudo systemctl status ora2-api
sudo systemctl restart ora2-trader
sudo journalctl -u ora2-feed -n 100 --no-pager
tail -f /var/log/ora2/api.log
```

## Caddy

Config: `/etc/caddy/Caddyfile` (backups: `Caddyfile.bak.YYYYMMDD-HHMMSS`).

```caddy
oralab.xyz, www.oralab.xyz {
  encode zstd gzip
  handle /api/*    { reverse_proxy localhost:8081 }
  handle /app/*    { reverse_proxy localhost:8081 }
  handle /dash/*   { reverse_proxy localhost:8081 }
  handle /static/* { reverse_proxy localhost:8081 }
  handle           { redir / /app/ permanent }
}
```

Reload: `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`.

## Postgres 16

- Local socket only (`listen_addresses = 'localhost'`)
- DB: `ora_v2`, user/pass: `ora` / `ora` (SUPERUSER)
- `DATABASE_URL=postgresql://ora:ora@localhost:5432/ora_v2`

Connect: `PGPASSWORD=ora psql -h localhost -U ora -d ora_v2`.

### Schema apply (Drizzle)
```bash
cd /opt/ora2
DATABASE_URL=postgresql://ora:ora@localhost:5432/ora_v2 npx drizzle-kit migrate
```
Note: `npm run db:push` requires a TTY (interactive prompt) — use `migrate` from non-TTY contexts.

### Dump from local mac → restore on box
```bash
# On local mac (mac runs Postgres on :5433)
PGPASSWORD=ora pg_dump -h localhost -p 5433 -U ora -d ora_v2 \
  --data-only --column-inserts --no-comments \
  -t users -t wallets -t strategies -t strategy_filters -t whales \
  -t notification_settings -t calibrator_settings \
  > /tmp/seed.sql
scp /tmp/seed.sql ora@204.168.239.121:/tmp/seed.sql

# On box
ssh ora@204.168.239.121 'PGPASSWORD=ora psql -h localhost -U ora -d ora_v2 -f /tmp/seed.sql'
```

### Backup (cron-friendly)
```bash
ssh ora@204.168.239.121 'PGPASSWORD=ora pg_dump -h localhost -U ora -d ora_v2 -Fc -f /var/backups/ora2-$(date +%F).pgdump'
```

## Redeploy

```bash
ssh ora@204.168.239.121 << 'EOF'
cd /opt/ora2
git pull
npm install
DATABASE_URL=postgresql://ora:ora@localhost:5432/ora_v2 npx drizzle-kit migrate
sudo systemctl restart ora2-api ora2-trader ora2-feed ora2-bot ora2-watchdog ora2-calibrator
sleep 5
sudo systemctl is-active ora2-{api,trader,feed,bot,watchdog,calibrator}
EOF
```

## .env

Lives at `/opt/ora2/.env`, perms `600`, owner `ora`. Production-only deltas vs local:
- `DATABASE_URL` → port 5432 (not 5433)
- `NODE_ENV=production`
- `REST_PORT=8081`
- `DRY_RUN=true` (NEVER flip without explicit Taras approval per CLAUDE.md)
- `DRY_SIMULATE_FILLS=true`

## Smoke

```bash
curl -s https://oralab.xyz/api/health                                     # {"ok":true}
curl -s https://oralab.xyz/api/status -H "X-Dev-Bypass: secretdev"        # mode/active counts
curl -sI https://oralab.xyz/app/index.html                                # 200
curl -sI https://oralab.xyz/dash/index.html                               # 200
```

## Known concern: Telegram bot 409 collision

If `ora2-bot` is logging `getUpdates HTTP 409`, it means another long-poller (the user's local mac) is using the same `TELEGRAM_BOT_TOKEN`. Telegram allows only one active poller per bot. To switch to box-only:
- Stop the local mac bot process, or
- Disable `ora2-bot` on the box during dev: `sudo systemctl stop ora2-bot`

Long-term: switch the bot to webhook mode (one URL = one consumer; no poll race).
