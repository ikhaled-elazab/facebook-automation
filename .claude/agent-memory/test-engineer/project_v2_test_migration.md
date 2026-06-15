---
name: v2-multibranch-test-migration
description: Phase 4 — migrating the v1 test suite to the v2 multi-branch + DB-login schema; the v2 test harness invariants and the loop.js HIGH-1 production bug found during it.
metadata:
  type: project
---

# Phase 4: v1→v2 test-suite migration (multi-branch + DB-driven login)

Phase 4 of the v2 refactor (accounts = login envelope; branches = 1:N monitoring unit;
8 tables re-keyed account_id→branch_id; DB-driven login). Brought the suite from
51 failing / 142 passing → 203 passing / 1 failing (204 total). The single remaining
failure is a REAL production bug (see below), not test drift.

**Why:** the ~51 failures were v1-API drift — tests using removed accessors / v1 account
bodies that set fields that moved to branches.
**How to apply:** when migrating a v1 test to v2, apply the harness invariants below.

## v2 test-harness invariants (load-bearing — get these wrong and tests pass-but-test-nothing)

- **A hydrated "account" POJO's `.id` is the BRANCH id**, not the account id. `core/state.js`
  + `core/ban-signal.js` + `worker/loop.js checkAndAct` key STATE/CONTENT/LOG/STATUS on
  `account.id` → which must be a branch id. Passing an account id FK-fails the
  `account_state(branch_id)` write and `checkAndAct` SWALLOWS it in its try/catch → the
  whole cycle logs ZERO actions (silent). The hydrated branch carries `accountId` +
  `branchId` separately for the login/ceiling tiers.
- **`db.insertAccount` no longer accepts** target_page_url / own_profile_url /
  send_dm_to_commenters / dm_as_page_url / check_interval_minutes (moved to branches) — a
  v1 seed with any of these now throws SQLITE_ERROR. `daily_action_cap` STAYS (account ceiling).
- **Accessor renames:** getAccountComments/Replies/DmMessages/Groups → getBranch*;
  getAccountState → getBranchState; setAccountStatus/getAccountStatus/listAccountStatuses →
  setBranchStatus/getBranchStatus/listBranchStatuses (account_status.account_id → branch_id);
  hydrateAccount(row) → hydrateBranch(acctRow, branchRow).
- **Governor `canAct(branch)` is THREE-tier:** branch cap (`dailyActionCap` via
  `countBranchActionsToday(branch.id)`), account ceiling (`accountDailyActionCap` via
  `countActionsToday(branch.accountId)`), global. A v1 test that injected only
  `countActionsToday` and expected `dailyActionCap` to be the account cap is wrong — inject
  `countBranchActionsToday` too, and use `accountDailyActionCap` for the ceiling tier.
- **`detectBanSignal` logs `branchId: account.id`**, not `accountId` (db.logAction resolves
  the owning account_id). Assert `logged[0].branchId`.
- **GET /api/status per-account shape is the v2 ROLLUP:** keys are exactly
  `{id,name,enabled,actions_today,last_status,branch_count,branches}` — last_detail/last_cycle_at
  moved to the per-branch drill-down entries (`branches[]`). last_status is worst-case rollup.
- **Account create body is the ENVELOPE only** — a stale client sending a moved branch field
  gets a clean 422 from the schema `.strict()`, never a 500.

## New guards added (the gates asked for these)

- `test/contract-runtime.test.js` — RUNTIME exact-key `deepStrictEqual` on serialized output
  for account (list+get, incl. branch_count), branch (serializeBranch list vs
  serializeBranchWithChildren item), status (per-account + per-branch supersets), and the login
  envelope ({login: LoginSessionView}). Catches BOTH drift directions (missing AND extra/leaked
  key) at the JS-server↔TS-client boundary that `tsc` cannot see. Mutation-verified: injecting a
  stray serializer key fails it. Extends the branches.test.js:619 pattern.
- `test/login.test.js` security gaps: (a) undecryptable/wrong-key `password_enc` → real
  registry throws BadRequest + HTTP 400 (not 500), no stack/secret in body; (b) abort() racing
  an in-flight launchBrowser() closes the browser (no orphan) — mutation-verified by neutering
  `_closeBrowser`.

## Test-isolation note

`crypto.js` caches the key at require time; to forge wrong-key ciphertext, set
`process.env.APP_ENCRYPTION_KEY`, `delete require.cache[require.resolve('../crypto')]`, encrypt,
then restore the env + bust the cache again. Always restore in a `finally`.
