---
name: v2-branch-contract-trio
description: v2 multi-branch API contract trio (schemas.js / serializers.js / types.ts) gate findings — branch_count + status-shape divergences the untyped JS server hid from tsc
metadata:
  type: project
---

# v2 multi-branch contract-trio gate (2026-06-15)

## RE-GATE (2026-06-15, post-fix): VERDICT PASS — all 3 divergences resolved, no regression
- DIV-1 RESOLVED: `accounts.js` adds `withBranchCount()` (line 53) on ALL 4 account responses (list 92 via `db.countBranchesByAccount()` single grouped query; get-one 105; create 138; update 177 via `listBranches({accountId}).length`). `db.countBranchesByAccount` (db.js:252) returns a Map<account_id,count>; route defaults absent → 0. types.ts:81 required field always has a runtime value. AccountsScreen.tsx:108-110 no longer renders "undefined branches".
- DIV-2 RESOLVED: `StatusBranchSummary` (types.ts:291) keys EXACTLY match status.js 114-124 (8 keys: id/name/is_default/enabled/actions_today/last_status/last_detail/last_cycle_at); `StatusAccountSummary` (types.ts:308) EXACTLY matches status.js 129-139 (7 keys incl. last_status/branch_count/branches[]). StatusVocab (types.ts:283) == ROLLUP_SEVERITY + NEVER_RUN_STATUS. test/branches.test.js:619-626 asserts the per-branch key allowlist via deepStrictEqual.
- DIV-3 RESOLVED: branches.js:249 set-default returns `serializeBranchWithChildren(row, readChildren(id))` → matches {branch: BranchWithChildren}. test 404-410 asserts content arrays present.
- Validation: `cd web && npx tsc --noEmit` → exit 0; `node --test test/branches.test.js` → 22/22 pass (exit 0).
- No regression on previously-MATCHED items.



Gate reviewed the three-file contract: `server/schemas.js` (zod write contract), `server/serializers.js` (allowlist read contract), `web/src/api/types.ts` (TS mirror). Server is plain JS (no shared type source), so `tsc` green on web proves only TS-internal consistency, NOT that runtime JSON matches the types. The divergences live exactly in that gap.

Verdict: CONDITIONAL. Two real divergences (one HIGH runtime bug, one HIGH structural-but-currently-masked), the rest of the trio MATCHED field-for-field.

**Why:** server (elite-engineer) and web (frontend-platform-engineer) built in parallel against a doc; each made an assumption about the other.

**How to apply:** when reviewing this trio in future, the load-bearing checks are (1) does serializeAccount emit branch_count, (2) does GET /api/status account summary match StatusResponse.accounts (StatusAccountSummary). Both were OUT of sync at gate time.

## DIV-1 (HIGH, runtime undefined): branch_count missing from account LIST serializer
- `types.ts:81` declares `Account.branch_count: number` (required), consumed at `AccountsScreen.tsx:108-110` (`acct.branch_count > 0` → badge tone + text).
- `serializers.js:29-42` ACCOUNT_PUBLIC_FIELDS does NOT include branch_count; `serializeAccount` (51-64) never adds it. `db.listAccounts` (db.js:105-109) is `SELECT * FROM accounts` — no COUNT over branches.
- Runtime: every account renders "undefined branches" with warn tone. Fix is a one-liner in the LIST route (`accounts.js:71-77`): enrich each row with `branch_count: db.listBranches({accountId: row.id}).length` before serialize, OR add a COUNT subquery to listAccounts + add 'branch_count' to the allowlist. NOTE: branch_count is required (not optional) in the TS type, so the type also assumes it on GET-one and create/update account responses — those routes (`accounts.js` get/create/patch) ALSO don't emit it. Either enrich everywhere or make it optional + list-only.

## DIV-2 (HIGH structural, currently masked by `any`-ish access): /api/status account summary shape
- `types.ts:277-292`: StatusResponse.accounts is StatusAccountSummary[] = {id, name, enabled, actions_today}. worker = {desired_state, reported_status, last_heartbeat}.
- `status.js:127-150` actually emits per-account: {id, name, enabled, actions_today, last_status, branch_count, branches[]} — i.e. SUPERSET (extra last_status/branch_count/branches the TS type omits). The worker block MATCHES.
- This is forward-compatible (extra fields ignored by consumers OverviewScreen/ActivityScreen which only read id/name/enabled/actions_today). Severity HIGH only because the rich per-branch drill-down (last_status, branches[]) the server deliberately built has NO TS type → client can't consume it without an `as`/`any`. Classify MEDIUM if you consider "extra server fields" benign; the BUILT-BUT-UNTYPED drill-down is the real gap. There is NO per-branch status TS type at all (no StatusBranchSummary).

## MATCHED (verified clean)
- Envelope shapes: branches list `{branches: Branch[]}` (serializeBranch, no children) ✓; get/create/update `{branch: BranchWithChildren}` ✓; setDefault returns `{branch: serializeBranch(row)}` = Branch WITHOUT children but TS types it BranchWithChildren (minor — see note).
- Branch field-for-field: serializeBranch BRANCH_PUBLIC_FIELDS + BRANCH_BOOLEAN_FIELDS == TS Branch exactly (is_default read-only present in read, absent from write zod + BranchWritable ✓). withChildren adds comments/replies/dm_messages/groups ✓.
- Write contract: createBranchSchema requires name; target_page_url OPTIONAL in zod (`.optional()`, schemas.js:193) but REQUIRED in TS BranchCreateInput (`Pick<...'target_page_url'>`, types.ts:201). Client always sends it so no runtime break, but TS is STRICTER than server. account_id/is_default rejected by `.strict()` ✓ (test-confirmed).
- Account contract: 5 moved branch fields dropped from account schema + serializer + types.ts Account consistently ✓; daily_action_cap remains on account as ceiling ✓.

## setDefault minor (LOW): types.ts BranchResponse.branch is BranchWithChildren but branches.js:246 setDefault returns serializeBranch(row) (NO children). Client `setDefault` (client.ts:132) types return as BranchWithChildren → comments/replies/etc are undefined at runtime. Either serialize with children in the route or give setDefault its own Branch (no-children) return type.
