'use strict';

/**
 * test/state.test.js — unit tests for the pure helpers extracted into
 * core/state.js during the Phase 2 decomposition: cleanFbUrl, postHash,
 * extractFbHandle, extractUserIdFromProfileUrl.
 *
 * These are I/O-free and deterministic. We point DB_PATH at a temp file before
 * requiring the module (core/state.js requires db.js at load), but these tests
 * exercise only the pure helpers — no DB rows are touched.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbstate-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');

const state = require('../core/state.js');
const db = require('../db');

after(() => {
  db.closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── cleanFbUrl ───────────────────────────────────────────────────────────────

test('cleanFbUrl strips tracking params but keeps real ones', () => {
  const dirty =
    'https://www.facebook.com/permalink.php?story_fbid=9&id=5&__cft__[0]=abc&__tn__=x&ref=y&fref=z&source=feed';
  const clean = state.cleanFbUrl(dirty);
  const u = new URL(clean);
  assert.strictEqual(u.searchParams.get('story_fbid'), '9', 'real param kept');
  assert.strictEqual(u.searchParams.get('id'), '5', 'real param kept');
  assert.strictEqual(u.searchParams.has('__cft__[0]'), false, 'bracket cft stripped');
  assert.strictEqual(u.searchParams.has('__tn__'), false, '__tn__ stripped');
  assert.strictEqual(u.searchParams.has('ref'), false, 'ref stripped');
  assert.strictEqual(u.searchParams.has('fref'), false, 'fref stripped');
  assert.strictEqual(u.searchParams.has('source'), false, 'source stripped');
});

test('cleanFbUrl returns falsy / unparseable input unchanged', () => {
  assert.strictEqual(state.cleanFbUrl(''), '');
  assert.strictEqual(state.cleanFbUrl(null), null);
  assert.strictEqual(state.cleanFbUrl(undefined), undefined);
  assert.strictEqual(state.cleanFbUrl('not a url'), 'not a url');
});

// ── postHash ─────────────────────────────────────────────────────────────────

test('postHash is deterministic, 12 alnum chars, and url-sensitive', () => {
  const a = state.postHash('https://www.facebook.com/post/123');
  const b = state.postHash('https://www.facebook.com/post/123');
  const c = state.postHash('https://www.facebook.com/post/124');
  assert.strictEqual(a, b, 'same input -> same hash');
  assert.notStrictEqual(a, c, 'different input -> different hash');
  assert.match(a, /^[a-zA-Z0-9]{1,12}$/, 'alphanumeric, <=12 chars');
});

// ── extractFbHandle ──────────────────────────────────────────────────────────

test('extractFbHandle handles profile.php, /user/, and username forms', () => {
  assert.strictEqual(state.extractFbHandle('https://www.facebook.com/profile.php?id=123'), '123');
  assert.strictEqual(state.extractFbHandle('https://www.facebook.com/groups/abc/user/456/'), '456');
  assert.strictEqual(state.extractFbHandle('https://www.facebook.com/john.doe'), 'john.doe');
});

test('extractFbHandle prefers id param over path', () => {
  // profile.php?id wins even though there is a path
  assert.strictEqual(state.extractFbHandle('https://www.facebook.com/profile.php?id=999'), '999');
});

test('extractFbHandle returns null for unparseable input', () => {
  assert.strictEqual(state.extractFbHandle('::::'), null);
});

// ── extractUserIdFromProfileUrl ──────────────────────────────────────────────

test('extractUserIdFromProfileUrl reads id param or last path segment', () => {
  assert.strictEqual(
    state.extractUserIdFromProfileUrl({ ownProfileUrl: 'https://www.facebook.com/profile.php?id=77' }),
    '77'
  );
  assert.strictEqual(
    state.extractUserIdFromProfileUrl({ ownProfileUrl: 'https://www.facebook.com/jane.doe' }),
    'jane.doe'
  );
});

test('extractUserIdFromProfileUrl returns null when ownProfileUrl absent', () => {
  assert.strictEqual(state.extractUserIdFromProfileUrl({}), null);
  assert.strictEqual(state.extractUserIdFromProfileUrl({ ownProfileUrl: '' }), null);
});

// ── DB-backed state round-trips (key by account.id) ──────────────────────────

test('DB-backed state: last post id, shared posts (dedup), seen comments, dm sent', () => {
  db.getDb();
  const id = db.insertAccount({
    name: 'stateAcct',
    email: 'e@x.com',
    session_file: 'sessions/stateAcct.json',
    target_page_url: 'https://fb.com/p',
  });
  const account = { id };

  state.writeLastPostId(account, 'P1');
  assert.strictEqual(state.readLastPostId(account), 'P1');

  // addSharedPost cleans + dedupes by clean url
  state.addSharedPost(account, 'https://fb.com/x?ref=a');
  state.addSharedPost(account, 'https://fb.com/x?ref=b'); // same clean url
  assert.deepStrictEqual(state.readSharedPosts(account), ['https://fb.com/x']);

  const seen = state.readSeenComments(account, 'P1');
  seen.add('c1');
  seen.add('c2');
  state.writeSeenComments(account, 'P1', seen);
  // writing again is idempotent (append-only with ON CONFLICT DO NOTHING)
  state.writeSeenComments(account, 'P1', seen);
  assert.deepStrictEqual([...state.readSeenComments(account, 'P1')].sort(), ['c1', 'c2']);

  const dm = state.readDmSent(account);
  dm.add('https://fb.com/u/1');
  state.writeDmSent(account, dm);
  assert.deepStrictEqual([...state.readDmSent(account)], ['https://fb.com/u/1']);
});
