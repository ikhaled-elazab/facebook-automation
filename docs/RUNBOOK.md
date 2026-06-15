# Deployment Runbook — Facebook Automation (single Linux VPS, pm2)

This is the from-scratch deploy + operations runbook for the multi-account
Facebook Page automation bot on **one Linux VPS**, supervised by **pm2**.

Architecture (two long-lived pm2 apps, one SQLite database shared between them):

```
                  SSH tunnel (operator)                 chromium trees
  you ──────────────────────────────────►  fb-control  ──pm2 start/stop──►  fb-worker
  (laptop)        :8080 loopback only      (server/index.js)               (index.js)
                                                  │                              │
                                                  └──────────  db/fb-bot.db  ────┘
                                                       (WAL; control reads, worker writes)
```

- **`fb-control`** — the Express management API + the built web UI. Bound to
  **127.0.0.1 only** (reached over an SSH tunnel). It is how you start/stop the
  worker, edit accounts, and watch the activity feed.
- **`fb-worker`** — the automation engine. One headless chromium browser per
  enabled account. The control plane starts/stops it **by pm2 app name**
  (`fb-worker`), so that name is a hard contract — see *pm2 topology* below.

> SECURITY: the control plane **refuses to boot** on a non-loopback `CONTROL_HOST`
> (`server/config.js`). It is never directly internet-facing. All admin access is
> through the SSH tunnel in step 8.

---

## 0. Prerequisites (install once on the VPS)

| Need | Why |
|---|---|
| **Node.js 18+** (LTS, e.g. 20 or 22) | Runtime. `better-sqlite3` ships native bindings per Node ABI; 18+ also gives the global `fetch` the healthcheck webhook uses. |
| **Build toolchain** — `build-essential`, `python3` (Debian/Ubuntu) | `better-sqlite3` compiles native code at install time. |
| **pm2** (global) | Process supervisor. `npm install -g pm2` |
| **Chromium OS deps** | Playwright's headless chromium needs system libraries. Installed in step 4. |

```bash
# Debian / Ubuntu example
sudo apt-get update
sudo apt-get install -y build-essential python3 git curl

# Node via your preferred method (nvm shown); then pm2 global:
nvm install 20 && nvm use 20      # or distro packages / nodesource
npm install -g pm2

node --version    # expect v18+ (v20/v22 recommended)
pm2 --version
```

### 0a. Set the system timezone (IMPORTANT — the governor uses localtime)

The safety **governor schedules everything on the SERVER-LOCAL clock**, not UTC:

- **Active-hours window** — actions only run between `active_hours_start` and
  `active_hours_end`, interpreted in the server's local time.
- **Daily action caps** — "today" is the server's local calendar day
  (`datetime('now','localtime','start of day')` in `db.js countActionsToday`).

A fresh cloud VPS almost always defaults to **UTC**. If you leave it on UTC while
intending, say, "active 09:00–22:00 America/New_York", the windows and the daily-cap
reset will fire on the **wrong clock** — the bot can run overnight or reset caps at
the wrong hour, both of which raise ban risk. Set the timezone to match the basis
you intend your active-hours to mean:

```bash
# List zones, then set yours (example shown):
timedatectl list-timezones | grep -i new_york
sudo timedatectl set-timezone America/New_York

timedatectl    # confirm "Time zone: America/New_York (...)"
```

> **Restart pm2 after changing the timezone** so the worker process picks up the new
> `TZ` (`pm2 restart all`), otherwise an already-running worker keeps the old zone.
>
> **`accounts.timezone_id` is SEPARATE.** That per-account field sets the browser's
> emulated timezone (Playwright `timezoneId`) for fingerprint realism — it does NOT
> change when the governor runs. The governor is global and uses the *system* clock.
> Keep the system timezone aligned with your intended active-hours basis; set each
> account's `timezone_id` to whatever that account's persona/proxy should appear as.

### 0b. Raise the open-file limit (chromium opens many fds)

Each enabled account runs its **own chromium browser**, and a chromium tree opens a
large number of file descriptors (pipes, sockets, font/cache files). The default
soft limit of **1024** can be exhausted by even a few concurrent accounts, surfacing
as cryptic `EMFILE: too many open files` crashes that pm2 then restart-loops.

