---
name: project-p2-multibranch
description: Phase 2 multi-branch build — accounts(login)→branches(monitoring 1:N) split, the `.id` meaning-shift to branch_id, three-tier cap governor, migrate.js raw-conn-before-getDb ordering gotcha, three production paths
metadata:
  type: project
---

Phase 2 split the per-account 1:1 model into accounts (LOGIN envelope) : branches (MONITORING unit, 1:N). User-approved schema delta + challenger review preceded the build. Built v2 on a temp DB only; live db/fb-bot.db never touched this round.

**Why:** one Facebook login (browser + session) must monitor multiple target pages/profiles independently — each branch owns target_page_url/own_profile_url/dm_as_page_url/check_interval_minutes/content arrays + its own state + its own daily cap.

**How to apply (load-bearing facts for future phases):**

- **The `.id` meaning-shift (grep-verified):** LOGIN/SESSION paths (login.js, fb/scrape.js, fb/actions/*.js) read only `account.name`/`account.sessionFile`/creds → stay account-keyed. STATE/CONTENT/GOVERNOR/LOGGING paths (core/state.js, core/governor.js, core/ban-signal.js, worker/loop.js, fb/monitor.js) read `.id` → that `.id` is now the BRANCH id. `hydrateBranch(acctRow, branchRow)` returns `.id`=branch id with `accountId`/`accountName` carried alongside + envelope (creds/session/proxy/fingerprint) merged in. Its exact key set is asserted in test/migration-v2.test.js (the fb/ contract).

- **Three-tier cap hierarchy (governor):** branch.dailyActionCap (NULL→inherit) → account.daily_action_cap CEILING (NULL→inherit) → settings.global_daily_action_cap (0=unlimited). NULL at a tier inherits the next-broader cap VALUE and the branch tier enforces it. accounts.daily_action_cap was RETAINED (NOT dropped) — it sums across the account's branches. db.countBranchActionsToday(branchId) is the new per-branch counter (idx_action_log_branch_day); db.countActionsToday(accountId) unchanged for the ceiling/global tiers. action_log carries BOTH account_id + branch_id (logAction resolves owning account from branchId). Default-branch cap seeded NULL on purpose — copying the account cap would DOUBLE the budget when a 2nd branch is added.

- **MIGRATION ORDERING GOTCHA (caught by integration smoke test, not the round-trip unit test):** db.getDb() applies the v2 schema.sql head which has `CREATE INDEX ... ON seen_comments(branch_id)`. That FAILS against a v1 table whose column is still account_id (IF NOT EXISTS does NOT save you — table exists, column doesn't). FIX: migrate.js runs migrateToV2 on a RAW better-sqlite3 connection BEFORE db.getDb() is ever opened. Lesson: always run a full-runner integration test, not just the direct-function unit test — the round-trip test calling migrateToV2() directly never hit this.

- **The 4 challenger fixes live in migrations/v2_branches.js:** BLOCKING-1 = per-table COUNT(__new)==COUNT(old) INSIDE tx before DROP + assertOneDefaultPerAccount (foreign_key_check can't see zero-row loss). BLOCKING-2 = preflightV2Checkpoint in migrate.js (wal_checkpoint TRUNCATE, busy==0, abort on persistent -wal, worker-stopped runbook). TX STRUCTURE = version-gate→foreign_keys=OFF OUTSIDE tx→one transaction→foreign_key_check after→restore FK. The migration is a self-contained module operating on a Database HANDLE so tests drive it against a temp DB.

- **Three production paths, all verified green:** (1) fresh install no DB → db.getDb() creates v2 + legacy accounts.json import writes account+default-branch+branch-content; (2) v1 upgrade → raw-conn migrate re-keys 8 tables onto default branches + drops 5 cols + backfills action_log; (3) idempotent re-run → "already at v2, skipping".

- **EXPECTED test drift (Phase 4 work, NOT regressions):** ~51 pre-existing tests fail because they use the v1 API — renamed accessors (getAccountComments→getBranchComments, setAccountStatus→setBranchStatus, getAccountState→getBranchState), old governor canAct(account) cap semantics, old hydrateAccount, and v1 columns (insertAccount with target_page_url now errors). server/routes/*.js ALSO still use old account-keyed accessors + v1 columns (Phase 3). My new test/migration-v2.test.js is 4/4 green. Source is correct; tests + server routes need migrating next.
