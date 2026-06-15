# Facebook Automation

Multi-account Facebook Page monitor bot with automated Like / Comment / Share / DM,
a local web control plane, and AI-generated (OpenAI) comments and replies. Designed
to run on a **single Linux VPS** under **pm2**.

## Architecture

Two long-lived processes supervised by one pm2 daemon, sharing one SQLite DB:

- **`fb-control`** (`server/index.js`) — Express management API + the built web UI.
  Bound to **127.0.0.1 only**; you reach it over an SSH tunnel. This is where you
  add accounts, edit templates/settings, start/stop the worker, and watch the
  activity feed.
- **`fb-worker`** (`index.js`) — the automation engine. One headless chromium
  browser per enabled account; resumes all state from the DB on restart.

State (encrypted FB credentials, settings, runtime state, action log) lives in
`db/fb-bot.db` (WAL mode). FB credentials are encrypted at rest with
`APP_ENCRYPTION_KEY` (AES-256-GCM).

```
  you ──ssh tunnel──► fb-control (:8080 loopback) ──pm2 start/stop──► fb-worker ──► chromium per account
                            └──────────────── db/fb-bot.db ───────────────┘
```

## Quick start (development, on your machine)

```bash
npm ci && npm --prefix web ci          # install backend + UI deps
cp .env.example .env                   # then fill in the secrets (see .env.example)
npm run set-password -- "<admin-pw>"   # → paste hash into ADMIN_PASSWORD_HASH
npm run migrate                        # initialize the SQLite DB
npm run ui:build                       # build the web UI
npm run control                        # start the control plane (http://localhost:8080)
node login.js --account <name>         # generate a Facebook session (once per account)
npm start                              # run the worker directly (or drive it from the UI)
```

## Production deploy (single VPS, pm2)

The full from-scratch VPS deployment — prerequisites, secrets, Playwright/chromium
install, pm2 launch, SSH-tunnel access, FB session generation, log rotation,
healthcheck alerting, backups, ban-risk safety guidance, and security finalization —
is in:

### → [`docs/RUNBOOK.md`](docs/RUNBOOK.md)

The short version:

```bash
npm ci && npm --prefix web ci
cp .env.example .env                              # fill in secrets (generate APP_ENCRYPTION_KEY ON THIS VPS)
npm run set-password -- "<admin-pw>"              # → ADMIN_PASSWORD_HASH
npx playwright install --with-deps chromium
npm run migrate
npm run ui:build
pm2 start pm2.config.js && pm2 save && pm2 startup
# then: ssh -L 8080:127.0.0.1:8080 user@vps  →  http://localhost:8080  → add accounts
#       node login.js --account <name>       →  generate FB sessions
```

> ⚠️ `APP_ENCRYPTION_KEY` is **per-VPS**: credentials encrypted on another machine
> won't decrypt here. Generate a fresh key on the VPS and re-enter FB credentials
> through the UI. See the runbook.

## NPM scripts

| Script | What it does |
|---|---|
| `npm start` | Run the worker directly (`index.js`). |
| `npm run control` | Run the control plane (`server/index.js`). |
| `npm run migrate` / `migrate:dry` | Initialize/upgrade the SQLite DB (dry-run previews). |
| `npm run set-password -- "<pw>"` | Generate the bcrypt `ADMIN_PASSWORD_HASH`. |
| `npm run login` / `login:all` | Generate Facebook session file(s) (`node login.js`). |
| `npm run ui:build` / `ui:dev` | Build / dev-serve the web UI (under `web/`). |
| `npm run healthcheck` | Out-of-band worker liveness probe (exit-code based; cron-friendly). |
| `npm run pm2:start` / `pm2:reload` | `pm2 start` / `pm2 reload pm2.config.js`. |
| `npm test` | Backend test suite (`node --test`). |
| `npm run lint` / `format` | ESLint / Prettier. |

## Operations

- **Process control**: `pm2 status`, `pm2 logs fb-worker`, `pm2 reload pm2.config.js`.
- **Health**: `npm run healthcheck` (or cron / uptime-kuma) — see the runbook.
- **Logs**: under `logs/` (gitignored); rotate with `pm2 install pm2-logrotate` (runbook §10).
- **Backups**: `sqlite3 db/fb-bot.db "VACUUM INTO '/backups/...'"` — plus `.env` and `sessions/`.

## Safety

Facebook detects automation. Keep daily caps conservative, leave the human-like
pacing on, and use a dedicated proxy per account for multi-account setups.
Aggressive cadence is the leading cause of bans. See runbook §13.
