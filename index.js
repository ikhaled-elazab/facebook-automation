/**
 * index.js — Multi-Account Facebook Page Monitor Bot (slim entry point).
 *
 * Phase 2: the 1,500-line monolith was decomposed into modules:
 *   core/    — humanize (timing/typing), retry (+vision hook), state (DB-backed)
 *   fb/      — scope, scrape, actions/{like,comment,share,dm}, monitor
 *   worker/  — loadConfig (DB→domain adapter), loop (per-account cycle/runner)
 *
 * This entry now:
 *   1. Loads accounts + global settings FROM THE SQLITE DB (db.js), not from
 *      accounts.json / config.json.
 *   2. Installs process-level crash guards so one account's unhandled rejection
 *      can't silently kill the whole process (a known HIGH).
 *   3. Launches each enabled account in ITS OWN browser instance (worker/loop),
 *      staggered on startup so they don't all hit Facebook at once.
 *
 * Usage: npm start   (requires APP_ENCRYPTION_KEY in .env and a migrated DB)
 */

'use strict';

/* global clearTimeout, setInterval, clearInterval */
// clearTimeout/setInterval/clearInterval are Node globals; declared here because
// the shared eslint config (eslint.config.js, not owned by this module) lists
// setTimeout but not the timer siblings. Same convention as worker/loop.js.

require('dotenv').config();

const logger = require('./logger.js');
const db = require('./db');
const { loadWorkerConfig } = require('./worker/loadConfig.js');
const { runAccount, shutdownAllBrowsers } = require('./worker/loop.js');
const { sleep } = require('./core/humanize.js');

// Hard ceiling on graceful shutdown: even if browser closes hang past
// shutdownAllBrowsers' own per-browser timeout, the process must still exit so
// PM2 (or a control-plane stop) is never blocked. Comfortably above the
// per-browser close timeout (8s) so the graceful path is preferred.
const SHUTDOWN_DEADLINE_MS = 12000;

// ─── Graceful shutdown orchestrator (HIGH-3) ──────────────────────────────────
// The per-account-browser design means N accounts = N chromium process trees.
// PM2 stop/restart and the control-plane both deliver SIGTERM; without a handler
// node is hard-killed mid-cycle and those trees are orphaned → VPS OOM over many
// start/stop cycles. This closes every live browser (best-effort, bounded) then
// exits. Idempotent: concurrent signals / a signal-during-uncaughtException run
// the cleanup exactly once.
let shutdownStarted = false;

async function gracefulShutdown(reason, exitCode) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.log(null, 'SHUTDOWN', `Received ${reason} — closing browsers and exiting (code ${exitCode}).`);

  // Hard safety timer: if cleanup wedges, force-exit anyway. Unref'd so it never
  // keeps the loop alive on its own.
  const forceTimer = setTimeout(() => {
    logger.error(null, 'SHUTDOWN', `Cleanup exceeded ${SHUTDOWN_DEADLINE_MS}ms — forcing exit.`);
    process.exit(exitCode);
  }, SHUTDOWN_DEADLINE_MS);
  if (typeof forceTimer.unref === 'function') forceTimer.unref();

  // Stop the daily retention ticker so it can't fire during/after teardown.
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }

  try {
    await shutdownAllBrowsers();
  } catch (err) {
    logger.logError(null, 'SHUTDOWN', err);
  } finally {
    // Close the DB AFTER browsers so the heartbeat ticker (stopped first inside
    // shutdownAllBrowsers) can't write after close. This flushes the WAL and
    // releases the SQLite handle cleanly. Best-effort — never block exit on it.
    try {
      db.closeDb();
    } catch (err) {
      logger.logError(null, 'SHUTDOWN', err);
    }
    clearTimeout(forceTimer);
    process.exit(exitCode);
  }
}

// ─── Process-level crash guards (reliability — was a known HIGH) ───────────────
// unhandledRejection: log loudly and KEEP the process alive. One account's stray
// rejection must NOT take down every other account's loop. (Unchanged policy.)
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.logError(null, 'UNHANDLED_REJECTION', err);
});