```bash
# Check the current soft/hard limits for your user:
ulimit -Sn   # soft
ulimit -Hn   # hard

# Persistent raise (login sessions) — append to /etc/security/limits.conf:
#   <user>  soft  nofile  65535
#   <user>  hard  nofile  65535
# then log out/in.
```

**pm2 launched at boot via systemd does NOT inherit your shell `ulimit`.** Set the
limit on the pm2 systemd unit itself, or it will silently keep the 1024 default:

```bash
# The unit name is printed by `pm2 startup` (commonly pm2-<user>.service):
sudo systemctl edit pm2-$USER     # opens a drop-in override
# add:
#   [Service]
#   LimitNOFILE=65535
sudo systemctl daemon-reload
pm2 save && pm2 resurrect          # or reboot; verify with the cat below
# Verify the running worker actually got it:
cat /proc/$(pgrep -f 'index.js' | head -1)/limits | grep 'open files'
```

> Rule of thumb: budget a few hundred fds per concurrent account browser plus
> headroom. 65535 is comfortable for a handful of accounts on a modest VPS.

---

## 1. Get the code

```bash
sudo mkdir -p /opt/fb-automation && sudo chown "$USER" /opt/fb-automation
git clone <your-repo-url> /opt/fb-automation
cd /opt/fb-automation
```

All remaining commands assume you are in the project root (`/opt/fb-automation`).

---

## 2. Install dependencies

```bash
# Backend deps (uses the committed lockfile; compiles better-sqlite3 here).
npm ci

# Web UI deps (separate package under web/).
npm --prefix web ci
```

> If `npm ci` fails on `better-sqlite3`, the build toolchain from step 0 is
> missing or the Node version changed since the lockfile was made — re-check
> `node --version` and re-run.

---

## 3. Configure secrets / environment (`.env`)

```bash
cp .env.example .env
```

Then fill in `.env`. The four hard-required values and how to generate them:

```bash
# (a) Master key for encrypting FB credentials at rest (AES-256-GCM).
#     ⚠️ THIS VPS NEEDS ITS OWN KEY — see the warning below.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#     → paste into APP_ENCRYPTION_KEY=

# (b) Session cookie signing secret (>= 32 chars).
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
#     → paste into SESSION_SECRET=

# (c) CSRF signing secret (>= 32 chars, DIFFERENT from SESSION_SECRET).
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
#     → paste into CSRF_SECRET=

# (d) Admin password hash (bcrypt). Set the admin USERNAME in .env (ADMIN_USER),
#     then generate the hash for your chosen password:
npm run set-password -- "your-strong-admin-password"
#     → prints a $2b$... hash; paste into ADMIN_PASSWORD_HASH=
```

Also set:
- `OPENAI_API_KEY=` — your OpenAI key (used for AI comments/replies + vision fallback).
- `CONTROL_PORT=8080` — optional; default is 8080. Leave `CONTROL_HOST` unset
  (defaults to loopback; do **not** set it to `0.0.0.0`).

> ### ⚠️ THE ENCRYPTION KEY IS PER-VPS — credentials do not travel between machines
> FB account passwords/proxy passwords are encrypted with `APP_ENCRYPTION_KEY`
> and stored in the SQLite DB. **A credential encrypted on another box (your laptop,
> a staging server) CANNOT be decrypted on this VPS** unless you copy the SAME key.
> Recommended: generate a FRESH key on the VPS (above) and **re-enter each account's
> FB credentials through the web UI once the control plane is up** (step 8). If you
> deliberately migrate an existing DB, you must carry its matching key.

---

## 4. Install the headless browser + its OS libraries

```bash
npx playwright install --with-deps chromium
```

`--with-deps` pulls the system libraries chromium needs (fonts, X stubs, etc.) —
required on a headless VPS. This downloads a pinned chromium build for the
Playwright version in the lockfile.

---

## 5. Initialize the database

```bash
# Applies the schema idempotently and seeds singleton rows (settings, worker_state).
npm run migrate

# Optional: preview what a migration would do without writing.
npm run migrate:dry
```

The DB lives at `db/fb-bot.db` (override with `DB_PATH` in `.env`). It is created
in WAL mode so the control plane can read while the worker writes.

> If you are bringing an existing `accounts.json` / `config.json` from the legacy
> setup, `migrate.js` imports them into the DB (mapping `sessionFile → session_file`,
> encrypting passwords with the key from step 3). On a clean VPS you'll instead
> add accounts through the UI in step 8.

---

## 6. Build the web UI

```bash
npm run ui:build
```

