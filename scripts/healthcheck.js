#!/usr/bin/env node
'use strict';

/* global AbortController, fetch, clearTimeout, setTimeout */
// These are Node 18+ globals. They are declared here because the shared eslint
// config (eslint.config.js, not owned by this script) does not list them — the
// same convention used by index.js and worker/loop.js for clearTimeout/setInterval.
// `fetch`/`AbortController` are used only by the optional webhook path; on a Node
// older than 18 the script degrades gracefully (the webhook is skipped).

/**
 * scripts/healthcheck.js — out-of-band worker liveness probe for a single VPS.
 *
 * WHY THIS EXISTS
 *   pm2 keeps the worker PROCESS alive (restart policy in pm2.config.js). But a
 *   process can be "up" per pm2 while the worker is silently wedged — a hung
 *   browser, a stuck cycle, a deadlock — emitting no heartbeats. pm2 can't see
 *   that; only the heartbeat freshness can. This script is the cron/uptime probe
 *   that turns a stale heartbeat into a non-zero exit (and an optional alert),
 *   complementing — not duplicating — pm2's process supervision.
 *
 * WHAT IT CHECKS  (mirrors server/routes/worker.js exactly, on purpose)
 *   It reads the single worker_state row (id=1) straight from SQLite — NOT over
 *   HTTP — so it has no dependency on the control plane being up, and works even
 *   if the operator only tunnels in occasionally.
 *
 *   The alert condition is the SAME invariant the control plane uses:
 *
 *       INTENT is running (desired_state === 'running')
 *         AND the heartbeat is stale (age > HEARTBEAT_STALE_MS, default 90s)
 *
 *   Stale-while-stopped is NORMAL (the operator deliberately stopped the worker;
 *   an old heartbeat is expected) and must NEVER alert — otherwise cron pages at
 *   3am for a no-op. This "intent vs mechanism" split is the control plane's core
 *   model (server/worker-control.js:15-20).
 *
 *   The staleness threshold (90s) and the UTC timestamp parse are kept identical
 *   to server/routes/worker.js (HEARTBEAT_STALE_MS = 90_000; SQLite datetime('now')
 *   is UTC-without-Z, so we append 'Z' before Date.parse). Keeping them in lockstep
 *   means cron and the UI agree on "stale".
 *
 * EXIT CODES  (designed for cron / uptime-kuma / monit / a bare `&&` chain)
 *   0  healthy            — desired=stopped (nothing expected), OR desired=running
 *                           with a fresh heartbeat.
 *   1  UNHEALTHY          — desired=running but heartbeat stale or missing, OR the
 *                           worker last reported status 'error'. THIS is the page.
 *   2  probe error        — could not read the DB at all (misconfig / corrupt file).
 *                           Treat as "unknown", investigate, but distinct from a
 *                           confirmed-dead worker.
 *
 * USAGE
 *   node scripts/healthcheck.js            # exit code only (cron-friendly)
 *   node scripts/healthcheck.js --json     # machine-readable status on stdout
 *   node scripts/healthcheck.js --quiet    # suppress human stderr line
 *   npm run healthcheck                    # same as the bare invocation
 *
 * CRON EXAMPLE (every 2 min; logs + optional webhook handled inline)
 *   star/2 * * * * cd /opt/fb-automation && /usr/bin/node scripts/healthcheck.js \
 *       >> logs/healthcheck.log 2>&1 || true
 *   (replace 'star' with the literal asterisk; see docs/RUNBOOK.md for the real line)
 *
 * OPTIONAL ALERT WEBHOOK
 *   Set HEALTHCHECK_WEBHOOK_URL in .env to a Slack/Discord/generic incoming-webhook
 *   URL. On an UNHEALTHY result the script POSTs a small JSON payload before
 *   exiting non-zero. The POST is best-effort and bounded (HEALTHCHECK_WEBHOOK_TIMEOUT_MS,
 *   default 5s) — a webhook outage never changes the exit code or hangs cron.
 */

