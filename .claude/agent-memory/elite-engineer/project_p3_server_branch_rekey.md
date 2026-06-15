---
name: project-p3-server-rekey
description: Phase 3 server half — re-key Express/better-sqlite3 server layer to v2 multi-branch + branch CRUD; mounting/precedence gotcha, contract trio ownership, pre-existing v1 test drift
metadata:
  type: project
---

Phase 3 (server half) re-keyed `server/` from v1 (account-owned monitoring) to v2 (account=login envelope, branch=monitoring unit, 1:N). Done 2026-06-15.

**The atomic contract trio** (must stay in sync): `server/schemas.js` + `server/serializers.js` + `web/src/api/types.ts`. elite-engineer owns the two server files + DEFINES the canonical shape; frontend mirrors types.ts. Branch payload is snake_case at the API boundary (matches account convention). typescript-expert gates the trio as a unit. Do NOT edit web/src/* from the server side.

**Two contract refinements from typescript-expert's trio gate (applied 2026-06-15):**
1. **`Account.branch_count` is REQUIRED** in types.ts — so the server emits it on ALL FOUR account responses (list, get-one, create, update) in `server/routes/accounts.js` via a `withBranchCount(serialized, count)` helper, NEVER undefined. It is a DERIVED field, not a column. The LIST route uses `db.countBranchesByAccount()` (one GROUP BY query → Map<acctId,count>, accounts with 0 branches absent → default 0) to stay O(1) queries; single-account routes use `db.listBranches({accountId}).length`. The serializer (serializeAccount) does NOT emit branch_count — the route enriches it (keeps serializer schema-pure).
2. **`POST /branches/:id/default` returns `BranchWithChildren`** (was bare branch). All branch ITEM endpoints (GET/POST-create/PATCH/POST-default) return `serializeBranchWithChildren` so the `{branch: BranchWithChildren}` envelope is uniform; only the LIST + collection use bare `serializeBranch` (no arrays).

**Branch route mounting gotcha (load-bearing):** `branchesRouter` owns BOTH `/accounts/:accountId/branches` (collection) and `/branches/:id[/default]` (item) — so it is mounted at `app.use('/api', branchesRouter(...))`, AFTER `accountsRouter` at `/api/accounts`. Express `/:id` matches ONE segment, so `/api/accounts/5/branches` does NOT match account `/:id` and falls through to the branches router. Order matters: accountsRouter first preserves account `/:id` precedence.

**Writable-column discipline (db.js is authoritative):** branch writable set = db.js `BRANCH_UPDATE_COLUMNS` exactly (name, target_page_url, own_profile_url, send_dm_to_commenters, dm_as_page_url, check_interval_minutes, daily_action_cap, enabled). `account_id` (set from create URL) and `is_default` (flips only via `setDefaultBranch`/POST /branches/:id/default) are NEVER client-writable — excluded from the schema AND the column-key set (defense in depth atop `.strict()`). Account writable set lost the 5 moved fields; `daily_action_cap` STAYS as the account ceiling.

**Guard surfacing:** `db.deleteBranch` THROWS on the default branch (message contains "default branch"); route catches and maps to a clean 409 ConflictError, never a 500. Same pattern for UNIQUE(account_id, name) → 409 (name is unique per account, not globally).

**Status re-key:** `db.listAccountStatuses`/`getAccountState`/`setAccountStatus` are GONE. account_status is branch-keyed → use `db.listBranchStatuses()` + `db.setBranchStatus()`. GET /api/status now groups per-branch status under each account with a worst-case rollup (severity: error>running>ok>paused>idle) so a failing branch is never masked. Per-account `actions_today` = `db.countActionsToday(acctId)` (sums branches); per-branch = `db.countBranchActionsToday(branchId)`.

**Pre-existing v1 test drift (Phase 4 territory):** `test/server.test.js` STILL uses the v1 API — it calls the removed `db.setAccountStatus` (line ~489) and posts v1 account fields (target_page_url/comments/groups). It will FAIL under v2. This is expected drift, NOT a regression from this work. New v2 coverage lives in `test/branches.test.js` (21 tests, all pass). test-engineer should re-key server.test.js in Phase 4.

**Test harness pattern (reuse for any server route test):** temp DB via `process.env.DB_PATH` set BEFORE requiring app code; real `http.Server` on port 0; cookie-aware client; CSRF flow = GET /api/auth/csrf → csrf_token → x-csrf-token header on mutations; fake workerControl injected via createApp opts. node:test built-in runner. See test/branches.test.js top-of-file for the canonical copy.