This produces the static bundle the control plane serves at `/`. Re-run it
whenever you pull UI changes.

---

## 7. Launch under pm2

```bash
# Start both apps (fb-control + fb-worker) from the ecosystem file.
pm2 start pm2.config.js

# Persist the process list so it survives a reboot, and install the boot hook.
pm2 save
pm2 startup          # prints a sudo command — run it once as instructed.

pm2 status           # both fb-control and fb-worker should be listed
pm2 logs fb-control  # tail the control-plane log
```

> NOTE: `pm2 start pm2.config.js` brings up **both** apps. The worker
> (`fb-worker`) will boot, but it only does real work once at least one account
> is **enabled** and has a valid FB session (steps 8–9). You normally drive the
> worker on/off from the UI after that — both paths manage the same `fb-worker`
> app, so they never collide. See *pm2 topology* for why the name matters.

To reload after a code/UI change (zero-downtime for the control plane):

```bash
git pull
npm ci && npm --prefix web ci   # only if deps changed
npm run ui:build                # only if UI changed
pm2 reload pm2.config.js        # or: npm run pm2:reload
```

---

## 8. Access the UI (SSH tunnel) and add accounts

The control plane listens on **127.0.0.1:8080** only. Reach it by forwarding that
port over SSH from your laptop:

```bash
# On your LAPTOP:
ssh -L 8080:127.0.0.1:8080 user@your-vps-host
# Leave that SSH session open, then open in your browser:
#   http://localhost:8080
```

Log in with `ADMIN_USER` / the password you hashed in step 3. Then:
1. **Add each FB account** (name, email, target page URL, comment/reply/DM
   templates, proxy, daily cap, check interval). Enter the FB password here so it
   is encrypted with THIS VPS's key.
2. Leave the account **enabled**.

---

## 9. Generate Facebook sessions (the one remaining CLI step)

The worker authenticates to Facebook using a saved Playwright **session file**
(`sessions/<account-name>.json`), not by typing the password each run. You must
generate this session once per account from the CLI:

```bash
# Interactive — lists accounts, prompts which to log in:
node login.js

# Or target one account by name:
node login.js --account account1

# Or log in every account sequentially:
node login.js --all

# Non-interactive (e.g. first-run automation) — supply creds via env:
FB_EMAIL="you@example.com" FB_PASS="secret" node login.js --account account1
```

> IMPORTANT — `login.js` currently reads account name/email/sessionFile from the
> legacy **`accounts.json`** file (not the DB). On a clean VPS, either:
> - keep an `accounts.json` listing each account's `name` + `sessionFile`
>   (`sessions/<name>.json`) for the login step, **or**
> - use the `FB_EMAIL`/`FB_PASS` env form above to log a named account in directly.
>
> The worker itself reads `session_file` from the **DB** and resolves it relative
> to the project root, so the session file must land at the path the DB row points
> to (default `sessions/<name>.json`).

**Sessions expire.** If you rotate the FB password, FB forces a re-login, or FB
invalidates the session (suspicious-activity check), the stored session stops
working and the worker will fail to authenticate. **Re-run `node login.js
--account <name>`** to regenerate it, then restart the worker from the UI.

After sessions exist, start the worker from the UI (or it's already up from step 7).

---

## 10. Log rotation (pm2-logrotate)

pm2 logs grow unbounded by default. Install pm2's log-rotation **module** (this is
a `pm2 install`, NOT an npm dependency — it lives in the pm2 daemon, not this repo):

```bash
pm2 install pm2-logrotate

# Rotate when a log hits 20 MB, keep 14 rotated files, compress them, rotate daily.
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'   # midnight daily
```

The worker is chromium-heavy and chatty; `max_size` is the important knob to keep
the disk from filling. The pm2-captured log files live under `logs/` (gitignored) —
named `fb-control.{out,error}.log` and `fb-worker.{out,error}.log` (see
`pm2.config.js`).

### 10a. ALSO rotate `logger.js`'s own daily log files (pm2-logrotate does NOT)

⚠️ **pm2-logrotate only rotates pm2's stdout/stderr capture** (the four files
above). The application's own logger (`logger.js`) writes a **separate** file per
day directly to disk:

```
logs/automation_YYYY-MM-DD.log     # written by logger.js via appendFileSync
logs/screenshots/                  # screenshot-on-error captures
```

