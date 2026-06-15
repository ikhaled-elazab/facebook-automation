'use strict';

/**
 * server/routes/status.js — dashboard observability reads.
 *
 *   GET /api/status         -> high-level health: worker_state + today's action
 *                              counts + recent-event count (for the UI header)
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
 *          before (cursor = next_before from the prior page; fetch strictly-older).
 *   Polling for NEW rows: re-request page 1 (omit `before`); compare the top id.
 *   Paging OLDER rows:    pass before=next_before until has_more is false.
 *
 * All reads; no mutations; behind requireAuth. The feed accessor (db.recentActions)
 * lives in db.js, the single data-access layer.
 *
 * PER-ACCOUNT STATUS (obs #3 — surface the account_status masking-fix):
 *   worker_state is a SINGLE global row, so when N accounts each write their
 *   per-cycle status to it, one account's 'error' is instantly overwritten by
 *   another's 'running' and a failing account becomes invisible. db.js fixed this
 *   with the per-account `account_status` table (one row per account), but until
 *   now NO route exposed it — so the operator could not SEE a single account
 *   failing. We join db.listAccountStatuses() onto each accounts[] entry so the
 *   dashboard surfaces per-account last_status/last_detail/last_cycle_at.
 *
 *   STATUS VOCABULARY (account_status.status): idle | running | ok | error |
 *   paused. last_cycle_at is the timestamp of the last COMPLETED cycle (bumped
 *   only on ok|error), null until the account has finished a cycle once.
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
 * Build a lookup from account_id -> safe per-account status projection.
 * One db.listAccountStatuses() read; O(rows) to index, O(1) per-account join.
 * Accounts that have never run have no account_status row → the join yields the
 * "never run yet" defaults below.
 * @returns {Map<number, {last_status:string, last_detail:string|null, last_cycle_at:string|null}>}
 */
function buildStatusIndex() {
  const index = new Map();
  for (const row of db.listAccountStatuses()) {
    index.set(row.account_id, {
      last_status: row.status,
      last_detail: row.detail === undefined ? null : row.detail,
      last_cycle_at: row.last_cycle_at === undefined ? null : row.last_cycle_at,
    });
  }
  return index;
}

/** Defaults for an account that has never written an account_status row. */
const NEVER_RUN_STATUS = Object.freeze({
  last_status: 'idle',
  last_detail: null,
  last_cycle_at: null,
});

/**
 * @returns {import('express').Router}
 */
function statusRouter() {
  const router = express.Router();

  // Aggregate health snapshot for the dashboard header.
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const ws = db.getWorkerState();
      const accounts = db.listAccounts();
      const statusIndex = buildStatusIndex();
      const perAccount = accounts.map((a) => {
        const st = statusIndex.get(a.id) || NEVER_RUN_STATUS;
        return {
          id: a.id,
          name: a.name,
          enabled: !!a.enabled,
          actions_today: db.countActionsToday(a.id),
          // Per-account observability (obs #3) — see header. Projected explicitly.
          last_status: st.last_status,
          last_detail: st.last_detail,
          last_cycle_at: st.last_cycle_at,
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
      const { limit, account_id, before } = parseOrThrow(recentActionsQuerySchema, req.query);
      const page = db.recentActions({
        limit: limit || 50,
        accountId: account_id,
        before,
      });
      // page === { events, total, has_more, next_before }
      res.json(page);
    })
  );

  return router;
}

module.exports = { statusRouter };
