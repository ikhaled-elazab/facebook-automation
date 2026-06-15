'use strict';

/**
 * server/routes/status.js — dashboard observability reads.
 *
 *   GET /api/status         -> high-level health: worker_state + per-account
 *                              rollup + per-branch cycle status (for the UI header
 *                              + the per-branch drill-down)
 *   GET /api/status/events  -> recent action_log rows (newest first), the feed
 *
 * FEED / POLLING CONTRACT (GET /events):
 *   Response: { events, total, has_more, next_before }
 *     - events     : up to `limit` rows, newest first (DESC by id).
 *     - total      : size of the whole feed under the current account_id filter
 *                    (NOT just this page) — for an "N events" counter.
 *     - has_more   : true when older rows exist beyond this page.
 *     - next_before : the cursor to fetch the next (older) page, or null at the end.
 *   Query: limit (1..500, default 50), account_id (optional filter),
 *          branch_id (optional per-branch filter, for the per-branch drill-down),
 *          before (cursor = next_before from the prior page; fetch strictly-older).
 *   Polling for NEW rows: re-request page 1 (omit `before`); compare the top id.
 *   Paging OLDER rows:    pass before=next_before until has_more is false.
 *
 * All reads; no mutations; behind requireAuth. The feed accessor (db.recentActions)
 * lives in db.js, the single data-access layer.
 *
 * PER-BRANCH STATUS (Phase 2 — re-keyed from per-account):
 *   worker_state is a SINGLE global row, so when N monitoring units each write
 *   their per-cycle status to it, one unit's 'error' is instantly overwritten by
 *   another's 'running' and a failing unit becomes invisible. db.js fixed this
 *   with the per-BRANCH `account_status` table (one row per branch). We join
 *   db.listBranchStatuses() onto each branch, then group branches under their
 *   owning account and compute an account-level rollup so the dashboard can show
 *   both the account summary AND the per-branch breakdown.
 *
 *   STATUS VOCABULARY (account_status.status): idle | running | ok | error |
 *   paused. last_cycle_at is the timestamp of the last COMPLETED cycle (bumped
 *   only on ok|error), null until the branch has finished a cycle once.
 *
 *   Allowlist discipline (mirrors serializers.js): account_status holds NO
 *   secrets, but we still project an EXPLICIT field subset onto the payload —
 *   never a `{...row}` passthrough — so a future account_status column cannot
 *   silently appear in the API.
 */

const express = require('express');
const { asyncHandler, parseOrThrow } = require('./helpers');
const db = require('../../db');
const { recentActionsQuerySchema } = require('../schemas');

/**
 * Build a lookup from branch_id -> safe per-branch status projection.
 * One db.listBranchStatuses() read; O(rows) to index, O(1) per-branch join.
 * Branches that have never run have no account_status row → the join yields the
 * "never run yet" defaults below.
 * @returns {Map<number, {last_status:string, last_detail:string|null, last_cycle_at:string|null}>}
 */
function buildStatusIndex() {
  const index = new Map();
  for (const row of db.listBranchStatuses()) {
    index.set(row.branch_id, {
      last_status: row.status,
      last_detail: row.detail === undefined ? null : row.detail,
      last_cycle_at: row.last_cycle_at === undefined ? null : row.last_cycle_at,
    });
  }
  return index;
}

/** Defaults for a branch that has never written an account_status row. */
const NEVER_RUN_STATUS = Object.freeze({
  last_status: 'idle',
  last_detail: null,
  last_cycle_at: null,
});

/**
 * Roll a set of per-branch statuses up to a single account-level status. Severity
 * order (worst wins) so a single failing branch is never hidden behind a healthy
 * sibling — the same masking concern the per-branch table solves, applied to the
 * account summary. 'error' dominates, then 'running', then 'ok', then 'paused',
 * then 'idle'. An account with zero branches is 'idle'.
 * @param {Array<{last_status:string}>} branchStatuses
 * @returns {string}
 */
const ROLLUP_SEVERITY = Object.freeze(['error', 'running', 'ok', 'paused', 'idle']);
function rollupStatus(branchStatuses) {
  if (branchStatuses.length === 0) return 'idle';
  for (const status of ROLLUP_SEVERITY) {
    if (branchStatuses.some((b) => b.last_status === status)) return status;
  }
  return 'idle';
}

/**
 * @returns {import('express').Router}
 */
function statusRouter() {
  const router = express.Router();

  // Aggregate health snapshot for the dashboard header + per-branch drill-down.
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const ws = db.getWorkerState();
      const accounts = db.listAccounts();
      const allBranches = db.listBranches(); // ordered by (account_id, id)
      const statusIndex = buildStatusIndex();

      // Index branches by their owning account for an O(branches) grouping.
      const branchesByAccount = new Map();
      for (const b of allBranches) {
        if (!branchesByAccount.has(b.account_id)) branchesByAccount.set(b.account_id, []);
        const st = statusIndex.get(b.id) || NEVER_RUN_STATUS;
        branchesByAccount.get(b.account_id).push({
          id: b.id,
          name: b.name,
          is_default: !!b.is_default,
          enabled: !!b.enabled,
          actions_today: db.countBranchActionsToday(b.id),
          // Per-branch observability — projected explicitly (allowlist).
          last_status: st.last_status,
          last_detail: st.last_detail,
          last_cycle_at: st.last_cycle_at,
        });
      }

      const perAccount = accounts.map((a) => {
        const branches = branchesByAccount.get(a.id) || [];
        return {
          id: a.id,
          name: a.name,
          enabled: !!a.enabled,
          // Account-level rollup: sum of branch actions (matches the per-account
          // ceiling basis) + worst-case branch status so a failing branch surfaces.
          actions_today: db.countActionsToday(a.id),
          last_status: rollupStatus(branches),
          branch_count: branches.length,
          branches,
        };
      });

      res.json({
        worker: {
          desired_state: ws.desired_state,
          reported_status: ws.status,
          last_heartbeat: ws.last_heartbeat || null,
        },
        accounts: perAccount,
        account_count: accounts.length,
      });
    })
  );

  // Recent action_log feed (paginated — see the FEED / POLLING CONTRACT above).
  router.get(
    '/events',
    asyncHandler(async (req, res) => {
      const { limit, account_id, branch_id, before } = parseOrThrow(
        recentActionsQuerySchema,
        req.query
      );
      const page = db.recentActions({
        limit: limit || 50,
        accountId: account_id,
        branchId: branch_id,
        before,
      });
      // page === { events, total, has_more, next_before }
      res.json(page);
    })
  );

  return router;
}

module.exports = { statusRouter };