These are **append-only with no built-in size cap or retention** — a new file is
created each day and old ones are never pruned. On a long-running, chatty,
chromium-heavy worker they will accumulate and eventually fill the disk (which the
`ops-probe.js` disk check in §11 will then page on — but prevention beats paging).
Add a small cleanup cron (the dated filenames make age-based pruning trivial):

```cron
# Daily at 03:10 — delete automation logs older than 14 days and prune empty
# screenshot dirs. Mirrors the pm2-logrotate retention above.
10 3 * * * find /opt/fb-automation/logs -name 'automation_*.log' -mtime +14 -delete 2>/dev/null; find /opt/fb-automation/logs/screenshots -type f -mtime +14 -delete 2>/dev/null
```

> A heavier alternative is a logrotate(8) stanza for `logs/automation_*.log`, but
> because `logger.js` opens the file fresh on each write (no held handle), the simple
> `find -mtime -delete` above is sufficient and needs no `copytruncate`/HUP dance.

---

## 11. Worker-down alerting (healthcheck) + action-failure / ban + host probes

`scripts/healthcheck.js` is an out-of-band liveness probe. pm2 keeps the worker
*process* alive; the healthcheck catches the case where the process is "up" but
**silently wedged** (stale heartbeat). It reads the heartbeat straight from SQLite
(no dependency on the control plane being up).

It alerts **only** when the worker is supposed to be running
(`worker_state.desired_state = running`) **and** the heartbeat is stale (> 90s,
matching the control plane). A deliberate stop never alerts.

```bash
# Manual check (exit 0 = healthy, 1 = unhealthy/page, 2 = probe error):
npm run healthcheck
node scripts/healthcheck.js --json     # machine-readable
```

**Cron** (every 2 minutes; appends to a log, never lets a non-zero stop cron):

```cron
*/2 * * * * cd /opt/fb-automation && /usr/bin/node scripts/healthcheck.js >> logs/healthcheck.log 2>&1 || true
```

**uptime-kuma / monit**: point a "command" monitor at
`node /opt/fb-automation/scripts/healthcheck.js` and alert on a non-zero exit.

**Optional webhook** (Slack/Discord/generic incoming webhook): set in `.env` —
on an UNHEALTHY result the script POSTs a small JSON payload before exiting
non-zero. Best-effort and bounded; a webhook outage never changes the exit code.

```bash
# .env
HEALTHCHECK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
# HEALTHCHECK_WEBHOOK_TIMEOUT_MS=5000
# HEALTHCHECK_STALE_MS=90000     # keep in sync with the control plane
```

### 11a. Action-failure + ban-signal probe (`scripts/error-rate.js`)

The healthcheck answers *"is the worker ALIVE?"*. It does **not** answer *"is the
worker WORKING?"* — a worker can beat happily while every Facebook action FAILS
(selector drift, expired session) or while Facebook is actively **flagging the
account** (checkpoint / soft-block / ban). `scripts/error-rate.js` reads
`action_log` directly (read-only) and trips on **two** distinct signals:

| Signal | Trigger | Urgency |
|---|---|---|
| **High error rate** | `failed/(ok+failed)` over the window ≥ threshold (default 70% over 30 min, min 5 attempts) | investigate soon |
| **BAN SIGNAL** | **ANY** `action_log` row with `status='blocked'` in the window | **page NOW — stop the worker** |

`status='blocked'` is the worker's marker for a Facebook checkpoint/ban response.
One blocked row means Facebook noticed us; continuing risks a hard ban — so it pages
**immediately, regardless of rate**. `skipped` (governor-paced no-ops) are **excluded**
from the rate — a capped/paced worker is healthy, not failing.

```bash
# Manual (exit 0 = healthy, 1 = page, 2 = probe error):
npm run probe:errors
node scripts/error-rate.js --json

# Cron — every 5 minutes:
*/5 * * * * cd /opt/fb-automation && /usr/bin/node scripts/error-rate.js >> logs/error-rate.log 2>&1 || true
```

```bash
# .env (tunables — all optional, defaults shown)
# ERROR_RATE_WINDOW_MIN=30
# ERROR_RATE_THRESHOLD=0.70        # fraction 0..1
# ERROR_RATE_MIN_ATTEMPTS=5        # below this, rate is not judged (no false page)
# ERROR_RATE_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
# ERROR_RATE_WEBHOOK_TIMEOUT_MS=5000
```

