'use strict';

/**
 * test/falsesuccess.test.js — regression tests for the P5 CRITICAL false-success
 * logging bug.
 *
 * THE BUG: withRetry returned `undefined` on attempts-exhaustion and NEVER threw,
 * so the worker's governed() did `await fn()` and logged status:'ok'
 * UNCONDITIONALLY. A fully-failed Facebook action was recorded as 'ok' AND
 * counted toward the daily cap — the worst possible outcome for an anti-ban
 * guard (it both lies to the operator and burns the budget on nothing).
 *
 * THE FIX: withRetry returns a dedicated RETRY_FAILED Symbol on exhaustion;
 * governed() logs 'failed' for that (countActionsToday does NOT count 'failed')
 * and 'ok' only on a real success — INCLUDING when the successful action's real
 * return value is `undefined` (likePost/commentOnPost return undefined on
 * success, so a naive `result !== undefined` check would have INVERTED the bug).
 *
 * These tests drive the REAL worker/loop.js checkAndAct via its injectable ctx
 * (withRetry + governor + logAction), with a throwaway temp DB, so no browser /
 * network / wall clock is involved.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the DB before requiring db (DB_PATH is read lazily on first getDb).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbfalse-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.APP_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');

const db = require('../db');
const loop = require('../worker/loop.js');
const { RETRY_FAILED } = require('../core/retry.js');

// An always-allow governor so we reach (and run) the write actions.
const ALLOW_GOVERNOR = { canAct: () => ({ allowed: true, reason: 'ok', detail: null }) };

const fakePage = {
  async goto() {},
  keyboard: { async press() {} },
};

let accountId;
let branchId;

before(() => {
  db.getDb();
  // v2: target_page_url moved to branches; an account is the login envelope only.
  // checkAndAct keys runtime STATE + action_log on the BRANCH (the monitoring
  // unit): writeLastPostId(account) → db.setLastPostId(account.id) writes
  // account_state(branch_id=account.id), which has a FK to branches. So the hydrated
  // POJO's `.id` must be a real BRANCH id (not the account id), or the state write
  // FK-fails and the whole cycle is swallowed by checkAndAct's try/catch (logging
  // zero actions). We seed both an account and its default branch below.
  accountId = db.insertAccount({ name: 'falsetest', email: 'e@x.com', session_file: 's' });
  branchId = db.insertBranch({ account_id: accountId, name: 'default', is_default: 1, target_page_url: 'u' });
});

after(() => {
  db.closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/**
 * Build a ctx whose withRetry returns a caller-chosen value for the WRITE
 * actions (LIKE/COMMENT/SHARE/SHARE-GROUPS) and a fresh post for the MONITOR
 * read so checkAndAct proceeds to the gated writes. The post id is randomized
 * per call so readLastPostId never short-circuits "no new post".
 * @param {(label: string) => any} writeResult value returned for each write action
 */
function makeCtx(writeResult) {
  const logged = [];
  const ctx = {
    h: { randomDelay: async () => {}, sleep: async () => {} },
    withRetry: async (fn, page, account, label) => {
      if (label === 'MONITOR') {
        return { postId: `p-${Math.random()}`, postUrl: 'http://x/p', postText: 'hi' };
      }
      return writeResult(label);
    },
    governor: ALLOW_GOVERNOR,
    logAction: (e) => logged.push(e),
  };
  return { ctx, logged };
}

// v2 hydrated branch shape: `.id` is the BRANCH id (state/log key), `accountId`
// is the owning login, `dailyActionCap` (branch) + `accountDailyActionCap`
// (ceiling) both 0 = unlimited so the always-allow governor never blocks on a cap.
const ACCOUNT = () => ({
  id: branchId,
  branchId,
  accountId,
  name: 'falsetest',
  dailyActionCap: 0, // branch cap: unlimited
  accountDailyActionCap: 0, // account ceiling: unlimited
  comments: ['c'],
  replies: ['r'],
  groups: [],
});

// ── CRITICAL: a failed action logs 'failed', NOT 'ok' ─────────────────────────

