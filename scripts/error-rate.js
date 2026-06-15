#!/usr/bin/env node
'use strict';

/* global AbortController, fetch, clearTimeout, setTimeout */
// Node 18+ globals. Declared here for the same reason as scripts/healthcheck.js:
// the shared eslint config (eslint.config.js) does not list them. The webhook path
// degrades gracefully if `fetch` is unavailable (older Node) — exit code is primary.

/**
 * scripts/error-rate.js — out-of-band action-failure / ban-signal probe for one VPS.
 *
 * WHY THIS EXISTS (obs #2 — failures are invisible until you read the DB)
 *   scripts/healthcheck.js answers "is the worker ALIVE?" (heartbeat freshness).
 *   It does NOT answer "is the worker WORKING?" — a worker can beat happily while
 *   every Facebook action it attempts FAILS (selector drift, soft-block, expired
 *   session) or, worse, while Facebook is actively flagging the account
 *   (checkpoint / temporary ban). This probe reads action_log directly (read-only,
 *   no control-plane dependency) and turns two distinct danger signals into a
 *   non-zero exit + optional alert:
 *
 *     1. HIGH ERROR RATE — failed/(ok+failed) over the window exceeds a threshold,
 *        with a minimum attempt count so a single unlucky failure never pages.
 *        This is "investigate soon" — likely selector drift or a flaky session.
 *
 *     2. BAN SIGNAL — ANY action_log row with status='blocked' in the window.
 *        'blocked' is the worker's marker for a Facebook checkpoint / ban / soft-
 *        block response. This pages IMMEDIATELY regardless of rate: one blocked
 *        row means Facebook noticed us, and continuing risks a hard ban. This is
 *        the highest-value signal in the whole observability surface.
 *
 * STATUS VOCABULARY (must match what the worker writes to action_log.status):
 *     'ok'      verified success
 *     'failed'  attempted and failed
 *     'skipped' governor-blocked / no-op (NOT a failure — excluded from the rate)
 *     'blocked' Facebook checkpoint / ban signal (the page-now trigger)
 *   Error rate = failed / (ok + failed). 'skipped' is deliberately excluded: a
 *   paced/capped no-op is healthy, not an error, and must never inflate the rate.
 *
 * EXIT CODES (designed for cron / uptime-kuma / monit / a bare `&&` chain)
 *   0  HEALTHY      — error rate under threshold (or below the min-sample floor)
 *                     AND no 'blocked' rows in the window.
 *   1  UNHEALTHY    — error rate over threshold OR a 'blocked' row appeared. THE
 *                     PAGE. A 'blocked' row makes this critical (ban risk).
 *   2  PROBE ERROR  — could not read the DB at all (misconfig / corrupt file).
 *                     "unknown" — investigate, but distinct from a confirmed problem.
 *
 * TUNABLES (env-overridable)
 *   ERROR_RATE_WINDOW_MIN     window size in minutes              (default 30)
 *   ERROR_RATE_THRESHOLD      fraction 0..1 that trips at-or-above (default 0.70)
 *   ERROR_RATE_MIN_ATTEMPTS   min (ok+failed) before rate applies  (default 5)
 *   ERROR_RATE_WEBHOOK_URL    optional alert webhook (Slack/Discord/generic)
 *   ERROR_RATE_WEBHOOK_TIMEOUT_MS  bounded POST timeout            (default 5000)
 *   DB_PATH                   the SQLite file (else ./db/fb-bot.db, like db.js)
 *
 * USAGE
 *   node scripts/error-rate.js            # exit code only (cron-friendly)
 *   node scripts/error-rate.js --json     # machine-readable result on stdout
 *   node scripts/error-rate.js --quiet    # suppress the human stderr line
 *   npm run probe:errors                  # same as the bare invocation
 *
 * CRON EXAMPLE (every 5 min; see docs/RUNBOOK.md §11 for the real line)
 *   star/5 * * * * cd /opt/fb-automation && /usr/bin/node scripts/error-rate.js \
 *       >> logs/error-rate.log 2>&1 || true
 */

require('dotenv').config();

const path = require('path');