### 11b. Host + control-plane probe (`scripts/ops-probe.js`)

Three host-level failures that silently take the whole deployment down — bundled
into one cron-friendly probe (exit 0/1/2, optional webhook):

| Check | What it detects | How |
|---|---|---|
| **Control-plane down** | the Express management API (fb-control) is unreachable → no UI, worker unmanageable | bounded `GET /healthz` over loopback |
| **Disk full** | a full disk corrupts the SQLite WAL and wedges the worker | `df` of the project mount ≥ threshold (default 90%) |
| **Restart storm** | a process is crash-looping (pm2 keeps restarting it) | pm2 restart-count **delta** since the last probe ≥ rate (default 3/min) |

```bash
# Manual:
npm run probe:ops
node scripts/ops-probe.js --json

# Cron — every 5 minutes (offset from the others to spread load):
*/5 * * * * cd /opt/fb-automation && /usr/bin/node scripts/ops-probe.js >> logs/ops-probe.log 2>&1 || true
```

```bash
# .env (tunables — all optional, defaults shown)
# CONTROL_HOST=127.0.0.1           # must match the control plane bind
# CONTROL_PORT=8080
# OPS_HEALTHZ_TIMEOUT_MS=4000
# OPS_DISK_THRESHOLD_PCT=90
# OPS_RESTART_RATE_PER_MIN=3
# OPS_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
```

> **Restart-storm needs two samples.** The first run records a baseline (restart
> counts at that instant) and reports healthy; the delta is computed against the
> persisted state on the *next* run. State lives in `logs/ops-probe.state.json`
> (override with `OPS_STATE_FILE`). This is why a delta-based signal beats alerting
> on a raw count — "50 restarts" over a month is fine; 50 in 5 minutes is a storm.

