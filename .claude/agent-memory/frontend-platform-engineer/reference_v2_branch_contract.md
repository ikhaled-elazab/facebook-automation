---
name: v2-branch-contract
description: v2 multi-branch API contract as mirrored into web/src/api/types.ts — branch shape, account-envelope split, and the inferred fields to confirm against elite-engineer's serializer
metadata:
  type: reference
---

v2 multi-branch split the old single-target Account into Account ENVELOPE + N Branches. The web `types.ts` mirror was built against the documented contract while elite-engineer's `server/serializers.js` + `server/schemas.js` were still mid-flight (no `branch` refs in `server/` at build time). These are the assumptions the typescript-expert gate must reconcile against the real serializer.

**Account (after v2)** — envelope only: `id, name, email, session_file, user_agent, locale, timezone_id, proxy_server, proxy_username, daily_action_cap (CEILING, nullable), enabled, created_at, updated_at, has_password, has_proxy_password, branch_count`. REMOVED from Account: `target_page_url, own_profile_url, dm_as_page_url, send_dm_to_commenters, check_interval_minutes` + child arrays (all moved to Branch). `AccountWithChildren` type was deleted — account no longer carries children.

**Branch** — `id, account_id, name, is_default, target_page_url, own_profile_url, dm_as_page_url, daily_action_cap (per-branch, nullable), check_interval_minutes, created_at, updated_at, send_dm_to_commenters, enabled` + child arrays `comments[]/replies[]/dm_messages[]/groups[]` on `BranchWithChildren`.

**RECONCILED at ts-expert gate (2026-06-15):** the trio passed; the ONLY web-side fix was modeling the per-branch GET /api/status superset (see below). `Account.branch_count` (item 1) confirmed: elite-engineer is adding it to the account routes in parallel — it stays REQUIRED in types.ts, satisfied at runtime, and `AccountsScreen` reading `branch_count > 0` is safe.

**INFERRED — confirm against server before merge (file:line web/src/api/types.ts):**
1. `Account.branch_count` on the LIST projection — UI badge depends on it. Serializer must add it to the accounts list shape. [CONFIRMED by ts-expert — elite-engineer adding in parallel.]
2. Branch nested route shape: list returns `{branches: Branch[]}` (no children), get/create/update/setDefault return `{branch: BranchWithChildren}`. Delete returns `{ok, id}`.
3. Route paths (web/src/api/client.ts `api.branches`): `/api/accounts/:id/branches`, `.../branches/:bid`, `.../branches/:bid/default` (POST set-default, server enforces exactly-one).
4. `is_default` is read-only from the client (set only via the /default endpoint) — NOT in `BranchWritable`.
5. `BranchCreateInput` requires `name + target_page_url`; `AccountCreateInput` now requires only `name + email + session_file` (target_page_url no longer an account field).

**Server invariants the UI assumes (BranchManager.tsx):** account has ≥1 branch; exactly one default; cannot delete the last branch or the current default (UI blocks + messages, but relies on server enforcing too). If the server AUTO-SEEDS a default branch on account create, the create-account flow still works (UI handles 0-branch and ≥1-branch empty states). If it does NOT auto-seed, the post-create edit screen shows the "add first branch" empty state.

**GET /api/status is per-branch (Phase 2).** server/routes/status.js emits a SUPERSET now modeled in types.ts: per-account `{id,name,enabled,actions_today,last_status,branch_count,branches[]}` and per-branch `{id,name,is_default,enabled,actions_today,last_status,last_detail,last_cycle_at}`. Status vocabulary = `StatusVocab = 'idle'|'running'|'ok'|'error'|'paused'` (mirrors ROLLUP_SEVERITY worst-wins: error>running>ok>paused>idle; account `last_status` is the rollup, `actions_today` is the branch sum, `last_cycle_at` bumps only on ok|error). A per-branch drill-down dashboard panel is now buildable from `StatusAccountSummary.branches[]` — none built yet (only consumer is ActivityScreen's id/name filter dropdown, which is non-breaking since it never constructs the type).
