'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config.json');

const LOG_DIR = path.resolve(config.logDir || 'logs');
const SCREENSHOT_DIR = path.join(LOG_DIR, 'screenshots');

// Create directories at module load
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ─── App-log retention (P5 — prevent unbounded growth on a long-lived VPS) ────
// logger writes one file per calendar day (automation_YYYY-MM-DD.log) via
// appendFileSync, forever. pm2-logrotate only rotates pm2's OWN stdout/stderr
// capture, NOT files an app writes itself — so without this, the logs/ dir grows
// unbounded and eventually fills the disk. We prune our own dated log files older
// than N days. N comes from LOG_RETENTION_DAYS (env, mirrors
// ACTION_LOG_RETENTION_DAYS), defaulting to 30; a non-positive / unparseable
// value falls back to 30 so the sweep can never delete "everything".
//
// WHY BOOT-ONLY (no timer): logger is a LEAF module imported by every entrypoint
// (worker, control-plane, login.js, healthcheck/ops scripts). A setInterval here
// would spawn a sweep timer in every one of those processes — including the
// short-lived CLI tools. Because the log file name rolls by calendar day, a new
// file appears each day on its own; old files only need pruning once per process
// start. So a single best-effort sweep at module load is sufficient and avoids
// leaking a timer into every importer.
const DEFAULT_LOG_RETENTION_DAYS = 30;
// Matches automation_YYYY-MM-DD.log — anchored so it never matches anything else
// in logs/ (e.g. screenshots/, or operator-placed files).
const LOG_FILE_RE = /^automation_(\d{4}-\d{2}-\d{2})\.log$/;

/** Parse LOG_RETENTION_DAYS → positive int, else the 30-day default. */
function logRetentionDays() {
  const n = Number(process.env.LOG_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LOG_RETENTION_DAYS;
}

/**
 * Delete this logger's own dated log files older than `days` days. Best-effort:
 * NEVER throws (logging must never crash its host). Uses the date ENCODED in the
 * filename (not mtime) so a touched/copied file is still judged by its log day.
 * Files that don't match the automation_YYYY-MM-DD.log pattern are left alone.
 *
 * SAFETY: `days` is coerced to a positive int INSIDE the function (mirroring
 * db.trimActionLog) — a non-positive / non-finite value falls back to 30 rather
 * than slipping into the date math. This guards the catastrophic days<=0 case
 * ("delete everything before today"); the default-parameter alone would NOT,
 * since a default only fires for `undefined`, not for an explicit 0 / NaN / -1.
 * @param {number} [days] keep files newer than this many days (default/floor 30)
 * @returns {number} count of files deleted (0 on any error)
 */
function pruneOldLogs(days = logRetentionDays()) {
  let deleted = 0;
  try {
    const n = Number(days);
    const keepDays = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LOG_RETENTION_DAYS;

    // Cutoff = midnight UTC, `keepDays` days ago. A file's encoded date strictly
    // before this cutoff is older than the retention window and is removed.
    const cutoff = new Date();
    cutoff.setUTCHours(0, 0, 0, 0);
    cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);

    const entries = fs.readdirSync(LOG_DIR);
    for (const name of entries) {
      const m = LOG_FILE_RE.exec(name);
      if (!m) continue; // not one of our dated log files — never touch it
      const fileDate = new Date(`${m[1]}T00:00:00.000Z`);
      if (!Number.isFinite(fileDate.getTime())) continue; // unparseable date — skip
      if (fileDate < cutoff) {
        try {
          fs.unlinkSync(path.join(LOG_DIR, name));
          deleted++;
        } catch {
          // ignore a single-file delete error (permissions / race) — keep going
        }
      }
    }
  } catch {
    // readdir or anything else failed — retention is strictly best-effort.
    return deleted;
  }
  return deleted;
}

// Run one retention sweep at module load (best-effort, never throws). See the
// "WHY BOOT-ONLY" note above for why this is a one-shot, not a timer.
pruneOldLogs();

function logFilePath() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `automation_${date}.log`);
}

function formatLine(level, account, category, msg) {
  const ts = new Date().toISOString();
  const acct = account ? `[${account.toUpperCase()}]` : '[SYSTEM]';
  return `[${ts}] ${acct} [${category}] ${msg}`;
}

function append(line) {
  try {
    fs.appendFileSync(logFilePath(), line + '\n', 'utf8');
  } catch {
    // silently ignore file write errors — console output still works
  }
}

function log(account, category, msg) {
  const line = formatLine('INFO', account, category, msg);
  console.log(line);
  append(line);
}

function warn(account, category, msg) {
  const line = formatLine('WARN', account, category, msg);
  console.warn(line);
  append(line);
}

function error(account, category, msg) {
  const line = formatLine('ERROR', account, category, msg);
  console.error(line);
  append(line);
}

function logError(account, category, err) {
  const msg = err && err.stack ? err.stack : (err && err.message ? err.message : String(err));
  const line = formatLine('ERROR', account, category, msg);
  console.error(line);
  append(line);
}

module.exports = {
  log,
  warn,
  error,
  logError,
  LOG_DIR,
  SCREENSHOT_DIR,
  // retention surface (exported for unit testing; pruneOldLogs already ran once
  // at module load — these let a test exercise it deterministically)
  pruneOldLogs,
  logRetentionDays,
};
