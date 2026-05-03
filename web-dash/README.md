# web-dash — desktop dashboard (v1 verstka, v2 backend)

Desktop dashboard for Ora et Labora v2. **Verstka (HTML/CSS/JS layout) is a verbatim copy
of the v1 Flask dashboard `~/Documents/GitHub/ora-et-labora/dashboard/static/`** — preserved
for layout familiarity. Data calls are intercepted by `v2-shim.js` and routed to v2 REST
endpoints; anything not yet wired in v2 renders an explicit `⚠ NOT WIRED` badge.

## Source attribution

Copied verbatim 2026-05-03 from v1 (`Moonkeemoo/ora-et-labora`):

| File / dir | Source |
|---|---|
| `index.html` | `dashboard/static/index.html` |
| `app.js` | `dashboard/static/app.js` |
| `styles.css` | `dashboard/static/styles.css` |
| `mobile.css` | `dashboard/static/mobile.css` |
| `js/` (29 files) | `dashboard/static/js/` |
| `locales/{en,ua}.json` | `dashboard/static/locales/` |
| `controlbar-preview.html` | `dashboard/static/controlbar-preview.html` |
| `prototype.html` | `dashboard/static/prototype.html` |

## Modified vs verbatim

- **Verbatim**: every file from the table above. No refactoring.
- **Added (not in v1)**:
  - `v2-shim.js` — `window.fetch` interceptor mapping `/api/polymarket/*` → v2 endpoints
  - `v2-shim.css` — `.v2-unwired-badge` styling
  - `index.html` has two new lines near the top loading the shim (link + script BEFORE `app.js`).
  - `README.md` (this file).

## How to open

The v2 REST server (`src/api/rest_server.ts`) serves this directory at `/dash/*`:

```
http://localhost:8081/dash/
```

Auth: dev-bypass (`X-Dev-Bypass: secretdev`) is injected automatically by `v2-shim.js`
for all `/api/*` calls. Desktop dashboard is a **dev tool only** — not exposed
via Caddy in production. The Mini App at `/app/*` continues to use Telegram init-data.

## Wiring report

Run the dashboard, navigate every tab, and look for `⚠ NOT WIRED` badges. Each badge
exposes the v1 endpoint path that has no v2 equivalent. Report them; for each one
either a v2 endpoint gets added or the value is intentionally retired.

The current shim covers the full v1 endpoint surface — see `ENDPOINT_MAP` in
`v2-shim.js` for the canonical mapped/unwired list with rationales.
