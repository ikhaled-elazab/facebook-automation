'use strict';

/**
 * test/loadConfig.test.js — unit tests for worker/loadConfig.js, the DB→domain
 * Anti-Corruption adapter. It must map snake_case DB rows to the camelCase shape
 * the fb/ selector code expects, preserve the numeric .id state keys off, and
 * resolve child collections + the proxy sub-object. A field-mapping regression
 * here silently breaks every account, so it is unit-tested directly.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fblc-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
// loadConfig does not decrypt, but proxy round-trip parity is nicer with a key.
process.env.APP_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');

const db = require('../db');
const { encrypt, decrypt } = require('../crypto');
const { loadWorkerConfig, hydrateAccount } = require('../worker/loadConfig.js');

let enabledId;

before(() => {
  db.getDb();
  enabledId = db.insertAccount({
    name: 'enabledAcct',
    email: 'e@x.com',
    password_enc: encrypt('login-secret'),
    session_file: 'sessions/enabledAcct.json',
    target_page_url: 'https://www.facebook.com/profile.php?id=100',
    own_profile_url: 'https://www.facebook.com/profile.php?id=200',
    send_dm_to_commenters: 1,
    dm_as_page_url: 'https://www.facebook.com/profile.php?id=300',
    user_agent: 'UA',
    locale: 'en-US',
    timezone_id: 'Africa/Cairo',
    check_interval_minutes: 3,
    proxy_server: 'http://host:8080',
    proxy_username: 'puser',
    proxy_password_enc: encrypt('pproxy'),
  });
  db.setAccountComments(enabledId, ['c1', 'c2']);
  db.setAccountReplies(enabledId, ['r1']);
  db.setAccountDmMessages(enabledId, ['dm1', 'dm2']);
  db.setAccountGroups(enabledId, ['https://www.facebook.com/groups/g1']);

  // a disabled account that loadWorkerConfig() must NOT return
  const disabledId = db.insertAccount({
    name: 'disabledAcct',
    email: 'd@x.com',
    session_file: 'sessions/disabledAcct.json',
    target_page_url: 'https://fb.com/d',
    enabled: 0,
  });
  void disabledId;
});

after(() => {
  db.closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

test('loadWorkerConfig returns only enabled accounts + settings row', () => {
  const { accounts, settings } = loadWorkerConfig();
  assert.strictEqual(accounts.length, 1, 'disabled account excluded');
  assert.strictEqual(accounts[0].name, 'enabledAcct');
  // settings is the raw snake_case row the humanizer/retry/dm-gate read
  assert.strictEqual(settings.id, 1);
  assert.ok('use_vision' in settings && 'min_action_ms' in settings && 'enable_dm_to_commenters' in settings);
});

test('hydrateAccount maps snake_case -> camelCase and preserves numeric id', () => {
  const row = db.getAccountById(enabledId);
  const a = hydrateAccount(row);

  assert.strictEqual(a.id, enabledId, 'numeric DB id preserved (state keys off it)');
  assert.strictEqual(a.targetPageUrl, 'https://www.facebook.com/profile.php?id=100');
  assert.strictEqual(a.ownProfileUrl, 'https://www.facebook.com/profile.php?id=200');
  assert.strictEqual(a.dmAsPageUrl, 'https://www.facebook.com/profile.php?id=300');
  assert.strictEqual(a.sendDmToCommenters, true, 'INTEGER 1 -> boolean true');
  assert.strictEqual(a.checkIntervalMinutes, 3);
  assert.strictEqual(a.userAgent, 'UA');
  assert.strictEqual(a.timezoneId, 'Africa/Cairo');
  assert.strictEqual(a.sessionFile, 'sessions/enabledAcct.json');
});

test('hydrateAccount resolves child collections in order', () => {
  const a = hydrateAccount(db.getAccountById(enabledId));
  assert.deepStrictEqual(a.comments, ['c1', 'c2']);
  assert.deepStrictEqual(a.replies, ['r1']);
  assert.deepStrictEqual(a.dmMessages, ['dm1', 'dm2']);
  assert.deepStrictEqual(a.groups, ['https://www.facebook.com/groups/g1']);
});

test('hydrateAccount builds proxy sub-object with encrypted password (decryptable, never plaintext)', () => {
  const a = hydrateAccount(db.getAccountById(enabledId));
  assert.ok(a.proxy, 'proxy object present when proxy_server set');
  assert.strictEqual(a.proxy.server, 'http://host:8080');
  assert.strictEqual(a.proxy.username, 'puser');
  // password is carried encrypted; loadConfig must NOT expose plaintext
  assert.notStrictEqual(a.proxy.passwordEnc, 'pproxy');
  assert.strictEqual(decrypt(a.proxy.passwordEnc), 'pproxy', 'decryptable at context-build time');
  // login password also carried encrypted, not decrypted at load
  assert.notStrictEqual(a.passwordEnc, 'login-secret');
  assert.strictEqual(decrypt(a.passwordEnc), 'login-secret');
});

test('hydrateAccount yields null proxy when no proxy_server', () => {
  const id = db.insertAccount({
    name: 'noProxyAcct',
    email: 'np@x.com',
    session_file: 'sessions/noProxyAcct.json',
    target_page_url: 'https://fb.com/np',
  });
  const a = hydrateAccount(db.getAccountById(id));
  assert.strictEqual(a.proxy, null);
});
