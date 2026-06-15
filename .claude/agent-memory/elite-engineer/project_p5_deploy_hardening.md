---
name: project-p5-deploy-hardening
description: Phase 5 deploy/ops artifacts — pm2 two-app ecosystem (fb-control + fb-worker), the fb-worker name/script CONTRACT with server/config.js, H5 restart/memory fix, healthcheck intent-vs-mechanism alert semantics, log rotation, runbook
metadata:
  type: project
---

Phase 5 (deploy hardening + runbook) for the single-VPS pm2 deployment. Owned files only: pm2.config.js, README.md, docs/RUNBOOK.md, .env.example, package.json (scripts). Worker/server code owned by a parallel governor engineer — NOT touched.

**The fb-worker name/script CONTRACT (load-bearing).** The control plane (`server/worker-control.js:107-117`) starts/stops the worker programmatically by pm2 app NAME, built from FROZEN constants in `server/config.js:41-42` (`DEFAULTS.workerAppName='fb-worker'`, `workerScript='index.js'`). `pm2.config.js` MUST declare the worker app as name `'fb-worker'` running `index.js` or `pm2 start` and the UI Start button manage DIFFERENT processes → TWO workers → double FB activity → ban risk. The OLD config named it `'fb-bot'` (the H5 mismatch) — corrected this pass. Verify with the snippet in RUNBOOK Appendix A (`require()` both files, assert name+script equal → "CONTRACT OK").

**H5 restart/memory fix.** Old worker config: `max_restarts:10` + no `max_memory_restart` → (1) silent permanent death after 10 crashes on a headless VPS; (2) chromium memory creep → kernel OOM. New worker policy: `max_memory_restart:'1G'` (recycle before OOM), `exp_backoff_restart_delay:1000`, `max_restarts:50`, `min_uptime:'20s'`, `kill_timeout:15000` (> worker's own 12s SHUTDOWN_DEADLINE_MS in index.js so chromium drains before SIGKILL). fb-control: 300M cap, backoff, min_uptime 5s. autorestart:true is SAFE — `pm2 stop` parks "stopped" and pm2 does NOT autorestart a deliberate stop; worker also exits 0 on SIGTERM (index.js:101) so a stop reads as clean.

**Healthcheck alert semantics (scripts/healthcheck.js).** Pure `evaluate(ws, now)` (testable, no side effects) + read-only DB open (`{readonly:true, fileMustExist:true}` — does NOT use db.getDb() which would seed/write). Alert ONLY when `desired_state==='running'` AND heartbeat stale. Stale-while-stopped = NORMAL, never alerts (the intent-vs-mechanism model from worker-control.js:15-20). Threshold 90s + UTC parse `String(last).replace(' ','T')+'Z'` kept byte-identical to `server/routes/worker.js:28,39`. Exit codes: 0 healthy, 1 unhealthy (page), 2 probe-error (unknown). Worker beats every 25s (`worker/loop.js:57 HEARTBEAT_INTERVAL_MS`), control stale threshold 90s (`server/routes/worker.js:28 HEARTBEAT_STALE_MS`). Optional bounded webhook via HEALTHCHECK_WEBHOOK_URL (best-effort, never alters exit code).

**Session-file flow (runbook step 9 accuracy).** `login.js` reads name/email/sessionFile from legacy `accounts.json` (NOT the DB) and writes Playwright storageState to `sessions/<name>.json`. `migrate.js:92` maps `sessionFile → session_file` into the DB. Worker reads `session_file` from DB (`worker/loadConfig.js:41`), `path.resolve()`s it (`worker/loop.js:470`), passes as `storageState`. So the CLI login step needs accounts.json present OR the FB_EMAIL/FB_PASS env form.

**Log rotation:** pm2-logrotate is a `pm2 install` MODULE (lives in the pm2 daemon), NOT an npm dependency — documented in runbook §10, not added to package.json. Logs land in logs/ (gitignored), named fb-{control,worker}.{out,error}.log.

**eslint global convention:** the shared `eslint.config.js` (not owned) omits some Node globals; the codebase convention (index.js:22, worker/loop.js:3) is a top-of-file `/* global ... */` comment. healthcheck.js uses `/* global AbortController, fetch, clearTimeout, setTimeout */` to satisfy no-undef without editing the shared config.

**APP_ENCRYPTION_KEY is per-VPS:** creds encrypted on another box won't decrypt — generate fresh on VPS, re-enter creds via UI (runbook §3 warning).

package.json scripts added (no deps): healthcheck, pm2:start, pm2:reload. 78/78 backend tests still green. No commit made (working tree only — HARD constraint).