// uncaughtException: per Node docs the process is now in an undefined state.
// Running on is unsafe (a corrupted zombie). We log, run the browser-cleanup
// path so chromium trees aren't orphaned (HIGH-3), then exit(1) so PM2 / the
// control-plane restarts the WHOLE process cleanly — all accounts resume from DB
// state on the fresh start. (Policy change: was log-and-continue.)
process.on('uncaughtException', (err) => {
  logger.logError(null, 'UNCAUGHT_EXCEPTION', err);
  void gracefulShutdown('uncaughtException', 1);
});

// SIGTERM (PM2 stop/restart, control-plane stop) + SIGINT (Ctrl-C): clean exit
// after closing all browsers so no chromium processes are orphaned (HIGH-3).
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM', 0));
process.on('SIGINT', () => void gracefulShutdown('SIGINT', 0));

// ─── action_log retention (P5 — prevent unbounded growth) ─────────────────────
// The action_log grows by every action across every account, forever; left
// unbounded it bloats the DB file and slowly degrades the governor's daily-cap
// index scans. We trim rows older than N days on boot, then once/day. N comes
// from ACTION_LOG_RETENTION_DAYS (env, worker-owned config — keeps this off the
// settings serializer the control-plane UI owns), defaulting to 30. A
// non-positive / unparseable value falls back to 30 inside db.trimActionLog,
// which can never delete "everything" (the catastrophic days<=0 case is guarded).
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
let retentionTimer = null;

/** Parse ACTION_LOG_RETENTION_DAYS → positive int, else 30. */
function retentionDays() {
  const n = Number(process.env.ACTION_LOG_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

/** Trim the action_log once, logging the outcome. Best-effort: never throws. */
function runRetentionOnce() {
  try {
    const days = retentionDays();
    const removed = db.trimActionLog(days);
    logger.log(null, 'RETENTION', `Trimmed ${removed} action_log row(s) older than ${days}d.`);
  } catch (err) {
    logger.logError(null, 'RETENTION', err);
  }
}

/**
 * Start the retention job: trim immediately on boot, then daily. The interval is
 * unref'd so it never keeps the event loop alive on its own (mirrors the
 * heartbeat ticker). Idempotent — a second call is a no-op.
 * @returns {NodeJS.Timeout|null}
 */
function startRetention() {
  runRetentionOnce(); // boot trim
  if (retentionTimer) return null;
  retentionTimer = setInterval(runRetentionOnce, RETENTION_INTERVAL_MS);
  if (retentionTimer && typeof retentionTimer.unref === 'function') retentionTimer.unref();
  return retentionTimer;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { accounts, settings } = loadWorkerConfig();

  if (!accounts.length) {
    logger.log(null, 'BOOT', 'No enabled accounts found in the database. Run `npm run migrate` first, or enable an account.');
    process.exit(1);
  }

  const staggerMs = Number(settings.account_stagger_ms) || 45000;

  logger.log(null, 'BOOT', `Loaded ${accounts.length} account(s): ${accounts.map((a) => a.name).join(', ')}`);
  logger.log(null, 'BOOT', `Stagger between accounts: ${staggerMs / 1000}s`);

  // Start the action_log retention job (boot trim + daily). Before launching
  // accounts so the trim runs even if account launch later stalls on stagger.
  startRetention();

  // Launch each account with a staggered delay so they don't all start at once.
  // Each runAccount owns its OWN browser (per-account isolation) and loops
  // forever — fire-and-forget; a rejection is caught and logged, never fatal.
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];

    if (i > 0) {
      logger.log(null, 'BOOT', `Waiting ${staggerMs / 1000}s before starting ${account.name}...`);
      await sleep(staggerMs);
    }

    runAccount(account, settings).catch((err) => {
      logger.logError(account.name, 'BOOT', err);
    });
  }

  logger.log(null, 'BOOT', 'All accounts launched. Bot is running.');
}

// Auto-run only when invoked directly (node index.js / pm2). When required by a
// test, expose the retention primitives for unit testing WITHOUT launching
// browsers or calling process.exit at import time.
if (require.main === module) {
  main().catch((err) => {
    logger.logError(null, 'FATAL', err);
    process.exit(1);
  });
}

module.exports = { startRetention, runRetentionOnce, retentionDays };
