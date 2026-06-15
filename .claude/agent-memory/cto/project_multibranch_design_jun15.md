---
name: project-multibranch-design-jun15
description: Multi-branch account feature — Phase 0+1 design package, locked decisions, challenger BLOCKING findings, go/no-go state as of 2026-06-15
metadata:
  type: project
---

Multi-branch support for fb-automation: one FB account (one login/session/fingerprint) runs N fully-isolated "branches" (e.g. same account does BOTH trading AND real estate). Phase 0+1 (design only) completed 2026-06-15 in a FULL_POWER session; user is sole acceptance gate, NO commits, stop after each phase.

**Why:** Today the `accounts` table owns all branch-level fields, forcing one account = one workflow. Decoupling "who logs in" (account) from "what work runs" (branch) lets one login run multiple page-monitoring workflows.

**How to apply:** When this feature resumes, the design is settled on these LOCKED choices — do not re-litigate:
- Default-branch primitive: `is_default INTEGER` on branches + partial unique index `WHERE is_default=1` (NOT a circular accounts.default_branch_id FK).
- Re-key 8 tables account_id->branch_id. Group A (content: account_comments/replies/dm_messages/groups) and Group B (state, where account_id was PK/UNIQUE: account_state/account_status/seen_comments/dm_sent) both via SQLite table-rebuild. seen_comments/dm_sent are ban-risk history — re-key never drop.
- Drop 6 cols off accounts (target_page_url, own_profile_url, send_dm_to_commenters, dm_as_page_url, check_interval_minutes, daily_action_cap) — SQLite 3.49.2 (better-sqlite3 11.10.0) supports DROP COLUMN.
- action_log gains branch_id (ADD COLUMN, not rebuild) for per-branch daily caps; ON DELETE SET NULL.
- schema_meta.version 1->2.

**CRITICAL pre-implementation requirements (challenger BLOCKING, must land before any live migration run):**
1. Row-count assertion COUNT(__new)==COUNT(old) INSIDE the tx before each DROP. FK check (foreign_key_check) CANNOT detect zero-row INSERT...SELECT data loss — this is the single most important safety fix.
2. Backup must verify wal_checkpoint(TRUNCATE) returned busy=0 AND no -wal sidecar remains, else torn backup. Stop worker+control-plane first.
3. Same-deploy code changes (else worker crashes first cycle): db.js ACCOUNT_UPDATE_COLUMNS (lines 138-149) drop the 6 cols + add BRANCH_UPDATE_COLUMNS; loadConfig.js split hydrateAccount->hydrateBranch(account,branch); worker iterates account->branches.
4. loadConfig .id meaning-shifts account->branch (core/state.js keys by .id) — carry accountId/accountName alongside; session_file/login paths use accountId, state/content paths use branch .id.

**Team note:** stack is Node CJS + better-sqlite3 + React/Vite/TS — do NOT route go/python/beam/laravel/infra experts. Build: elite-engineer + frontend-platform-engineer + database-expert. Tests: test-engineer with node:test (not jest/vitest). Plan + design files are returned-as-text only (no report .md written). See [[project-fb-automation-prodgrade]].