// ── Tunables (env-overridable; defaults are conservative — page rarely, page true) ─

const WINDOW_MIN = positiveIntEnv('ERROR_RATE_WINDOW_MIN', 30);
const THRESHOLD = fractionEnv('ERROR_RATE_THRESHOLD', 0.7);
const MIN_ATTEMPTS = positiveIntEnv('ERROR_RATE_MIN_ATTEMPTS', 5);
const WEBHOOK_URL = (process.env.ERROR_RATE_WEBHOOK_URL || '').trim();
const WEBHOOK_TIMEOUT_MS = positiveIntEnv('ERROR_RATE_WEBHOOK_TIMEOUT_MS', 5000);

const FLAGS = new Set(process.argv.slice(2));
const AS_JSON = FLAGS.has('--json');
const QUIET = FLAGS.has('--quiet');

// ── Result model ────────────────────────────────────────────────────────────────

const VERDICT = Object.freeze({ HEALTHY: 0, UNHEALTHY: 1, PROBE_ERROR: 2 });

/**
 * Pure verdict from window counts — no side effects, trivially unit-testable.
 * The DB read (countsInWindow) is kept separate so this can be tested with plain
 * objects. 'blocked' is evaluated FIRST because it is the most severe signal.
 *
 * @param {{ok:number, failed:number, skipped:number, blocked:number}} counts
 * @param {{threshold?:number, minAttempts?:number, windowMin?:number}} [opts]
 * @returns {{code:number, verdict:string, reason:string, window_min:number,
 *   ok:number, failed:number, skipped:number, blocked:number,
 *   attempts:number, error_rate:number|null, threshold:number, min_attempts:number,
 *   ban_signal:boolean}}
 */
function evaluate(counts, opts = {}) {
  const threshold = opts.threshold === undefined ? THRESHOLD : opts.threshold;
  const minAttempts = opts.minAttempts === undefined ? MIN_ATTEMPTS : opts.minAttempts;
  const windowMin = opts.windowMin === undefined ? WINDOW_MIN : opts.windowMin;

  const ok = nonNegInt(counts.ok);
  const failed = nonNegInt(counts.failed);
  const skipped = nonNegInt(counts.skipped);
  const blocked = nonNegInt(counts.blocked);

  const attempts = ok + failed; // skipped is NOT an attempt; blocked is its own axis.
  const errorRate = attempts > 0 ? failed / attempts : null;
  const banSignal = blocked > 0;

  const base = {
    window_min: windowMin,
    ok,
    failed,
    skipped,
    blocked,
    attempts,
    error_rate: errorRate,
    threshold,
    min_attempts: minAttempts,
    ban_signal: banSignal,
  };

  // 1) BAN SIGNAL — highest severity, pages regardless of rate or sample size.
  if (banSignal) {
    return {
      code: VERDICT.UNHEALTHY,
      verdict: 'unhealthy',
      reason:
        `BAN SIGNAL: ${blocked} 'blocked' row(s) in the last ${windowMin}m — ` +
        `Facebook checkpoint/ban detected. STOP the worker and investigate before ` +
        `it escalates to a hard ban.`,
      ...base,
    };
  }

  // 2) Below the minimum sample floor — not enough attempts to judge a rate.
  if (attempts < minAttempts) {
    return {
      code: VERDICT.HEALTHY,
      verdict: 'healthy',
      reason:
        `only ${attempts} attempt(s) in ${windowMin}m (< ${minAttempts}); ` +
        `not enough to judge an error rate — treated as healthy`,
      ...base,
    };
  }

  // 3) Error rate at-or-above the threshold.
  if (errorRate >= threshold) {
    return {
      code: VERDICT.UNHEALTHY,
      verdict: 'unhealthy',
      reason:
        `error rate ${pct(errorRate)} >= ${pct(threshold)} over ${windowMin}m ` +
        `(${failed} failed / ${attempts} attempted) — investigate (selector drift, ` +
        `soft-block, expired session?)`,
      ...base,
    };
  }

  // 4) Healthy.
  return {
    code: VERDICT.HEALTHY,
    verdict: 'healthy',
    reason: `error rate ${pct(errorRate)} < ${pct(threshold)} over ${windowMin}m (${failed}/${attempts}); no ban signal`,
    ...base,
  };
}

