'use strict';

/**
 * test/loadConfig.test.js — unit tests for worker/loadConfig.js, the DB→domain
 * Anti-Corruption adapter.
 *
 * v2 (multi-branch): the monitoring unit is a (account, branch) pair. hydrateBranch
 * merges the account ENVELOPE (credentials/session/proxy/fingerprint — keyed for
 * login) with the BRANCH's per-target fields + content, and sets `.id` = the BRANCH
 * id (the state/content/governor/logging key). loadWorkerConfig returns enabled
 * accounts, each carrying an enabled `branches[]`. A field-mapping regression here
 * silently breaks every account, so it is unit-tested directly.
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
const { loadWorkerConfig, hydrateBranch, accountEnvelope } = require('../worker/loadConfig.js');

let enabledId;
let enabledBranchId;

before(() => {
  db.getDb();
  // v2: the account is the login envelope (credentials/session/proxy/fingerprint +
  // the per-account cap CEILING). The per-target fields + content live on a branch.
  enabledId = db.insertAccount({
    name: 'enabledAcct',
    email: 'e@x.com',
    password_enc: encrypt('login-secret'),
    session_file: 'sessions/enabledAcct.json',
    user_agent: 'UA',
    locale: 'en-US',
    timezone_id: 'Africa/Cairo',
    daily_action_cap: 120, // per-account ceiling
    proxy_server: 'http://host:8080',
    proxy_username: 'puser',
    proxy_password_enc: encrypt('pproxy'),
  });
  enabledBranchId = db.insertBranch({
    account_id: enabledId,
    name: 'default',
    is_default: 1,
    target_page_url: 'https://www.facebook.com/profile.php?id=100',
    own_profile_url: 'https://www.facebook.com/profile.php?id=200',
    send_dm_to_commenters: 1,
    dm_as_page_url: 'https://www.facebook.com/profile.php?id=300',
    check_interval_minutes: 3,
    daily_action_cap: null, // inherit the account ceiling
  });
  db.setBranchComments(enabledBranchId, ['c1', 'c2']);
  db.setBranchReplies(enabledBranchId, ['r1']);
  db.setBranchDmMessages(enabledBranchId, ['dm1', 'dm2']);
  db.setBranchGroups(enabledBranchId, ['https://www.facebook.com/groups/g1']);

  // a disabled account that loadWorkerConfig() must NOT return
  const disabledId = db.insertAccount({
    name: 'disabledAcct',
    email: 'd@x.com',
    session_file: 'sessions/disabledAcct.json',
    enabled: 0,
  });
  db.insertBranch({ account_id: disabledId, name: 'default', is_default: 1, target_page_url: 'https://fb.com/d' });
});

after(() => {
  db.closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

test('loadWorkerConfig returns only enabled accounts + settings row', () => {
  const { accounts, settings } = loadWorkerConfig();
  assert.strictEqual(accounts.length, 1, 'disabled account excluded');
  assert.strictEqual(accounts[0].name, 'enabledAcct');
  // The enabled account carries its enabled branches[] (the monitoring units).
  assert.ok(Array.isArray(accounts[0].branches), 'account carries a branches array');
  assert.strictEqual(accounts[0].branches.length, 1, 'one enabled branch hydrated');
  assert.strictEqual(accounts[0].branches[0].id, enabledBranchId, 'branch .id is the BRANCH id');
  // settings is the raw snake_case row the humanizer/retry/dm-gate read
  assert.strictEqual(settings.id, 1);
  assert.ok('use_vision' in settings && 'min_action_ms' in settings && 'enable_dm_to_commenters' in settings);
});

test('hydrateBranch maps snake_case -> camelCase and sets .id to the BRANCH id', () => {
  const acctRow = db.getAccountById(enabledId);
  const branchRow = db.getBranchById(enabledBranchId);
  const a = hydrateBranch(acctRow, branchRow);

  assert.strictEqual(a.id, enabledBranchId, 'numeric BRANCH id is the state/content key');
  assert.strictEqual(a.branchId, enabledBranchId, 'branchId carried explicitly');
  assert.strictEqual(a.accountId, enabledId, 'owning accountId carried for login/ceiling');
  assert.strictEqual(a.targetPageUrl, 'https://www.facebook.com/profile.php?id=100');
  assert.strictEqual(a.ownProfileUrl, 'https://www.facebook.com/profile.php?id=200');
  assert.strictEqual(a.dmAsPageUrl, 'https://www.facebook.com/profile.php?id=300');
  assert.strictEqual(a.sendDmToCommenters, true, 'INTEGER 1 -> boolean true');
  assert.strictEqual(a.checkIntervalMinutes, 3);
  assert.strictEqual(a.userAgent, 'UA');
  assert.strictEqual(a.timezoneId, 'Africa/Cairo');
  assert.strictEqual(a.sessionFile, 'sessions/enabledAcct.json');
  // Cap tiers: branch cap NULL inherits; the account ceiling is carried separately.
  assert.strictEqual(a.dailyActionCap, null, 'branch cap NULL = inherit');
  assert.strictEqual(a.accountDailyActionCap, 120, 'account ceiling carried for the governor');
});

test('hydrateBranch resolves child collections in order', () => {
  const a = hydrateBranch(db.getAccountById(enabledId), db.getBranchById(enabledBranchId));
  assert.deepStrictEqual(a.comments, ['c1', 'c2']);
  assert.deepStrictEqual(a.replies, ['r1']);
  assert.deepStrictEqual(a.dmMessages, ['dm1', 'dm2']);
  assert.deepStrictEqual(a.groups, ['https://www.facebook.com/groups/g1']);
});

test('hydrateBranch builds proxy sub-object with encrypted password (decryptable, never plaintext)', () => {
  const a = hydrateBranch(db.getAccountById(enabledId), db.getBranchById(enabledBranchId));
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

test('accountEnvelope yields null proxy when no proxy_server', () => {
  const id = db.insertAccount({
    name: 'noProxyAcct',
    email: 'np@x.com',
    session_file: 'sessions/noProxyAcct.json',
  });
  const branchId = db.insertBranch({ account_id: id, name: 'default', is_default: 1, target_page_url: 'https://fb.com/np' });
  const a = hydrateBranch(db.getAccountById(id), db.getBranchById(branchId));
  assert.strictEqual(a.proxy, null);
  // accountEnvelope alone also reports a null proxy (the envelope is per-account).
  assert.strictEqual(accountEnvelope(db.getAccountById(id)).proxy, null);
});
