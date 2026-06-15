---
name: v2-multibranch-cap-hierarchy
description: v2 multi-branch schema — three-tier daily-action-cap hierarchy (branch/account/global) design rationale, action_log.branch_id FK semantics decision
metadata:
  type: project
---

v2 multi-branch refactor adds a `branches` table (1:N off accounts) and re-keys 8 tables account_id->branch_id. Late product decision (approved 2026-06-15) added a THREE-TIER daily-action-cap hierarchy because all branches share ONE Facebook login/session and FB bans the LOGIN, not the logical branch — so the account is the real ban target.

**Why:** The shared-login ban-target framing is the load-bearing constraint. Future cap/governor work must respect that the ACCOUNT is the primary safety budget, branches are sub-allocations.

**How to apply:** Any future change to caps or the governor must preserve the "most-restrictive-non-NULL-cap-binds, check all three counts" invariant below.

## Cap hierarchy (design, NOT yet migrated — design-only as of 2026-06-15)
- per-BRANCH:  `branches.daily_action_cap` (NEW column, NULL=inherit account ceiling)
- per-ACCOUNT: `accounts.daily_action_cap` (RETAINED + re-purposed as the ACCOUNT CEILING — sums actions across ALL the account's branches; NULL=inherit global). NOTE: this column was originally on the "drop" list in the first delta; the per-account-ceiling decision RETAINED it.
- global:      `settings.global_daily_action_cap` (unchanged; 0 = unlimited, must special-case)

## Migration column-move (revised): DROP 5 off accounts, NOT 6
Dropped (move to branches): target_page_url, own_profile_url, send_dm_to_commenters, dm_as_page_url, check_interval_minutes. RETAINED: daily_action_cap (now the account ceiling).

## account1 cap-seed decision (ban-safety justified)
Keep account ceiling = existing accounts.daily_action_cap value (no UPDATE, left in place); seed default-branch daily_action_cap = NULL (inherit). Rationale: copying into BOTH would silently DOUBLE the effective budget the moment a 2nd branch is added (per-branch cap stops being binding); NULL=inherit means the account ceiling binds from day one and the tighter cap always wins (fail-safe). Single-branch behavior is byte-identical to today.

## Governor invariant (the rule)
Action allowed ONLY if it passes ALL THREE non-NULL caps (most restrictive binds). Three independent COUNT-vs-cap checks: per-branch (WHERE branch_id=?), per-account summing across branches (WHERE account_id=?), global (no entity predicate). The per-account count is what actually enforces the shared-login ceiling. Check account ceiling first for short-circuit (typical binding cap on a busy login).

## action_log.branch_id FK semantics — FINALIZED as ON DELETE CASCADE
DDL: `ALTER TABLE action_log ADD COLUMN branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE;`
Reason: account_id is ALREADY ON DELETE CASCADE (schema.sql:152) — account deletion already wipes action history. The original SET-NULL proposal for branch_id was internally inconsistent (can't preserve a row through branch-delete that account-delete cascades out anyway). CASCADE both ways = consistent: a row's lifetime is bounded by both its account and branch. Audit-window durability is the retention job's (trimActionLog) responsibility, NOT the FK's. Option (b) (flip both to SET NULL) was scoped OUT as scope-creep on a working FK; if audit-through-deletion ever becomes a hard req, do it as a separate immutable action_archive table (append-only-ledger pattern), not by softening live-table FKs.

## Indexes for the three governor queries
- (A) per-branch: NEW `idx_action_log_branch_day ON action_log(branch_id, created_at)` — mirrors acct_day shape.
- (B) per-account: existing `idx_action_log_acct_day` (schema.sql:159).
- (C) global: existing `idx_action_log_created` (schema.sql:164).
All three use the half-open UTC day-bound technique (bare created_at, no date() wrapper) for sargability — see [[p1-sqlite-schema-review]] P5 section.

## Carried-forward caller bug (NOT data layer — for elite-engineer)
The status='ok' count filter is only honest if the writer is honest. Prior P5 review found worker logs 'ok' unconditionally (worker/loop.js:265, fb/monitor.js:307,332) -> counts ATTEMPTS not SUCCESSES. With THREE caps layered, this over-restriction compounds. Gating 'ok' on real success is a PREREQUISITE for the three-tier governor to count truthfully.