// ── DB read (read-only; no dependency on the control plane being up) ──────────────

/**
 * Count action_log rows by status within the last `windowMin` minutes. Read-only,
 * opened directly (NOT via db.js getDb(), which seeds singleton rows — a write).
 *
 * The cutoff is `datetime('now', '-N minutes')` with N bound to a fixed integer
 * (built into the SQL fragment from a sanitized integer, never user input), so
 * `created_at` stays BARE in the predicate and the query uses the
 * idx_action_log_created index range scan rather than a full table scan.
 *
 * @param {number} windowMin
 * @returns {{ok:number, failed:number, skipped:number, blocked:number}}
 */
function countsInWindow(windowMin) {
  const dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'fb-bot.db');
  const Database = require('better-sqlite3');
  const conn = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    conn.pragma('busy_timeout = 3000');
    // windowMin is a sanitized positive integer (positiveIntEnv / caller-validated);
    // it is the number of minutes only, so embedding it keeps created_at sargable.
    const minutes = Math.max(1, Math.trunc(windowMin));
    const rows = conn
      .prepare(
        `SELECT status, COUNT(*) AS n
           FROM action_log
          WHERE created_at >= datetime('now', '-${minutes} minutes')
          GROUP BY status`
      )
      .all();
    const counts = { ok: 0, failed: 0, skipped: 0, blocked: 0 };
    for (const r of rows) {
      // Only the four known statuses count; any unexpected status is ignored
      // (forward-compatible — a new status can't crash the probe), but its absence
      // from the rate is intentional: we only judge what we understand.
      if (Object.prototype.hasOwnProperty.call(counts, r.status)) {
        counts[r.status] = r.n;
      }
    }
    return counts;
  } finally {
    conn.close();
  }
}

// ── Optional alert webhook (best-effort, bounded, never alters exit code) ─────────

async function fireWebhook(result) {
  if (!WEBHOOK_URL) return;
  const payload = JSON.stringify({
    text:
      `[fb-automation] action error probe UNHEALTHY` +
      (result.ban_signal ? ' (BAN SIGNAL)' : '') +
      `: ${result.reason}`,
    host: require('os').hostname(),
    verdict: result.verdict,
    ban_signal: result.ban_signal,
    error_rate: result.error_rate,
    ok: result.ok,
    failed: result.failed,
    skipped: result.skipped,
    blocked: result.blocked,
    window_min: result.window_min,
    at: new Date().toISOString(),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    if (typeof fetch !== 'function') return; // very old Node — exit code is primary.
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal,
    });
  } catch (err) {
    if (!QUIET) {
      process.stderr.write(`[error-rate] webhook POST failed (ignored): ${err.message}\n`);
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

/** Parse a fraction in (0,1]; out-of-range / non-numeric falls back. */
function fractionEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function pct(frac) {
  if (frac === null || frac === undefined) return 'n/a';
  return `${(frac * 100).toFixed(0)}%`;
}

function emit(result) {
  if (AS_JSON) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (!QUIET) {
    process.stderr.write(
      `[error-rate] ${result.verdict.toUpperCase()}: ${result.reason}\n`
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────--

async function main() {
  let result;
  try {
    const counts = countsInWindow(WINDOW_MIN);
    result = evaluate(counts);
  } catch (err) {
    result = {
      code: VERDICT.PROBE_ERROR,
      verdict: 'probe_error',
      reason: `could not read action_log: ${err.message}`,
      window_min: WINDOW_MIN,
      ok: null,
      failed: null,
      skipped: null,
      blocked: null,
      attempts: null,
      error_rate: null,
      threshold: THRESHOLD,
      min_attempts: MIN_ATTEMPTS,
      ban_signal: null,
    };
  }

  emit(result);

  // Alert only on a CONFIRMED unhealthy verdict (not probe_error, which is
  // "unknown" and must not spam alerts on a transient FS/migration hiccup).
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

module.exports = { evaluate, countsInWindow, VERDICT };
