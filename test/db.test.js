'use strict';

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

test('insert + fetch an account', () => {
  const id = db.insertAccount({
    name: 'acctTest',
    email: 'a@b.com',
    password_enc: 'iv:tag:ct',
    session_file: 'sessions/acctTest.json',
    target_page_url: 'https://fb.com/page',
  });
  assert.ok(id > 0);
  const a = db.getAccountByName('acctTest');
  assert.strictEqual(a.email, 'a@b.com');
  assert.strictEqual(a.check_interval_minutes, 7, 'default applied');
  assert.strictEqual(a.enabled, 1);
});

test('child collections round-trip and preserve order', () => {
  const a = db.getAccountByName('acctTest');
  db.setAccountComments(a.id, ['c1', 'c2', 'c3']);
  db.setAccountReplies(a.id, ['r1']);
  db.setAccountGroups(a.id, ['g1', 'g2']);
  assert.deepStrictEqual(db.getAccountComments(a.id), ['c1', 'c2', 'c3']);
  assert.deepStrictEqual(db.getAccountReplies(a.id), ['r1']);
  assert.deepStrictEqual(db.getAccountGroups(a.id), ['g1', 'g2']);
});

test('setAccountComments replaces (not appends)', () => {
  const a = db.getAccountByName('acctTest');
  db.setAccountComments(a.id, ['only']);
  assert.deepStrictEqual(db.getAccountComments(a.id), ['only']);
});

test('account_state: last_post_id + shared_posts upsert', () => {
  const a = db.getAccountByName('acctTest');
  db.setLastPostId(a.id, 'post123');
  db.setSharedPosts(a.id, ['https://fb.com/p/1']);
  assert.strictEqual(db.getAccountState(a.id).last_post_id, 'post123');
  assert.deepStrictEqual(db.getSharedPosts(a.id), ['https://fb.com/p/1']);
  // update again
  db.setLastPostId(a.id, 'post456');
  assert.strictEqual(db.getAccountState(a.id).last_post_id, 'post456');
  assert.deepStrictEqual(db.getSharedPosts(a.id), ['https://fb.com/p/1'], 'shared_posts untouched by last_post update');
});

test('seen_comments dedupe by (account, post, comment)', () => {
  const a = db.getAccountByName('acctTest');
  db.addSeenComment(a.id, 'postX', 'cmt1');
  db.addSeenComment(a.id, 'postX', 'cmt1'); // dup ignored
  db.addSeenComment(a.id, 'postX', 'cmt2');
  const seen = db.getSeenComments(a.id, 'postX');
  assert.strictEqual(seen.size, 2);
  assert.ok(seen.has('cmt1') && seen.has('cmt2'));
});

test('dm_sent dedupe', () => {
  const a = db.getAccountByName('acctTest');
  db.addDmSent(a.id, 'https://fb.com/u/1');
  db.addDmSent(a.id, 'https://fb.com/u/1');
  assert.strictEqual(db.getDmSent(a.id).size, 1);
});

test('action_log + countActionsToday', () => {
  const a = db.getAccountByName('acctTest');
  db.logAction({ accountId: a.id, actionType: 'like', status: 'ok' });
  db.logAction({ accountId: a.id, actionType: 'comment', status: 'ok' });
  db.logAction({ accountId: a.id, actionType: 'share', status: 'failed' });
  assert.strictEqual(db.countActionsToday(a.id), 2, 'only ok actions count toward cap');
});

test('worker_state desired + heartbeat', () => {
  db.setDesiredState('running');
  db.heartbeat('running', 'cycle ok');
  const w = db.getWorkerState();
  assert.strictEqual(w.desired_state, 'running');
  assert.strictEqual(w.status, 'running');
  assert.ok(w.last_heartbeat, 'heartbeat timestamp set');
});

test('cascade delete removes children + state', () => {
  const a = db.getAccountByName('acctTest');
  db.getDb().prepare('DELETE FROM accounts WHERE id = ?').run(a.id);
  assert.strictEqual(db.getAccountComments(a.id).length, 0);
  assert.strictEqual(db.getSeenComments(a.id, 'postX').size, 0);
  assert.strictEqual(db.getAccountState(a.id), undefined);
});
