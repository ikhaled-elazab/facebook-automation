---
name: v2-branch-audit
description: deep-qa Phase 4 quality audit of v2 multi-branch + DB-driven-login — verdict, the contract-drift class found, and the cap-tier test hole
metadata:
  type: project
---

Phase 4 quality audit (2026-06-15) of the v2 multi-branch (account=envelope / branch=workload) + DB-driven-login work. Verdict: CONDITIONAL PASS — architecture is clean and consistent across all layers; two HIGH contract/test gaps must close before live.

**Why this matters (architecture facts that hold for future audits):**
- The `.id` meaning-shift is the load-bearing contract: after `worker/loadConfig.hydrateBranch`, the hydrated object's `.id` IS the branch id (state/content/governor/logging key); the account id rides separately as `accountId` (login/session). `core/state.js`, `fb/monitor.js`, `worker/loop.js` all read `.id` and correctly resolve the branch. login is account-level everywhere (login-flow.js / login.js / login-control.js read account.name + sessionFile only). No account-keyed state bleed found.
- Three-tier cap precedence (branch→account→global) is implemented consistently: db.js has `countBranchActionsToday` (idx_action_log_branch_day) + `countActionsToday` (acct/global, idx_action_log_acct_day / idx_action_log_created). The per-account sum-across-branches works because `logAction` resolves the owning account_id from branchId (db.js ~line 506) so EVERY row carries both keys. governor.js consults all three tiers cheapest-first, fail-closed via safeCount.

**The HIGH finding class — output VO contract drift across producers/consumers (recurring, watch for it):**
- `db.recentActions` SELECTs `branch_id` (db.js ~line 661) and db.js docblock promises a `branchId` feed filter for per-branch UI drill-down, BUT: (a) `ActionLogEvent` in web/src/api/types.ts (~line 328) OMITS `branch_id`; (b) `recentActionsQuerySchema` (server/schemas.js ~line 296) + status.js /events accept only account_id, never branch_id. The producer (db.js) is ahead of the type contract + the route. This is the Producer/Consumer drift pattern — the DTO grew a field one consumer reads but the type mirror and the query schema didn't. A grep of `branch_id` across db.js↔types.ts↔schemas.js catches it in seconds.

**The test hole (HIGH):**
- governor.test.js NEVER injects `countBranchActionsToday` — the entire per-BRANCH cap tier (governor.js 188-200, the headline v2 feature) is untested. Tests pass `dailyActionCap` but the deny fires via `countActionsToday` (account tier), so branch-vs-account-vs-global precedence with THREE DISTINCT counts is never proven. migration-v2.test.js + branches.test.js + login.test.js are otherwise excellent (real DB, rollback proof, exact hydrateBranch key-set assertion, fail-closed coverage).
