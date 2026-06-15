'use strict';

/**
 * server/routes/worker.js — worker supervision (start/stop/status).
 *
 *   POST /api/worker/start  -> set desired_state=running, then pm2 start/restart
 *   POST /api/worker/stop   -> set desired_state=stopped, then pm2 stop
 *   GET  /api/worker/status -> combined view: DB desired/actual + heartbeat age + pm2
 *
 * DESIRED vs ACTUAL (reconciliation model):
 *   - The DB worker_state.desired_state is the durable source of truth for INTENT.
 *     We write it FIRST so intent survives even if the pm2 mechanism call fails or
 *     the control plane restarts mid-operation.
 *   - pm2 is the MECHANISM. If pm2 fails we surface the failure but the recorded
 *     intent is already correct, so a later reconcile / retry can converge.
 *   - The worker writes worker_state.status + last_heartbeat (db.heartbeat()).
 *     /status reports heartbeat freshness so the UI can detect a silently-dead
 *     worker (intent=running, but heartbeat stale).
 */

const express = require('express');
const { asyncHandler } = require('./helpers');
const db = require('../../db');
const defaultWorkerControl = require('../worker-control');
const { ServiceUnavailableError } = require('../errors');

/** Heartbeat older than this (ms) is considered stale when desired=running. */
const HEARTBEAT_STALE_MS = 90 * 1000;

/**
 * Compute heartbeat freshness from the worker_state row.
 * @param {Record<string, unknown>} ws worker_state row
 * @returns {{lastHeartbeat:string|null, ageMs:number|null, stale:boolean|null}}
 */
function heartbeatHealth(ws) {
  const last = ws.last_heartbeat;
  if (!last) return { lastHeartbeat: null, ageMs: null, stale: null };
  // SQLite datetime('now') is UTC without a 'Z'; parse as UTC explicitly.
  const ts = Date.parse(String(last).replace(' ', 'T') + 'Z');
  if (Number.isNaN(ts)) return { lastHeartbeat: String(last), ageMs: null, stale: null };
  const ageMs = Date.now() - ts;
  return { lastHeartbeat: String(last), ageMs, stale: ageMs > HEARTBEAT_STALE_MS };
}

/**
 * Build the CANONICAL worker-status shape — the single representation of "what
 * is the worker's state right now". GET /status returns this verbatim; POST
 * /start and /stop return this same shape (optionally with an extra idempotency
 * `action` field) so the UI parses worker status ONE way regardless of endpoint.
 *
 * Shape: { desired_state, reported_status, detail, heartbeat, process, updated_at }
 *   - desired_state   : durable INTENT from the DB (source of truth).
 *   - reported_status : what the worker process last wrote (db.heartbeat()).
 *   - heartbeat       : freshness {lastHeartbeat, ageMs, stale}.
 *   - process         : what pm2 observes (or {present:false,...} if unreachable).
 *
 * @param {object} workerControl injected pm2-backed control module
 * @param {Readonly<object>} workerCfg the frozen config.worker sub-object
 * @returns {Promise<Record<string, unknown>>}
 */
async function buildWorkerStatus(workerControl, workerCfg) {
  const ws = db.getWorkerState();
  const hb = heartbeatHealth(ws);

  let pm2View;
  try {
    pm2View = await workerControl.status(workerCfg);
  } catch {
    // pm2 daemon unreachable — report DB view only, flag the pm2 problem
    // generically (the real error is logged server-side, never sent to client).
    pm2View = { present: false, status: 'unknown', error: 'pm2 status unavailable' };
  }

  return {
    desired_state: ws.desired_state,
    reported_status: ws.status, // what the worker last wrote
    detail: ws.detail || null,
    heartbeat: hb,
    process: pm2View, // what pm2 observes
    updated_at: ws.updated_at,
  };
}

/**
 * @param {{config: Readonly<object>, csrfProtection: import('express').RequestHandler, workerControl?: object, logger?: {error:Function, warn:Function}}} deps
 *   workerControl is injectable (defaults to the real pm2-backed module) so tests
 *   can substitute a fake and never drive a live pm2 daemon. logger is used for
 *   server-side-only logging of mechanism failures (never sent to the client).
 * @returns {import('express').Router}
 */
function workerRouter({
  config,
  csrfProtection,
  workerControl = defaultWorkerControl,
  logger = console,
}) {
  const router = express.Router();

  // POST /start, /stop return the UNIFIED worker-status shape (same as GET
  // /status) so the UI builds the status component once. The idempotency `action`
  // field is layered ON TOP of that shape as an extra:
  //   action ∈ { 'started', 'restarted', 'stopped', 'noop' }
  //     - started   : worker was not running and was launched.
  //     - restarted : worker was already known to pm2 and was restarted.
  //     - stopped   : a running worker was stopped.
  //     - noop      : stop requested but the worker was already absent/stopped.
  // The UI may rely on `action` for a transient toast; the canonical state to
  // render is the rest of the shape (desired_state/reported_status/heartbeat/...).

  router.post(
    '/start',
    csrfProtection,
    asyncHandler(async (_req, res) => {
      // 1) Record intent FIRST (durable source of truth).
      db.setDesiredState('running');
      // 2) Drive the mechanism.
      let result;
      try {
        result = await workerControl.start(config.worker);
      } catch (err) {
        // Intent is recorded; report the mechanism failure as 503 (retryable).
        // Log the real pm2 error server-side only; the client gets a generic reason.
        logger.error('[control-plane] worker start failed:', err && err.stack ? err.stack : err);
        throw new ServiceUnavailableError('Failed to start worker process', {
          reason: 'worker process manager unavailable',
        });
      }
      // 3) Return the UNIFIED status shape + the idempotency action.
      const status = await buildWorkerStatus(workerControl, config.worker);
      res.json({ ok: true, action: result.action, ...status });
    })
  );

  router.post(
    '/stop',
    csrfProtection,
    asyncHandler(async (_req, res) => {
      db.setDesiredState('stopped');
      let result;
      try {
        result = await workerControl.stop(config.worker);
      } catch (err) {
        logger.error('[control-plane] worker stop failed:', err && err.stack ? err.stack : err);
        throw new ServiceUnavailableError('Failed to stop worker process', {
          reason: 'worker process manager unavailable',
        });
      }
      const status = await buildWorkerStatus(workerControl, config.worker);
      res.json({ ok: true, action: result.action, ...status });
    })
  );

  // Status is a read — no CSRF, no mutation. Returns the canonical status shape.
  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const status = await buildWorkerStatus(workerControl, config.worker);
      res.json(status);
    })
  );

  return router;
}

module.exports = { workerRouter };
