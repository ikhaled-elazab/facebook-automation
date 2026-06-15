---
name: p2-worker-reliability
description: P2 worker decomposition reliability gate — crash-handler-keep-alive creates silent zombie accounts; heartbeat never written; per-account browser orphan-on-SIGTERM leak.
metadata:
  type: project
---

P2 decomposed monolith `index.js` into core/ + fb/ + worker/. Independent reliability gate (2026-06-12) found the crash-handler design is the load-bearing risk, not the browser-close discipline.

**Fact 1 — silent zombie account (the real HIGH).** `index.js:34-41` installs `unhandledRejection`/`uncaughtException` handlers that log-and-keep-running. Combined with `worker/loop.js:243-247` `while(true)` loop where, if `runOneCycle` throws (only path: `monitorAndReplyToComments` at loop.js:232, NOT try-wrapped inside runOneCycle), the loop BREAKS → finally closes that account's browser (loop.js:251) → account is dead FOREVER. `checkAndAct` swallows all errors (loop.js:131-133) so it never breaks the loop; the gap is monitor + any throw from db calls / sleep. No in-process restart of a dead account exists. `runAccount(...).catch()` at index.js:69 only fires once (loop already exited).

**Fact 2 — heartbeat never written.** `db.heartbeat()` (db.js:291) has ZERO callers in worker path (grep-confirmed). Control plane `/worker/status` "stale heartbeat = silently-dead worker" (server/routes/worker.js:16-18) reads a perpetually-NULL value. So a dead-account zombie is invisible to BOTH in-process restart (none) and the staleness detector (unfed). This is the detection gap that makes Fact 1 dangerous in production.

**Fact 3 — per-account browser orphan-on-kill.** No SIGTERM/SIGINT handler in `index.js`. PM2 stop/restart hard-kills node mid-cycle; detached chromium children can orphan. New design has N browsers (one per account) vs monolith's 1 → orphan blast radius is N×. Real new leak surface from the per-account-browser fix.

**What is SOUND (verify-before-claim cleared these):**
- Browser close discipline is BETTER than monolith — new code added `try{loop}finally{browser.close()}` (loop.js:239-252); monolith had no per-account browser cleanup. `context.close()` (loop.js:234) in finally on every cycle path closes pages too — no page leak.
- DB dedup correct: `seen_comments UNIQUE(account_id,post_url,comment_id)` + `dm_sent UNIQUE(account_id,profile_url)` (schema.sql:134,144) with `INSERT...ON CONFLICT DO NOTHING` (db.js:233,251). Idempotent, crash-safe at row level.
- No intra-process DB race: single `_db` singleton (db.js:25), better-sqlite3 synchronous → writes are atomic+blocking within one process. busy_timeout=5000 handles cross-process (worker vs control-plane).
- Credentials clean: FB `password_enc` hydrated as ciphertext, NEVER decrypted in fb/ or worker (worker runs on session storage state). Only proxy password decrypted, at context-build, try-wrapped (loop.js:156).
- DM double-gate (dm.js:113-114) preserves monolith semantics (orig index.js:1012-1013 had both gates). Default flipped opt-out→opt-in (safer) — documented, not a regression.
- scope.js / scrape.js / share.js are clean byte-for-byte ports — no selector/timeout/retry drift.

**MEDIUM crash-safety interaction:** seen-comments still flushed once at end of post loop (monitor.js:294 via state.js:180-184), NOT per-id. A swallowed mid-loop crash + keep-alive re-run can re-DM/re-reply people already acted on (in-memory Set lost before flush). DB now makes per-id flush trivial.

**Test gap:** loop.js (the reliability-critical file) has NO test. test/ covers crypto/db/loadConfig/migrate/retry/state/server only.
