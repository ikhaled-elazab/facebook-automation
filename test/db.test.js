'use strict';

/**
 * test/db.test.js — data-access layer round-trips against a REAL temp SQLite v2.
 *
 * v2 RE-KEY (multi-branch): an account is the LOGIN ENVELOPE; a BRANCH is the
 * monitoring unit (1 account : N branches). The 8 child/state/status tables are
 * keyed by branch_id, and the v2 accessors are getBranch / setBranch (the v1
 * getAccount / setAccount accessors are gone). The per-target columns moved off accounts to
 * branches; daily_action_cap stays on the account as the per-account CEILING.
 * Every test here exercises the genuine schema + SQL (no mocks).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Point the DB layer at a temp file BEFORE requiring it.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbdb-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');

const db = require('../db');

before(() => {
  db.getDb(); // initialize schema + singletons
});

after(() => {
  db.closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

test('seeds singleton settings + worker_state', () => {
  const s = db.getSettings();
  assert.strictEqual(s.id, 1);
  assert.strictEqual(s.pacing_enabled, 1, 'safety-first pacing on by default');
  assert.ok(s.global_daily_action_cap > 0, 'daily cap modeled');
  const w = db.getWorkerState();
  assert.strictEqual(w.desired_state, 'stopped');
});

test('updateSettings persists a patch', () => {
  db.updateSettings({ use_ai: 1, max_action_ms: 9000 });
  const s = db.getSettings();
  assert.strictEqual(s.use_ai, 1);
  assert.strictEqual(s.max_action_ms, 9000);
});

test('insert + fetch an account (login envelope only)', () => {
  // v2: per-target columns (target_page_url, check_interval_minutes, …) live on
  // branches now — an account holds only login/identity/fingerprint/proxy + the
  // per-account daily-cap CEILING.
  const id = db.insertAccount({
    name: 'acctTest',
    email: 'a@b.com',
    password_enc: 'iv:tag:ct',
    session_file: 'sessions/acctTest.json',
    daily_action_cap: 150,
  });
  assert.ok(id > 0);
  const a = db.getAccountByName('acctTest');
  assert.strictEqual(a.email, 'a@b.com');
  assert.strictEqual(a.daily_action_cap, 150, 'per-account ceiling stored on the account');
  assert.strictEqual(a.enabled, 1);
  // The moved per-target columns are NOT on the accounts table anymore.
  assert.strictEqual(a.check_interval_minutes, undefined, 'check_interval_minutes moved to branches');
  assert.strictEqual(a.target_page_url, undefined, 'target_page_url moved to branches');
});

test('insert + fetch a branch (the monitoring unit) with its per-target columns', () => {
  const a = db.getAccountByName('acctTest');
  const branchId = db.insertBranch({
    account_id: a.id,
    name: 'main',
    is_default: 1,
    target_page_url: 'https://fb.com/page',
    check_interval_minutes: 5,
    send_dm_to_commenters: 1,
    dm_as_page_url: 'https://fb.com/page-id',
  });
  assert.ok(branchId > 0);
  const b = db.getBranchById(branchId);
  assert.strictEqual(b.account_id, a.id, 'branch parented to the account');
  assert.strictEqual(b.target_page_url, 'https://fb.com/page');
  assert.strictEqual(b.check_interval_minutes, 5, 'default applied / set on the branch');
  assert.strictEqual(b.is_default, 1);
  assert.strictEqual(b.daily_action_cap, null, 'NULL branch cap inherits the account ceiling');
});

test('branch child collections round-trip and preserve order (keyed by branch)', () => {
  const a = db.getAccountByName('acctTest');
  const branchId = db.getDefaultBranch(a.id).id;
  db.setBranchComments(branchId, ['c1', 'c2', 'c3']);
  db.setBranchReplies(branchId, ['r1']);
  db.setBranchGroups(branchId, ['g1', 'g2']);
  assert.deepStrictEqual(db.getBranchComments(branchId), ['c1', 'c2', 'c3']);
  assert.deepStrictEqual(db.getBranchReplies(branchId), ['r1']);
  assert.deepStrictEqual(db.getBranchGroups(branchId), ['g1', 'g2']);
});

test('setBranchComments replaces (not appends)', () => {
  const a = db.getAccountByName('acctTest');
  const branchId = db.getDefaultBranch(a.id).id;
  db.setBranchComments(branchId, ['only']);
  assert.deepStrictEqual(db.getBranchComments(branchId), ['only']);
});

test('account_state: last_post_id + shared_posts upsert (keyed by branch)', () => {
  const a = db.getAccountByName('acctTest');
  const branchId = db.getDefaultBranch(a.id).id;
  db.setLastPostId(branchId, 'post123');
  db.setSharedPosts(branchId, ['https://fb.com/p/1']);
  assert.strictEqual(db.getBranchState(branchId).last_post_id, 'post123');
  assert.deepStrictEqual(db.getSharedPosts(branchId), ['https://fb.com/p/1']);
  // update again
  db.setLastPostId(branchId, 'post456');
  assert.strictEqual(db.getBranchState(branchId).last_post_id, 'post456');
  assert.deepStrictEqual(db.getSharedPosts(branchId), ['https://fb.com/p/1'], 'shared_posts untouched by last_post update');
});

test('seen_comments dedupe by (branch, post, comment)', () => {
  const a = db.getAccountByName('acctTest');
  const branchId = db.getDefaultBranch(a.id).id;
  db.addSeenComment(branchId, 'postX', 'cmt1');
  db.addSeenComment(branchId, 'postX', 'cmt1'); // dup ignored
  db.addSeenComment(branchId, 'postX', 'cmt2');
  const seen = db.getSeenComments(branchId, 'postX');
  assert.strictEqual(seen.size, 2);
  assert.ok(seen.has('cmt1') && seen.has('cmt2'));
});

test('dm_sent dedupe (keyed by branch)', () => {
  const a = db.getAccountByName('acctTest');
  const branchId = db.getDefaultBranch(a.id).id;
  db.addDmSent(branchId, 'https://fb.com/u/1');
  db.addDmSent(branchId, 'https://fb.com/u/1');
  assert.strictEqual(db.getDmSent(branchId).size, 1);
});

test('action_log + countActionsToday (per-account ceiling tier)', () => {
  const a = db.getAccountByName('acctTest');
  db.logAction({ accountId: a.id, actionType: 'like', status: 'ok' });
  db.logAction({ accountId: a.id, actionType: 'comment', status: 'ok' });
  db.logAction({ accountId: a.id, actionType: 'share', status: 'failed' });
  assert.strictEqual(db.countActionsToday(a.id), 2, 'only ok actions count toward cap');
});

test('action_log + countBranchActionsToday (per-branch tier)', () => {
  const a = db.getAccountByName('acctTest');
  const branchId = db.getDefaultBranch(a.id).id;
  db.logAction({ branchId, actionType: 'like', status: 'ok' });
  db.logAction({ branchId, actionType: 'comment', status: 'skipped' });
  // logAction resolves the owning account_id from the branch, so the account
  // ceiling count also sees the branch's ok rows.
  assert.strictEqual(db.countBranchActionsToday(branchId), 1, 'per-branch tier counts only ok rows for this branch');
});

test('worker_state desired + heartbeat', () => {
  db.setDesiredState('running');
  db.heartbeat('running', 'cycle ok');
  const w = db.getWorkerState();
  assert.strictEqual(w.desired_state, 'running');
  assert.strictEqual(w.status, 'running');
  assert.ok(w.last_heartbeat, 'heartbeat timestamp set');
});

test('cascade delete removes branches + children + state', () => {
  const a = db.getAccountByName('acctTest');
  const branchId = db.getDefaultBranch(a.id).id;
  db.getDb().prepare('DELETE FROM accounts WHERE id = ?').run(a.id);
  // branches CASCADE off the account; children/state CASCADE off the branch.
  assert.strictEqual(db.getBranchById(branchId), undefined, 'branch cascade-deleted with the account');
  assert.strictEqual(db.getBranchComments(branchId).length, 0);
  assert.strictEqual(db.getSeenComments(branchId, 'postX').size, 0);
  assert.strictEqual(db.getBranchState(branchId), undefined);
});