require('dotenv').config();

const path = require('path');

// ── Tunables (env-overridable; defaults match the control plane) ──────────────

/** Heartbeat older than this (ms) is stale. MUST match server/routes/worker.js. */
const HEARTBEAT_STALE_MS = positiveIntEnv('HEALTHCHECK_STALE_MS', 90 * 1000);
const WEBHOOK_URL = (process.env.HEALTHCHECK_WEBHOOK_URL || '').trim();
const WEBHOOK_TIMEOUT_MS = positiveIntEnv('HEALTHCHECK_WEBHOOK_TIMEOUT_MS', 5000);

const FLAGS = new Set(process.argv.slice(2));
const AS_JSON = FLAGS.has('--json');
const QUIET = FLAGS.has('--quiet');

// ── Result model ──────────────────────────────────────────────────────────────

const VERDICT = Object.freeze({ HEALTHY: 0, UNHEALTHY: 1, PROBE_ERROR: 2 });

/**
 * Pure verdict computation from a worker_state row — extracted so it is trivially
 * testable and has no side effects. Returns { code, healthy, reason, ...detail }.
 * @param {Record<string, unknown>|undefined} ws  worker_state row (id=1) or undefined
 * @param {number} [now=Date.now()]
 */
function evaluate(ws, now = Date.now()) {
  if (!ws) {
    return {
      code: VERDICT.PROBE_ERROR,
      verdict: 'probe_error',
      reason: 'worker_state row (id=1) not found — DB not migrated?',
      desired_state: null,
      reported_status: null,
      last_heartbeat: null,
      age_ms: null,
      stale: null,
    };
  }

  const desired = String(ws.desired_state || 'stopped');
  const status = String(ws.status || 'unknown');
  const { lastHeartbeat, ageMs, stale } = heartbeatHealth(ws, now);

  // Intent = stopped → nothing is expected to be beating. Always healthy.
  if (desired !== 'running') {
    return {
      code: VERDICT.HEALTHY,
      verdict: 'healthy',
      reason: `worker intentionally ${desired}; no liveness expected`,
      desired_state: desired,
      reported_status: status,
      last_heartbeat: lastHeartbeat,
      age_ms: ageMs,
      stale,
    };
  }

  // Intent = running. A stale/missing heartbeat is the page.
  if (lastHeartbeat === null) {
    return unhealthy(
      'desired=running but worker has NEVER beaten (no last_heartbeat)',
      desired,
      status,
      lastHeartbeat,
      ageMs,
      stale
    );
  }
  if (stale) {
    return unhealthy(
      `desired=running but heartbeat is STALE (age ${fmtMs(ageMs)} > ${fmtMs(HEARTBEAT_STALE_MS)})`,
      desired,
      status,
      lastHeartbeat,
      ageMs,
      stale
    );
  }
  // Heartbeat fresh, but the worker self-reported an error on its last cycle.
  if (status === 'error') {
    return unhealthy(
      'desired=running, heartbeat fresh, but worker last reported status=error',
      desired,
      status,
      lastHeartbeat,
      ageMs,
      stale
    );
  }

  return {
    code: VERDICT.HEALTHY,
    verdict: 'healthy',
    reason: `worker running; heartbeat fresh (age ${fmtMs(ageMs)})`,
    desired_state: desired,
    reported_status: status,
    last_heartbeat: lastHeartbeat,
    age_ms: ageMs,
    stale,
  };
}

function unhealthy(reason, desired, status, lastHeartbeat, ageMs, stale) {
  return {
    code: VERDICT.UNHEALTHY,
    verdict: 'unhealthy',
    reason,
    desired_state: desired,
    reported_status: status,
    last_heartbeat: lastHeartbeat,
    age_ms: ageMs,
    stale,
  };
}

/**
 * Compute heartbeat freshness — byte-for-byte the same logic as
 * server/routes/worker.js heartbeatHealth(), so cron and the UI agree.
 */
