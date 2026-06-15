---
name: session-2026-06-15-pre-brief
description: Pre-session audit and brief for 2026-06-15 multi-branch feature FULL_POWER session
metadata:
  type: project
---

# Session 2026-06-15 Pre-Session Audit

## Session Goal
Add multi-branch support to facebook-automation: one account (login/session) can operate multiple independent branches (trading, real estate, etc.), each fully isolated with its own target_page_url, groups, comments, replies, dm_messages, own_profile_url, dm_as_page_url, check_interval_minutes, last_post_id, seen_comments, dm_sent, daily_action_cap.

## Team State
- Trust ledger: ALL agents at 0.9 default trust, zero verdict history — trust ledger is statistically clean but informationally empty (no earned trust signals yet).
- Signal bus: EMPTY (0 unprocessed entries in memory-handoffs.md and evolution-signals.md). Pattern F not yet needed.
- Session-sentinel memory: FIRST SESSION (no prior audit baseline).
- CTO memory: ACTIVE — has project context (locked decisions, P1-P5 plan, HARD CONSTRAINT: no git commits).
- Elite-engineer memory: RICHEST — 6 project memories covering P1-P5 implementation detail.
- Deep-reviewer memory: 5 security review files (P1-P5 all reviewed).
- Database-expert memory: 1 file (P1 schema review). Frontend-platform-engineer: 2 files.

## Trust Ledger Empty-Streak
This is the FIRST session sentinel has run. No consecutive-session streak baseline exists. Trust ledger shows 0 verdicts across ALL agents — zero evidence-validator dispatch history. This is not a streak violation from prior sessions; it is a team with rich project memory but no audit history.

## Schema Readiness for Branch Feature
Current schema (db/schema.sql) stores branch-specific fields directly on `accounts` table:
- target_page_url, own_profile_url, dm_as_page_url (to move to branches)
- check_interval_minutes, daily_action_cap (to move to branches)
- child tables keyed by account_id: account_comments, account_replies, account_dm_messages, account_groups
- state tables keyed by account_id: account_state (last_post_id), seen_comments, dm_sent

The branch feature requires:
1. New `account_branches` table
2. Re-keying child tables to branch_id
3. Re-keying seen_comments/dm_sent to branch_id
4. Data migration: existing account1 row → default branch (live data, lossless required)
5. ACL fix in worker/loadConfig.js (hydrates account_id keys → must shift to branch_id)

## Risk Register
1. CRITICAL: Live data migration of account1 into default branch — must be lossless, idempotent, tested
2. HIGH: seen_comments / dm_sent must re-parent to branch_id without losing history
3. HIGH: fb/ selector code is fragile (ACL regression) — loadConfig.js is the isolation layer; branch iteration must not break it
4. HIGH: server/serializers.js + server/schemas.js + api/types.ts are a 3-file contract; all must move in sync
5. MEDIUM: frontend AccountEditorScreen.tsx needs branch tab/list UI — no dedicated JS/React expert on roster

## Session Health Score (prior session)
N/A — first sentinel audit.

**Why:** This is first-run sentinel.
**How to apply:** Use this as baseline for future session trending.
