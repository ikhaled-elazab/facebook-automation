'use strict';

/**
 * test/retention.test.js — P5 db substrate: sargable daily-cap counting,
 * action_log retention trimming, and per-account status (the single-row
 * heartbeat last-writer-wins fix).
 *
 * Uses a throwaway temp SQLite (same pattern as db.test.js) so every assertion
 * runs against the REAL schema + real SQL — a broken index or a wrong date
 * window fails the test rather than a mock hiding it.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbret-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');

const db = require('../db');

let acctA;
let acctB;
let branchA;
let branchB;

before(() => {
  db.getDb();
  // v2: an account is the login envelope; per-target fields moved to branches.
  // countActionsToday is the per-account ceiling tier (keyed by account_id), so the
  // cap tests below use the account ids. account_status is now per-BRANCH (keyed by
  // branch_id), so the status tests use a default branch per account.
  acctA = db.insertAccount({ name: 'retA', email: 'a@x.com', session_file: 's' });
  acctB = db.insertAccount({ name: 'retB', email: 'b@x.com', session_file: 's2' });
  branchA = db.insertBranch({ account_id: acctA, name: 'default', is_default: 1, target_page_url: 'u' });
  branchB = db.insertBranch({ account_id: acctB, name: 'default', is_default: 1, target_page_url: 'u2' });
});

after(() => {
  db.closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── countActionsToday: per-account, global, status filter ─────────────────────

test('countActionsToday counts only status=ok, per-account and globally', () => {
  db.logAction({ accountId: acctA, actionType: 'like', status: 'ok' });
  db.logAction({ accountId: acctA, actionType: 'comment', status: 'ok' });
  db.logAction({ accountId: acctA, actionType: 'share', status: 'skipped' }); // skipped: excluded
  db.logAction({ accountId: acctA, actionType: 'dm', status: 'failed' }); // failed: excluded
  db.logAction({ accountId: acctB, actionType: 'like', status: 'ok' });

  assert.strictEqual(db.countActionsToday(acctA), 2, 'A: 2 ok (skipped + failed excluded)');
  assert.strictEqual(db.countActionsToday(acctB), 1, 'B: 1 ok');
  assert.strictEqual(db.countActionsToday(), 3, 'global no-arg: 3 ok across all accounts');
  assert.strictEqual(db.countActionsToday(null), 3, 'global null: same as no-arg');
});

test('countActionsToday ignores rows from a previous day (local-day window)', () => {
  // Insert an old row directly (created_at well in the past). It must NOT count
  // toward today, proving the window excludes prior days.
  db.getDb()
    .prepare(
      `INSERT INTO action_log (account_id, action_type, status, created_at)
       VALUES (?, 'like', 'ok', datetime('now','-3 days'))`
    )
    .run(acctA);
  assert.strictEqual(db.countActionsToday(acctA), 2, 'a 3-day-old ok row is not counted as today');
});

test('countActionsToday queries are SARGABLE (index range scan, not full scan)', () => {
  const conn = db.getDb();
  const lo = `datetime('now','localtime','start of day','utc')`;
  const hi = `datetime('now','localtime','start of day','+1 day','utc')`;
  // Mirror the exact predicates db.countActionsToday builds, then EXPLAIN them.
  const globalPlan = conn
    .prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM action_log WHERE status='ok' AND created_at >= ${lo} AND created_at < ${hi}`)
    .all()
    .map((r) => r.detail)
    .join(' | ');
  const acctPlan = conn
    .prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM action_log WHERE account_id=1 AND status='ok' AND created_at >= ${lo} AND created_at < ${hi}`)
    .all()
    .map((r) => r.detail)
    .join(' | ');

  assert.match(globalPlan, /USING INDEX idx_action_log_created/, 'global path uses created_at index');
  assert.doesNotMatch(globalPlan, /SCAN action_log(?! USING)/, 'global path is not a full table scan');
  assert.match(acctPlan, /USING INDEX idx_action_log_acct_day/, 'per-account path uses composite index');
});

// ── trimActionLog: retention + the catastrophic days<=0 guard ─────────────────

test('trimActionLog removes only rows older than N days', () => {
  // State entering this test: a 3-day-old row (seeded earlier) + today's rows.
  // Seed an additional clearly-old row (10 days). A 7-day window must trim the
  // 10-day row but KEEP the 3-day row and all of today's — proving the cutoff is
  // precise (older-than-N, not "everything but today").
  db.getDb()
    .prepare(`INSERT INTO action_log (account_id, action_type, status, created_at) VALUES (?, 'like', 'ok', datetime('now','-10 days'))`)
    .run(acctB);
  const before = db.getDb().prepare('SELECT COUNT(*) n FROM action_log').get().n;
  const removed = db.trimActionLog(7); // keep last 7 days → only the 10d row goes
  const after = db.getDb().prepare('SELECT COUNT(*) n FROM action_log').get().n;
  assert.strictEqual(removed, 1, `only the 10-day-old row should be trimmed, trimmed ${removed}`);
  assert.strictEqual(after, before - removed, 'row count drops by exactly the trimmed amount');
  // The 3-day-old row survives (3 < 7) and today's rows are untouched.
  assert.strictEqual(db.countActionsToday(acctA), 2, "today's A rows survive the trim");
  const threeDayOld = db
    .getDb()
    .prepare(`SELECT COUNT(*) n FROM action_log WHERE created_at < datetime('now','-2 days') AND created_at > datetime('now','-7 days')`)
    .get().n;
  assert.ok(threeDayOld >= 1, 'the 3-day-old row is retained by the 7-day window');
});

test('trimActionLog coerces a non-positive/NaN day-count to 30 (never deletes everything)', () => {
  const before = db.getDb().prepare('SELECT COUNT(*) n FROM action_log').get().n;
  assert.ok(before > 0, 'precondition: rows exist');
  // 0 / negative / NaN must NOT translate to "delete all rows newer than now".
  assert.strictEqual(db.trimActionLog(0), 0, '0 coerced to 30d → nothing recent trimmed');
  assert.strictEqual(db.trimActionLog(-5), 0, 'negative coerced to 30d');
  assert.strictEqual(db.trimActionLog(NaN), 0, 'NaN coerced to 30d');
  const after = db.getDb().prepare('SELECT COUNT(*) n FROM action_log').get().n;
  assert.strictEqual(after, before, 'no rows deleted by the guarded bad inputs');
});

// ── account_status: per-BRANCH isolation (heartbeat last-writer-wins fix) ──────
// v2: account_status is keyed by branch_id (one row per branch), the per-branch
// observability fix for the single global worker_state row. The accessors are
// setBranchStatus/getBranchStatus/listBranchStatuses.

test('account_status: one branch error is NOT clobbered by another running', () => {
  db.setBranchStatus(branchA, 'running', 'A cycle started');
  db.setBranchStatus(branchB, 'error', 'B boom'); // B fails
  db.setBranchStatus(branchA, 'ok', 'A cycle ok'); // A succeeds AFTER B failed

  const a = db.getBranchStatus(branchA);
  const b = db.getBranchStatus(branchB);
  assert.strictEqual(a.status, 'ok', 'A reflects its own latest status');
  assert.strictEqual(b.status, 'error', "B's error survives A's later running/ok — NOT clobbered");
  assert.strictEqual(b.detail, 'B boom');
});

test('account_status: last_cycle_at bumps only on terminal (ok|error), not on running', () => {
  const freshAcct = db.insertAccount({ name: 'retC', email: 'c@x.com', session_file: 's3' });
  const freshBranch = db.insertBranch({ account_id: freshAcct, name: 'default', is_default: 1, target_page_url: 'u3' });
  db.setBranchStatus(freshBranch, 'running', 'started');
  assert.strictEqual(db.getBranchStatus(freshBranch).last_cycle_at, null, 'running does not set last_cycle_at');
  db.setBranchStatus(freshBranch, 'ok', 'done');
  const afterOk = db.getBranchStatus(freshBranch).last_cycle_at;
  assert.ok(afterOk, 'ok sets last_cycle_at');
  db.setBranchStatus(freshBranch, 'running', 'next started');
  assert.strictEqual(db.getBranchStatus(freshBranch).last_cycle_at, afterOk, 'running preserves prior last_cycle_at');
});

test('listBranchStatuses returns one row per branch that has run', () => {
  const rows = db.listBranchStatuses();
  const ids = rows.map((r) => r.branch_id);
  assert.ok(ids.includes(branchA) && ids.includes(branchB), 'both run branches present');
});

test('account_status cascades on branch (and account) delete', () => {
  const tmpAcct = db.insertAccount({ name: 'retDel', email: 'd@x.com', session_file: 's4' });
  const tmpBranch = db.insertBranch({ account_id: tmpAcct, name: 'default', is_default: 1, target_page_url: 'u4' });
  db.setBranchStatus(tmpBranch, 'ok', 'x');
  assert.ok(db.getBranchStatus(tmpBranch), 'status row exists');
  // Deleting the account cascades to branches, which cascades to account_status.
  db.getDb().prepare('DELETE FROM accounts WHERE id = ?').run(tmpAcct);
  assert.strictEqual(db.getBranchStatus(tmpBranch), undefined, 'status row cascade-deleted with the branch');
});

// ── index.js retention primitives (require.main guard lets us import safely) ───

test('index.js retentionDays parses the env var, defaults to 30', () => {
  const idx = require('../index.js'); // require.main !== module → main() does NOT run
  const prev = process.env.ACTION_LOG_RETENTION_DAYS;
  try {
    delete process.env.ACTION_LOG_RETENTION_DAYS;
    assert.strictEqual(idx.retentionDays(), 30, 'default 30 when unset');
    process.env.ACTION_LOG_RETENTION_DAYS = '7';
    assert.strictEqual(idx.retentionDays(), 7, 'parses a valid positive int');
    process.env.ACTION_LOG_RETENTION_DAYS = '0';
    assert.strictEqual(idx.retentionDays(), 30, '0 falls back to 30');
    process.env.ACTION_LOG_RETENTION_DAYS = 'garbage';
    assert.strictEqual(idx.retentionDays(), 30, 'non-numeric falls back to 30');
  } finally {
    if (prev === undefined) delete process.env.ACTION_LOG_RETENTION_DAYS;
    else process.env.ACTION_LOG_RETENTION_DAYS = prev;
  }
});

test('index.js runRetentionOnce trims against the live DB without throwing', () => {
  const idx = require('../index.js');
  assert.doesNotThrow(() => idx.runRetentionOnce(), 'boot trim is best-effort, never throws');
});