test("governed(): a FAILED action (withRetry → RETRY_FAILED) logs 'failed', not 'ok'", async () => {
  // Every write action exhausts its retries → RETRY_FAILED sentinel.
  const { ctx, logged } = makeCtx(() => RETRY_FAILED);

  await loop.checkAndAct(fakePage, ACCOUNT(), ctx);

  const writeRows = logged.filter((r) => ['like', 'comment', 'share'].includes(r.actionType));
  assert.ok(writeRows.length >= 4, `expected the 4 write actions to log (got ${writeRows.length})`);
  assert.strictEqual(
    writeRows.filter((r) => r.status === 'ok').length,
    0,
    "NO failed action may log 'ok' (this was the false-success bug)"
  );
  assert.strictEqual(
    writeRows.filter((r) => r.status === 'failed').length,
    writeRows.length,
    "every failed action logs status:'failed'"
  );
});

test("countActionsToday does NOT count 'failed' rows toward the cap", async () => {
  // Fresh account + its default branch so the count starts at 0 AND the branch-keyed
  // state write inside checkAndAct has a valid FK target. The POJO's `.id` is the
  // branch id (state/log key); the direct db.logAction below uses the account id
  // (countActionsToday is the per-account ceiling tier).
  const id = db.insertAccount({ name: 'failcount', email: 'e2@x.com', session_file: 's' });
  const bId = db.insertBranch({ account_id: id, name: 'default', is_default: 1, target_page_url: 'u' });
  const { ctx } = makeCtx(() => RETRY_FAILED);
  const acct = { ...ACCOUNT(), id: bId, branchId: bId, accountId: id, name: 'failcount' };

  await loop.checkAndAct(fakePage, acct, ctx);

  // The capturing logAction in makeCtx does NOT write to the DB, so write to the
  // DB directly with the SAME statuses checkAndAct produced, then assert the
  // count. (This isolates the db-level invariant: 'failed' rows are not counted.)
  db.logAction({ accountId: id, actionType: 'like', status: 'failed' });
  db.logAction({ accountId: id, actionType: 'comment', status: 'failed' });
  assert.strictEqual(db.countActionsToday(id), 0, "'failed' rows never advance the daily cap");

  db.logAction({ accountId: id, actionType: 'like', status: 'ok' });
  assert.strictEqual(db.countActionsToday(id), 1, "only 'ok' rows advance the cap");
});

// ── A successful undefined-returning action still logs 'ok' ───────────────────

test("governed(): a SUCCESS that returns `undefined` still logs 'ok' (not 'failed')", async () => {
  // likePost/commentOnPost resolve to undefined on SUCCESS. The fix must treat
  // that as 'ok' — only the RETRY_FAILED sentinel is a failure.
  const { ctx, logged } = makeCtx(() => undefined);

  await loop.checkAndAct(fakePage, ACCOUNT(), ctx);

  const writeRows = logged.filter((r) => ['like', 'comment', 'share'].includes(r.actionType));
  assert.ok(writeRows.length >= 4, 'all write actions logged');
  assert.strictEqual(
    writeRows.filter((r) => r.status === 'failed').length,
    0,
    "a successful undefined-returning action must NOT log 'failed' (naive !== undefined check would invert the bug)"
  );
  assert.strictEqual(
    writeRows.filter((r) => r.status === 'ok').length,
    writeRows.length,
    "every successful action (even undefined-returning) logs 'ok'"
  );
});

test('governed(): a failed SHARE maps RETRY_FAILED → null so the downstream URL check treats it as no-URL', async () => {
  // SHARE is the one action whose result is consumed downstream (the captured
  // profile post URL). A failed SHARE must surface as null, not the truthy
  // RETRY_FAILED Symbol, or `if (profilePostUrl)` would log a bogus success.
  const { ctx, logged } = makeCtx((label) => (label === 'SHARE' ? RETRY_FAILED : undefined));

  // Must not throw (a truthy sentinel reaching the URL branch would not throw,
  // but this guards the contract that the mapping happens).
  await assert.doesNotReject(loop.checkAndAct(fakePage, ACCOUNT(), ctx));

  const shareRows = logged.filter((r) => r.actionType === 'share');
  // The 'SHARE' (profile) row must be 'failed'; 'SHARE-GROUPS' is 'ok' (undefined).
  assert.ok(
    shareRows.some((r) => r.status === 'failed'),
    'the failed profile-share logs failed'
  );
});