function heartbeatHealth(ws, now) {
  const last = ws.last_heartbeat;
  if (!last) return { lastHeartbeat: null, ageMs: null, stale: null };
  // SQLite datetime('now') is UTC without a 'Z'; parse as UTC explicitly.
  const ts = Date.parse(String(last).replace(' ', 'T') + 'Z');
  if (Number.isNaN(ts)) return { lastHeartbeat: String(last), ageMs: null, stale: null };
  const ageMs = now - ts;
  return { lastHeartbeat: String(last), ageMs, stale: ageMs > HEARTBEAT_STALE_MS };
}

// ── DB read (no dependency on the control plane being up) ─────────────────────

/**
 * Read the worker_state row directly, read-only. We deliberately do NOT call
 * db.getDb() from the app's db.js because that applies the schema and seeds
 * singleton rows (a write) — a health probe must never mutate. We open the same
 * file read-only and SELECT.
 * @returns {Record<string, unknown>|undefined}
 */
function readWorkerState() {
  // Resolve the DB path the same way db.js does: DB_PATH env, else ./db/fb-bot.db
  // relative to the PROJECT ROOT (this file lives in scripts/, root is one up).
  const dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'fb-bot.db');

  const Database = require('better-sqlite3');
  // readonly + fileMustExist: a missing/un-migrated DB throws → PROBE_ERROR, which
  // is the honest signal ("can't tell"), not a false "worker dead".
  const conn = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    conn.pragma('busy_timeout = 3000');
    return conn.prepare('SELECT * FROM worker_state WHERE id = 1').get();
  } finally {
    conn.close();
  }
}

// ── Optional alert webhook (best-effort, bounded, never alters exit code) ─────

async function fireWebhook(result) {
  if (!WEBHOOK_URL) return;
  const payload = JSON.stringify({
    text: `[fb-automation] worker UNHEALTHY: ${result.reason}`,
    host: require('os').hostname(),
    verdict: result.verdict,
    desired_state: result.desired_state,
    reported_status: result.reported_status,
    last_heartbeat: result.last_heartbeat,
    age_ms: result.age_ms,
    at: new Date().toISOString(),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    // Node 18+ global fetch. If unavailable (very old Node), skip silently — the
    // exit code is the primary signal; the webhook is a convenience.
    if (typeof fetch !== 'function') return;
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal,
    });
  } catch (err) {
    // A webhook failure is logged but NEVER changes the verdict/exit code.
    if (!QUIET) {
      process.stderr.write(`[healthcheck] webhook POST failed (ignored): ${err.message}\n`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function emit(result) {
  if (AS_JSON) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (!QUIET) {
    const label = result.verdict.toUpperCase();
    process.stderr.write(
      `[healthcheck] ${label}: ${result.reason} (desired=${result.desired_state}, ` +
        `status=${result.reported_status}, age=${fmtMs(result.age_ms)})\n`
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  let result;
  try {
    const ws = readWorkerState();
    result = evaluate(ws);
  } catch (err) {
    result = {
      code: VERDICT.PROBE_ERROR,
      verdict: 'probe_error',
      reason: `could not read worker_state: ${err.message}`,
      desired_state: null,
      reported_status: null,
      last_heartbeat: null,
      age_ms: null,
      stale: null,
    };
  }

  emit(result);

  // Fire the optional alert only on a CONFIRMED unhealthy worker (not probe_error,
  // which is "unknown" and shouldn't spam alerts on a transient FS/migration issue).
  if (result.code === VERDICT.UNHEALTHY) {
    await fireWebhook(result);
  }

  process.exit(result.code);
}

// Run only when invoked directly so the pure `evaluate` can be unit-tested by
// requiring this module without triggering a DB read / process.exit.
if (require.main === module) {
  void main();
}

module.exports = { evaluate, heartbeatHealth, VERDICT, HEARTBEAT_STALE_MS };
