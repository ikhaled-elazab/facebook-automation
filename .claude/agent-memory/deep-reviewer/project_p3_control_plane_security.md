---
name: p3-control-plane-security
description: P3 control-plane (server/) security gate verdict — dynamic-SQL trust boundary is SAFE (fixed key-sets), auth/CSRF/secrets sound; only LOW/INFO residuals.
metadata:
  type: project
---

P3 control-plane security gate (2026-06-12, independent verification, all claims verified against source + 15/15 passing integration tests).

**Verdict: CONDITIONAL PASS (secure to expose on localhost behind SSH tunnel and to build P4 UI against). 0 CRITICAL, 0 HIGH.**

**Dynamic-SQL trust boundary = SAFE (not exploitable).** db.js insertAccount (db.js:117-120) and updateSettings (db.js:89-91) DO interpolate object keys into column lists, BUT:
- Routes never forward raw client objects. accounts.js `splitPayload` (server/routes/accounts.js:41-58) rebuilds the object by iterating the FROZEN `ACCOUNT_COLUMN_KEYS`/`ACCOUNT_CHILD_KEYS` constants (schemas.js:138-139), copying only those keys. Client keys can NEVER become column names.
- updateSettings is fed a zod `.strict()` patch (settings.js:38) — unknown keys rejected 422.
- db-extra.updateAccount (server/db-extra.js:59-80) has a SECOND independent `ALLOWED_SET` allowlist guard (throws on any non-allowlisted key) — defense in depth.
- replaceChildText/getAccountChildText `${table}` interpolation (db.js:129,131,162) is fed only frozen string literals from internal wrappers (setAccountComments etc.) — never client input. Verified via repo-wide grep: zero external callers pass a table name.
- Values are ALWAYS parameterized (`@col` / `?`), never interpolated.
- Test test/server.test.js:210 attacks the boundary with `injected_column:'DROP TABLE accounts'` → confirmed 422.

**Auth/CSRF/secrets all sound:** bcrypt with DECOY_HASH constant-time path (auth/middleware.js:50-55); session regenerate on login (auth.js:58); httpOnly+SameSite=strict+Secure-in-prod signed cookies, SQLite server-side store (app.js:117-133); csrf-csrf@4 double-submit enforced on all mutating routes; serializers.js allowlist projection (secrets never serialized, has_password bool pattern); worker-control.js uses pm2 programmatic API only — ZERO child_process/shell, frozen app config; index.js:49 binds config.host (default 127.0.0.1) explicitly.

**Residuals (LOW/INFO only, do not block P4):**
- LOW: worker.js:67,83 leaks pm2 `err.message` to client via 503 `reason` field. Low risk (localhost, pm2 internal strings) but inconsistent with the otherwise-strict no-internal-leak error policy.
- LOW: pre-auth GET /api/auth/csrf (auth.js:36-43) calls session.save(), creating a persisted session row per unauthenticated hit — unbounded session-store growth (DoS-ish). Localhost+tunnel makes it academic; the 15-min sweeper only clears EXPIRED rows.
- INFO: CONTROL_HOST env can override the loopback bind (config.js:74). Documented "do NOT change to 0.0.0.0" but not enforced in code — a misconfigured env could expose it. Consider rejecting non-loopback host in loadConfig.
- INFO: integration test (test/server.test.js) exercises the REAL cookie+CSRF transport (getSetCookie parse → resend → x-csrf-token echo) — this is the gold-standard auth-transport coverage, not actingAs()-style faking. Strong.

Separately tracked (NOT a P3-code issue): live secrets still in git history — see [[p1-secret-history-exposure]].
