'use strict';

/**
 * test/logger.test.js — regression tests for the P5 app-log retention added to
 * logger.js (pruneOldLogs / logRetentionDays).
 *
 * THE GAP: logger writes one automation_YYYY-MM-DD.log per day via appendFileSync
 * with NO retention; pm2-logrotate does NOT cover app-written files, so logs/
 * grew unbounded on a long-lived VPS. The fix prunes the logger's OWN dated files
 * older than LOG_RETENTION_DAYS (default 30) on boot, best-effort.
 *
 * These tests exercise pruneOldLogs against the REAL LOG_DIR but ONLY create and
 * assert on clearly-synthetic fixture files (a far-future date + an ancient date)
 * so they never delete a genuine operational log. Each test removes its own
 * fixtures in a finally so a failure can't leave litter behind.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const logger = require('../logger.js');
const { pruneOldLogs, logRetentionDays, LOG_DIR } = logger;

/** Build the dated log filename pattern the logger uses. */
function logName(dateStr) {
  return `automation_${dateStr}.log`;
}

/** Write a fixture log file and return its absolute path. */
function writeFixture(dateStr) {
  const p = path.join(LOG_DIR, logName(dateStr));
  fs.writeFileSync(p, 'fixture\n', 'utf8');
  return p;
}

/** Best-effort unlink (cleanup). */
function rm(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

// ── logRetentionDays env parsing ──────────────────────────────────────────────

test('logRetentionDays defaults to 30 and coerces bad/non-positive values to 30', () => {
  const prev = process.env.LOG_RETENTION_DAYS;
  try {
    delete process.env.LOG_RETENTION_DAYS;
    assert.strictEqual(logRetentionDays(), 30, 'unset → 30');

    process.env.LOG_RETENTION_DAYS = '7';
    assert.strictEqual(logRetentionDays(), 7, 'positive int honored');

    process.env.LOG_RETENTION_DAYS = '0';
    assert.strictEqual(logRetentionDays(), 30, 'zero → 30 (never prune everything)');

    process.env.LOG_RETENTION_DAYS = '-5';
    assert.strictEqual(logRetentionDays(), 30, 'negative → 30');

    process.env.LOG_RETENTION_DAYS = 'garbage';
    assert.strictEqual(logRetentionDays(), 30, 'unparseable → 30');

    process.env.LOG_RETENTION_DAYS = '10.9';
    assert.strictEqual(logRetentionDays(), 10, 'fractional floored');
  } finally {
    if (prev === undefined) delete process.env.LOG_RETENTION_DAYS;
    else process.env.LOG_RETENTION_DAYS = prev;
  }
});

// ── pruneOldLogs deletes old, keeps recent ────────────────────────────────────

test('pruneOldLogs deletes a log older than the window and KEEPS a recent one', () => {
  // Ancient (definitely older than 30d) and "today" fixtures. Use unique dates
  // unlikely to collide with real logs; the today file proves recent files survive.
  const ancient = writeFixture('2000-01-02');
  const today = writeFixture(new Date().toISOString().slice(0, 10));
  try {
    assert.ok(fs.existsSync(ancient), 'precondition: ancient fixture exists');
    assert.ok(fs.existsSync(today), 'precondition: today fixture exists');

    pruneOldLogs(30);

    assert.strictEqual(fs.existsSync(ancient), false, 'a >30d-old log is pruned');
    assert.strictEqual(fs.existsSync(today), true, "today's log is kept");
  } finally {
    rm(ancient);
    rm(today);
  }
});

test('pruneOldLogs respects a custom (small) retention window', () => {
  // A file dated 3 days ago must survive days=7 but be pruned by days=1.
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 3);
  const threeDaysAgo = writeFixture(d.toISOString().slice(0, 10));
  try {
    pruneOldLogs(7);
    assert.strictEqual(fs.existsSync(threeDaysAgo), true, '3d-old survives a 7d window');

    pruneOldLogs(1);
    assert.strictEqual(fs.existsSync(threeDaysAgo), false, '3d-old is pruned by a 1d window');
  } finally {
    rm(threeDaysAgo);
  }
});

test('pruneOldLogs NEVER touches non-matching files (e.g. operator notes, screenshots dir)', () => {
  // A file that does not match automation_YYYY-MM-DD.log must be left alone even
  // if it is ancient by mtime — retention is filename-encoded-date scoped.
  const stray = path.join(LOG_DIR, 'NOTES_keep_me.txt');
  const wrongShape = path.join(LOG_DIR, 'automation_not-a-date.log');
  fs.writeFileSync(stray, 'do not delete\n', 'utf8');
  fs.writeFileSync(wrongShape, 'malformed name\n', 'utf8');
  try {
    pruneOldLogs(1);
    assert.strictEqual(fs.existsSync(stray), true, 'a non-log file is never pruned');
    assert.strictEqual(fs.existsSync(wrongShape), true, 'a malformed-name file is never pruned');
  } finally {
    rm(stray);
    rm(wrongShape);
  }
});

test('pruneOldLogs is best-effort: it never throws even on a bad LOG_DIR state', () => {
  // Calling with absurd args must not throw (logging must never crash its host).
  assert.doesNotThrow(() => pruneOldLogs(0));
  assert.doesNotThrow(() => pruneOldLogs(NaN));
  assert.doesNotThrow(() => pruneOldLogs(undefined));
});
