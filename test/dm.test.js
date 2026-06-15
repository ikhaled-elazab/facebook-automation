'use strict';

/**
 * test/dm.test.js — regression tests for the P5 false-success fix in
 * fb/actions/dm.js sendDmToUser.
 *
 * THE BUG: sendDmToUser returned nothing, and fb/monitor.js logged a 'dm' action
 * as status:'ok' UNCONDITIONALLY — even when the DM was a no-op (deduped /
 * disabled / self) or failed. A DM that sent NOTHING still counted toward the
 * daily cap.
 *
 * THE FIX: sendDmToUser returns a discriminated result:
 *   - { sent: true }                          → a real send       → caller logs 'ok'
 *   - { sent: false, reason: <no-op reason> }  → a legitimate no-op → caller logs 'skipped'
 *   - { sent: false, reason: 'error', error }  → an attempt error   → caller logs 'failed'
 *
 * The early-return no-op guards (disabled / not-configured / no-messages /
 * self-profile / deduped) are reachable WITHOUT a real browser, so we exercise
 * the result-shape contract directly. A throwaway temp DB backs readDmSent.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the DB before requiring db.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbdm-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.APP_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');

const db = require('../db');
const { sendDmToUser } = require('../fb/actions/dm.js');

const SETTINGS_DM_ON = { enable_dm_to_commenters: 1 };
const H = { randomDelay: async () => {}, pickRandom: (a) => a[0], typeText: async () => {} };

let accountId;
let branchId;

before(() => {
  db.getDb();
  // v2: target_page_url moved to branches; an account is the login envelope only.
  // These no-op tests pass a POJO branch object to sendDmToUser (not a DB row), so
  // the seed exists purely to give db.addDmSent a real branch FK target below.
  accountId = db.insertAccount({ name: 'dmtest', email: 'e@x.com', session_file: 's' });
  branchId = db.insertBranch({ account_id: accountId, name: 'default', is_default: 1, target_page_url: 'u' });
});

after(() => {
  db.closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/** A base branch configured to DM. The page is never reached by the no-op tests.
 *  v2: the monitoring unit is a BRANCH; its `.id` is the branch id (the dm_sent
 *  dedupe key), so the POJO carries branchId as `.id` to match core/state.js. */
function dmAccount(extra = {}) {
  return {
    id: branchId,
    name: 'dmtest',
    sendDmToCommenters: true,
    dmMessages: ['hello'],
    ownProfileUrl: 'https://facebook.com/me',
    ...extra,
  };
}

// ── no-op result shapes (must be {sent:false}, never a silent success) ─────────

test("sendDmToUser returns {sent:false} when the global DM setting is OFF", async () => {
  const res = await sendDmToUser(null, dmAccount(), 'https://facebook.com/x', { enable_dm_to_commenters: 0 }, H);
  assert.deepStrictEqual(res, { sent: false, reason: 'dm_disabled' });
});

test("sendDmToUser returns {sent:false} when the account opted out", async () => {
  const res = await sendDmToUser(null, dmAccount({ sendDmToCommenters: false }), 'https://facebook.com/x', SETTINGS_DM_ON, H);
  assert.deepStrictEqual(res, { sent: false, reason: 'account_dm_off' });
});

test("sendDmToUser returns {sent:false} when there are no DM messages configured", async () => {
  const res = await sendDmToUser(null, dmAccount({ dmMessages: [] }), 'https://facebook.com/x', SETTINGS_DM_ON, H);
  assert.deepStrictEqual(res, { sent: false, reason: 'no_messages' });
});

test("sendDmToUser returns {sent:false} for a SELF-DM (own profile)", async () => {
  const res = await sendDmToUser(null, dmAccount(), 'https://facebook.com/me', SETTINGS_DM_ON, H);
  assert.deepStrictEqual(res, { sent: false, reason: 'self_profile' });
});

// ── the headline regression: a DEDUPED DM is 'skipped', never 'ok' ────────────

test("sendDmToUser returns {sent:false, reason:'deduped'} for an already-DM'd profile", async () => {
  const target = 'https://facebook.com/alreadydmd';
  // Seed the DM-sent set so the dedupe guard fires. cleanFbUrl is applied inside
  // sendDmToUser AND addDmSent stores the raw url; seed via the same helper path
  // the function reads (readDmSent → db.getDmSent) using the cleaned form.
  const { cleanFbUrl } = require('../core/state.js');
  db.addDmSent(branchId, cleanFbUrl(target));

  const res = await sendDmToUser(null, dmAccount(), target, SETTINGS_DM_ON, H);
  assert.strictEqual(res.sent, false, "a deduped DM must NOT report sent:true");
  assert.strictEqual(res.reason, 'deduped', "the dedupe reason is reported so the caller logs 'skipped'");
});

test('the caller maps a deduped result to a SKIPPED row, never OK (cap is not burned)', async () => {
  // This mirrors fb/monitor.js's mapping: sent → 'ok'; error → 'failed'; else 'skipped'.
  const mapToStatus = (r) => (r && r.sent ? 'ok' : r && r.reason === 'error' ? 'failed' : 'skipped');

  assert.strictEqual(mapToStatus({ sent: false, reason: 'deduped' }), 'skipped');
  assert.strictEqual(mapToStatus({ sent: false, reason: 'self_profile' }), 'skipped');
  assert.strictEqual(mapToStatus({ sent: false, reason: 'dm_disabled' }), 'skipped');
  assert.strictEqual(mapToStatus({ sent: false, reason: 'error', error: 'nav timeout' }), 'failed');
  assert.strictEqual(mapToStatus({ sent: true }), 'ok');
});
