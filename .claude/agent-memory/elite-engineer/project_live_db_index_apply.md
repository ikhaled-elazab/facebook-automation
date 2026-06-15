---
name: project-live-db-index-apply
description: How to land a schema.sql index change into the already-existing live SQLite DB (db/fb-bot.db) without re-running full migrate
metadata:
  type: project
---

To add an index/object to BOTH schema.sql AND the existing live `db/fb-bot.db`, prefer a surgical one-off over `npm run migrate`.

**Why:** `migrate.js:198` calls `db.getDb()` which re-applies all of `schema.sql` (idempotent via `IF NOT EXISTS`), but it ALSO re-upserts settings + accounts from config.json/accounts.json — a wide blast radius for a one-line index add. A targeted `node -e "db.exec('CREATE INDEX IF NOT EXISTS ...')"` against `db/fb-bot.db` touches exactly one object, same idempotency guarantee.

**How to apply:** when a fix edits `db/schema.sql` to add an index but the live DB already exists, run the single CREATE statement directly via better-sqlite3, then VERIFY with `PRAGMA`/`sqlite_master` query + `EXPLAIN QUERY PLAN`.

**Sargability gotcha (verified 2026-06-12):** a plain index on `created_at` will NOT be used by `WHERE date(created_at)=date('now')` (function-wrapped column = non-sargable → SCAN). The P5 governor's global daily-cap query MUST use the sargable range form `WHERE created_at >= date('now') AND created_at < date('now','+1 day')` to get `SEARCH ... USING COVERING INDEX idx_action_log_created`. Index `idx_action_log_created` added to schema.sql:164 and live DB for this purpose.

Related: per-connection pragmas (`busy_timeout`, `synchronous`, `foreign_keys`) must be re-applied in db.js code on every open — only `journal_mode=WAL` persists in the file header. See [[project-sqlite-per-connection-pragmas]].
