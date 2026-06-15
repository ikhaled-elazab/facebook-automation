---
name: project-control-plane-p3
description: Phase 3 control-plane API (server/) architecture, the db.js trust boundary, missing db.js accessors, and two library event-loop/exit bugs found
metadata:
  type: project
---

Phase 3 built `server/` — a local-only Express 5 control-plane API for the FB bot, consuming db.js/crypto.js as a downstream adapter (hexagonal). Bound to 127.0.0.1, bcrypt single-login, SQLite-backed sessions, csrf-csrf double-submit, zod validation, pm2 programmatic worker supervision.

**Why:** Multi-builder parallel conversion; server/ owns API layer only, must NOT touch index.js/db.js/schema.sql/crypto.js/config.json/worker/ (other builders own those).

**How to apply (load-bearing facts for future work in this repo):**

1. **db.js dynamic-column trust boundary** — `db.insertAccount(fields)` and `db.updateSettings(patch)` build SQL column lists from the *keys of the passed object* (`INSERT INTO accounts (${cols})`). db.js trusts its caller. The API's zod `.strict()` schemas (server/schemas.js) ARE that trust boundary — `.strict()` rejects unknown keys so an attacker key can't reach the dynamic SQL. Any new caller of these db.js functions MUST allowlist keys first.

2. **db.js IS now the single data-access layer (db-extra.js REMOVED, post-gate fix pass).** `updateAccount`, `deleteAccount`, `recentActions` were upstreamed from the old server/db-extra.js into db.js and db-extra.js was deleted. `db.updateAccount(id, columns)` keeps its OWN independent column allowlist (`db.ACCOUNT_UPDATE_COLUMNS`, exported) — a second guard beyond the zod schema; a key outside it throws. `db.recentActions({limit,accountId,before})` returns `{events,total,has_more,next_before}` (cursor pagination, over-fetch-by-one, total ignores cursor). All SQL parameterized.

3. **better-sqlite3-session-store has TWO bugs** (v0.1.0): (a) its expired-session sweeper uses an un-unref'd `setInterval` whose handle it discards → keeps the Node event loop alive → process never exits (hangs `node --test`, any embedder). (b) its `clear` option is `(opts.expired.clear) || true` so `clear:false` CANNOT disable it (the `|| true` always wins). Fix in server/app.js: patch `SqliteStore.prototype.startInterval` to unref the timer + store the handle.

4. **require('pm2') opens a PipeWrap** at module load — but it's unref'd and does NOT block exit (red herring). Still, worker-control.js lazy-requires pm2 (only inside start/stop/status) for a smaller idle footprint.

5. **csrf-csrf v4 + express-session saveUninitialized:false interaction** — the CSRF token binds to req.sessionID, but an unmodified session is never persisted with saveUninitialized:false, so the sessionID changes per request and the token never validates. Fix: the GET /api/auth/csrf route marks the session modified + calls req.session.save() before issuing the token (server/routes/auth.js). **Post-gate hardening:** pre-auth /csrf hits would persist a full 8h session row each (unbounded growth) — the route now sets `req.session.cookie.maxAge = config.csrfBootstrapTtlMs` (default 5min, `CSRF_BOOTSTRAP_TTL_MS`) ONLY when `!req.session.authenticated`; login's `regenerate()` yields a fresh session inheriting the full 8h. express-session emits `Expires` not `Max-Age` (verify TTL via the Expires delta, not a Max-Age grep).

7. **API boundary is snake_case (contract).** CSRF token field is `csrf_token` (was `csrfToken`). Settings response is an explicit `SETTINGS_PUBLIC_FIELDS` allowlist (serializers.js), NOT `{...row}` passthrough — mirrors the accounts allowlist, fails closed on new schema.sql columns, omits the singleton `id`, includes `updated_at`. GET /api/status/events returns `{events,total,has_more,next_before}` with `?limit=`(≤500)`&before=`(cursor)`&account_id=`.

8. **Worker start/stop return the UNIFIED status shape** (HIGH-2 fix): `buildWorkerStatus(workerControl, cfg)` in routes/worker.js is the single status builder. GET /status returns it verbatim; POST /start|/stop return `{ok, action, ...sameShape}` where `action ∈ started|restarted|stopped|noop` (idempotency enum from worker-control.js, layered on top). pm2 errors are logged server-side (logger passed into workerRouter from app.js) and returned to the client GENERICALLY ('worker process manager unavailable' / 'pm2 status unavailable') — never `err.message` (LOW-1).

9. **config.js enforces loopback bind** (INFO-1): `CONTROL_HOST` must be in `{127.0.0.1, ::1, localhost}` or loadConfig THROWS at startup. No longer just a comment warning.

6. **Worker supervision = desired-vs-actual reconciliation**: worker_state.desired_state (DB) is durable INTENT, written FIRST; pm2 is the MECHANISM. db.heartbeat() (worker-written) is ACTUAL. /worker/status combines all three + heartbeat staleness (>90s).

Related: [[project-live-db-index-apply]]
