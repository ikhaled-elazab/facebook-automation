---
name: p1-sqlite-schema-review
description: Phase 1 SQLite datastore (schema.sql/db.js/migrate.js) review findings — busy_timeout gap, governor global-cap full scan, action_log retention
metadata:
  type: project
---

Phase 1 converted loose JSON/file state to SQLite (better-sqlite3 11.10, WAL). Two processes share one DB on a VPS: long-lived worker (writes) + control-plane web UI (reads/CRUD). P5 adds a pacing governor querying action_log for per-account + global daily caps.

**Why:** Reviewed 2026-06-12 as the independent database-expert gate (schema was written AND self-reviewed by the CTO under degraded tooling — single-author gap).

**How to apply:** When P2/P3/P5 build on this DB, the two highest-priority fixes below must land first.

## Verified findings (from live DB EXPLAIN QUERY PLAN + row inspection)
- **HIGH — busy_timeout never set in db.js.** `db.js:42-44` sets only `journal_mode=WAL` + `foreign_keys=ON`. Live DB confirms `PRAGMA busy_timeout` = 0. Two processes will hit `SQLITE_BUSY` on the WAL writer-lock (WAL allows concurrent readers but only ONE writer; UI write + worker write collide). Fix: `db.pragma('busy_timeout = 5000')` in getDb(). busy_timeout is per-connection, does NOT persist in file.
- **HIGH — governor GLOBAL daily-cap query does full SCAN action_log.** EXPLAIN: per-account query `SEARCH ... USING INDEX idx_action_log_acct_day` (good), but global `WHERE status='ok' AND date(created_at)=date('now')` (no account_id) → `SCAN action_log`. global_daily_action_cap (settings.global_daily_action_cap) is the P5 path. Fix: add `CREATE INDEX idx_action_log_created ON action_log(created_at)`.
- **MEDIUM — countActionsToday uses `date(created_at)=date('now')`** (db.js:266). The `date()` wrapper on the column is non-sargable for any future created_at index; the leading `account_id=?` saves the per-account case but the predicate can't range-seek by day. Prefer half-open range: `created_at >= date('now') AND created_at < date('now','+1 day')`. Also: `date('now')` is UTC; active_hours_start/end are "local hour" — timezone mismatch risk for day-boundary.
- **MEDIUM — action_log unbounded, no retention/trim.** Feeds governor + UI recent-events forever. At volume the global SCAN compounds. Need a retention job (DELETE older than N days) in P5.
- **LOW — settings.global_daily_action_cap=0 means "unlimited"** per comment but governor code (P5) must special-case 0; not enforced yet.

## Confirmed SOUND (do not re-flag)
- All FKs have `ON DELETE CASCADE`; child tables indexed on account_id.
- Dedup UNIQUE keys correct: seen_comments(account_id,post_url,comment_id), dm_sent(account_id,profile_url). getSeenComments uses COVERING INDEX (autoindex). All writes use `ON CONFLICT DO NOTHING` (no read-then-write race).
- All queries parameterized; table names in replaceChildText/getAccountChildText are hardcoded literals (not user input) — no injection.
- migrate.js child inserts wrapped in db.transaction(); idempotent via upsert-by-name + ON CONFLICT DO NOTHING for state rows.
- Singletons seeded via INSERT...ON CONFLICT DO NOTHING (settings/worker_state/schema_meta id=1).

## Gotchas observed
- index.js does NOT yet call any db.js function (grep empty) — DB layer written ahead of worker wiring. Governor query plans are validated against schema, not against real call sites yet.
- crypto.js exports encrypt/decrypt/isKeyConfigured/generateKey — migrate.js deps satisfied.

## P5 GOVERNOR DATA-LAYER REVIEW (2026-06-12) — all P1 findings CLOSED + new caller bug found
Re-reviewed after P5 wired the governor. Every P1 finding above was fixed:
- busy_timeout=5000 + synchronous=NORMAL now set per-connection in db.js (getDb).
- idx_action_log_created added → global cap query VERIFIED `SEARCH USING INDEX idx_action_log_created` (NOT scan) on live db.
- countActionsToday rewritten to half-open UTC range with BARE created_at — sargability technique: compute local-day midnight bounds, convert to UTC (`datetime('now','localtime','start of day','utc')` .. `+1 day`), so created_at stays index-addressable AND timezone-correct. Per-account → `SEARCH USING INDEX idx_action_log_acct_day`. Both verified by EXPLAIN QUERY PLAN against db/fb-bot.db.
- trimActionLog(days) added with guard `Number.isFinite(n)&&n>0 ? floor(n) : 30` — structurally CANNOT delete-all (verified). days binds as param inside `datetime('now', ?)` → no injection.
- account_status table (PK=account_id, FK cascade) added to fix single-row heartbeat last-writer-wins. Upsert correct, last_cycle_at bumps only on ok|error via CASE.

**NEW HIGH (caller-side, NOT data layer) — false-success poisons the cap count.** The COUNT correctly filters status='ok', BUT the worker writes 'ok' UNCONDITIONALLY after every attempt with no success assertion: worker/loop.js:265, fb/monitor.js:307, fb/monitor.js:332. The :332 DM logs 'ok' even when sendDmToUser deduped to a no-op (admitted in :329 comment). Net: cap counts ATTEMPTS not SUCCESSES → trips early / over-restricts. Query is innocent; fix belongs to elite-engineer (gate 'ok' on real success, log 'failed' otherwise). DST caveat on the bound arithmetic is LOW/document-only (1h boundary skew twice/yr, self-corrects). Verdict: governor queries production-sound + index-efficient; only the caller needs a fix.