**Prefer raw one-liners over the script?** These are the equivalent shell probes
the operator can use directly (the script bundles them with bounded timeouts, a
single alert path, and the restart delta state the one-liners can't keep):

```bash
# control-plane liveness (non-zero exit on failure):
curl -fsS --max-time 4 http://127.0.0.1:8080/healthz >/dev/null || echo "CONTROL PLANE DOWN"
# disk:
[ "$(df -P /opt/fb-automation | awk 'NR==2{print $5+0}')" -ge 90 ] && echo "DISK >= 90%"
# restart-storm snapshot (eyeball the ↺ column for rapid growth between runs):
pm2 ls
```

### 11c. The `/healthz` endpoint (control-plane liveness)

The control plane exposes an **unauthenticated** `GET /healthz` (no secrets — returns
`{"ok":true,"service":"fb-control-plane"}`) for exactly this kind of probe and for a
quick "is my SSH tunnel + control plane up?" check. It is deliberately excluded from
the `/api` auth gate and from the SPA history fallback, so it stays a stable liveness
target regardless of login state or whether the UI has been built.

```bash
curl -fsS http://127.0.0.1:8080/healthz   # {"ok":true,"service":"fb-control-plane"}
```

> **Run all probes on the SAME host** as the deployment. The control plane binds
> loopback-only (`CONTROL_HOST` must be 127.0.0.1/::1/localhost), so a remote probe
> cannot reach `/healthz` — these crons belong in the VPS's own crontab.

---

## 12. Backups

The entire state — encrypted accounts, settings, runtime state, action log — is in
the single SQLite DB. Back it up regularly. Because of WAL, the safe copy is either
all three files together OR a `VACUUM INTO` snapshot:

```bash
# Preferred: a consistent single-file snapshot (works while the bot runs).
sqlite3 db/fb-bot.db "VACUUM INTO '/backups/fb-bot-$(date +%F).db'"

# Or copy the WAL set together (stop the worker first for a fully quiescent copy):
cp db/fb-bot.db db/fb-bot.db-wal db/fb-bot.db-shm /backups/   # -wal/-shm may be absent if checkpointed
```

Also back up `.env` (it holds `APP_ENCRYPTION_KEY` — **without it the backed-up
DB's credentials are unrecoverable**) and the `sessions/` directory (the FB
session files; losing them just means re-running `login.js`). Store `.env` and
backups securely — they are credential-equivalent.

---

## 13. Safety / ban-risk guidance

Facebook actively detects automation. The settings exist to make the bot behave
like a slow human; **aggressive cadence is the #1 cause of bans/checkpoints.**

- **Daily caps** (`daily_action_cap` per account, plus the global governor):
  keep them conservative. More accounts ≠ license to act faster.
- **Active hours / intervals** (`check_interval_minutes`, humanized typing/action
  delays): leave the human-like pacing on. Do not set tiny intervals.
- **Stagger**: accounts start staggered (`account_stagger_ms`) so they don't all
  hit FB simultaneously — keep it.
- **One identity per browser**: each account already runs in its own isolated
  chromium. For multiple accounts, use a **dedicated proxy per account**
  (`proxy_server`/`proxy_username`/`proxy_password` per account) so they don't
  share the VPS IP — a shared IP across many accounts is a strong ban signal.
- A flagged session shows up as the worker failing to authenticate (and the
  healthcheck/feed will show errors). Re-login per step 9, and consider easing
  the cadence.

---

## 14. Finalization reminders (security hygiene)

These are **user-gated** — do them deliberately, they are not part of routine deploy:

- **Rotate the previously-exposed OpenAI key.** If the old key was ever committed
  or shared, revoke it at the OpenAI dashboard and put the new one in `.env`.
- **Rotate FB passwords** for any account whose password may have been exposed,
  then re-run `node login.js` to refresh sessions.
- **Git history purge.** `config.json` and `accounts.json` exist in git history
  and may contain secrets. Purging history (e.g. `git filter-repo`) and
  force-pushing is a separate, deliberate, user-run step — not done here.

---

## Appendix A — pm2 topology (why the worker app name is a contract)

`pm2.config.js` declares two apps:

| App | Script | Role | Restart policy |
|---|---|---|---|
| `fb-control` | `server/index.js` | Express control plane + UI, loopback only | autorestart, `max_memory_restart: 300M`, backoff, `min_uptime: 5s` |
| `fb-worker` | `index.js` | Chromium automation worker | autorestart, `max_memory_restart: 1G`, exponential backoff, `max_restarts: 50`, `min_uptime: 20s`, `kill_timeout: 15s` |

The control plane starts/stops the worker **programmatically by pm2 app name**.
The name and script in `pm2.config.js` MUST equal the frozen constants in
`server/config.js` (`workerAppName: 'fb-worker'`, `workerScript: 'index.js'`). If
they diverge, `pm2 start pm2.config.js` and the UI's Start button manage *different*
processes → you can end up with **two** workers → double FB activity → ban risk.

Verify the contract holds at any time (should print `CONTRACT OK`):

```bash
node -e '
  const path=require("path");
  const w=require("./pm2.config.js").apps.find(a=>a.name==="fb-worker");
  process.env.ADMIN_USER="x";process.env.ADMIN_PASSWORD_HASH="$2b$12$"+"a".repeat(53);
  process.env.SESSION_SECRET="x".repeat(48);process.env.CSRF_SECRET="y".repeat(48);
  const sc=require("./server/config.js").loadConfig(process.env).worker;
  if(!w) throw new Error("no fb-worker app");
  if(w.name!==sc.appName) throw new Error("NAME MISMATCH "+w.name+" vs "+sc.appName);
  if(path.resolve(w.script)!==path.resolve(sc.script)) throw new Error("SCRIPT MISMATCH");
  console.log("CONTRACT OK:", w.name, path.resolve(w.script));
'
```

### Why these restart settings (H5 fix)

The old config had `max_restarts: 10` and no memory cap, which caused two failure
modes: (1) after 10 crashes pm2 abandoned the worker permanently — **silent death**
on a headless VPS; (2) chromium memory creep with no ceiling let the worker grow
until the kernel OOM-killed it (potentially taking the control plane with it). The
new policy keeps retrying with exponential backoff (self-heals transient blips
without hammering FB or spinning the CPU) and recycles the worker on its own terms
via `max_memory_restart` before the kernel intervenes. The worker exits cleanly
(code 0) on SIGTERM, so a deliberate `pm2 stop` / UI Stop is not fought by
autorestart.

---

## Appendix B — common operations

```bash
pm2 status                       # both apps' state, restarts, memory, cpu
pm2 logs fb-worker --lines 200   # tail worker log
pm2 restart fb-control           # restart just the control plane
pm2 stop fb-worker               # stop the worker (UI Stop does the same)
pm2 reload pm2.config.js         # graceful reload of both after a deploy
npm run healthcheck              # one-shot liveness probe (exit code)
npm test                         # backend test suite (run before deploying changes)
```
