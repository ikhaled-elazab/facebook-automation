'use strict';

/* global fetch */
// `fetch` is a Node 18+ global; declared here because the shared eslint config
// (eslint.config.js) does not list it among Node globals.

/**
 * test/branches.test.js — Phase 2 branch CRUD API tests (node:test).
 *
 * Drives the Express app in-process (no port bind) via Node's built-in fetch
 * against a real ephemeral http.Server on an OS-assigned port, with a real temp
 * SQLite v2 DB. No mocks of db.js/crypto — the genuine stack is exercised so a
 * broken re-key / encryption path fails the test (the project's policy).
 *
 * Covers:
 *   - account routes no longer 500 under v2 (create w/o branch fields succeeds;
 *     a stale client that still sends a moved branch field gets 422, not 500)
 *   - branch CRUD: list / create / get / update / delete / set-default
 *   - .strict rejection of unknown keys (the db.js dynamic-column trust boundary),
 *     including the non-writable account_id / is_default keys
 *   - delete-default-branch guard surfaces as a clean 409 (not a 500)
 *   - http(s)-scheme XSS guard on branch URL fields + the groups array
 *   - branch serializer exposes no secrets and coerces booleans
 *   - CSRF + auth required on every mutation
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Point everything at a temp DB + valid config BEFORE requiring app code.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbcp-branch-'));
process.env.DB_PATH = path.join(TMP_DIR, 'cp-branch-test.db');
process.env.ADMIN_USER = 'admin';
// bcrypt hash of 'TestAdmin#Pass123' (cost 12).
process.env.ADMIN_PASSWORD_HASH =
  '$2b$12$B9mJy4Uiav/xsFpSuYnTy.MuGjT6xa1oJm3RMrMS0n6UrHNIHYdOy';
process.env.SESSION_SECRET = 's'.repeat(48);
process.env.CSRF_SECRET = 'c'.repeat(48);
process.env.APP_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.NODE_ENV = 'development';

const { loadConfig } = require('../server/config');
const { createApp } = require('../server/app');
const db = require('../db');

let server;
let baseUrl;
const ADMIN_PASSWORD = 'TestAdmin#Pass123';

const fakeWorkerControl = {
  calls: [],
  async start() {
    return { action: 'started', status: 'online' };
  },
  async stop() {
    return { action: 'stopped', status: 'stopped' };
  },
  async status() {
    return { present: false, status: 'stopped', pid: null, uptime: null, restarts: null, cpu: null, memory: null };
  },
};

before(async () => {
  db.getDb();
  const app = createApp(loadConfig(), {
    logger: { warn() {}, error() {} },
    workerControl: fakeWorkerControl,
  });
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── Tiny cookie-aware client (mirrors server.test.js) ─────────────────────────

function makeClient() {
  const cookies = new Map();
  function cookieHeader() {
    return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  function storeSetCookie(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of raw) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
  }
  async function req(method, urlPath, { body, csrf } = {}) {
    const headers = { cookie: cookieHeader() };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf) headers['x-csrf-token'] = csrf;
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    storeSetCookie(res);
    let json = null;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }
  async function csrf() {
    const r = await req('GET', '/api/auth/csrf');
    return r.body.csrf_token;
  }
  return { req, csrf };
}

async function loginClient() {
  const c = makeClient();
  const token = await c.csrf();
  const r = await c.req('POST', '/api/auth/login', {
    body: { username: 'admin', password: ADMIN_PASSWORD },
    csrf: token,
  });
  assert.strictEqual(r.status, 200, 'login should succeed');
  return c;
}

/** Create an account and return its id. Account create takes NO branch fields. */
async function createAccount(c, name) {
  const token = await c.csrf();
  const r = await c.req('POST', '/api/accounts', {
    csrf: token,
    body: {
      name,
      email: `${name}@example.com`,
      password: 'PlaintextSecret!',
      session_file: `sessions/${name}.json`,
    },
  });
  assert.strictEqual(r.status, 201, `account ${name} should be created`);
  return r.body.account.id;
}

// ── Account routes no longer 500 under v2 ─────────────────────────────────────

test('account create succeeds WITHOUT branch fields (v2 login envelope)', async () => {
  const c = await loginClient();
  const token = await c.csrf();
  const r = await c.req('POST', '/api/accounts', {
    csrf: token,
    body: {
      name: 'acct-v2',
      email: 'v2@example.com',
      password: 'PlaintextSecret!',
      session_file: 'sessions/v2.json',
      daily_action_cap: 150,
    },
  });
  assert.strictEqual(r.status, 201);
  const acct = r.body.account;
  assert.strictEqual(acct.has_password, true);
  assert.strictEqual(acct.daily_action_cap, 150, 'account ceiling kept on the account');
  // Moved branch fields must NOT appear on the account shape.
  for (const moved of [
    'target_page_url', 'own_profile_url', 'dm_as_page_url',
    'send_dm_to_commenters', 'check_interval_minutes', 'comments', 'groups',
  ]) {
    assert.ok(!(moved in acct), `account must not expose moved field "${moved}"`);
  }
});

test('account create REJECTS a stale moved branch field with 422 (not 500)', async () => {
  const c = await loginClient();
  const token = await c.csrf();
  // A v1 client still sending target_page_url must get a loud 422 from .strict(),
  // never a 500 from a write against the dropped column.
  const r = await c.req('POST', '/api/accounts', {
    csrf: token,
    body: {
      name: 'acct-stale',
      email: 'stale@example.com',
      session_file: 's',
      target_page_url: 'https://www.facebook.com/p',
    },
  });
  assert.strictEqual(r.status, 422, 'moved field must be a 422, never a 500');
  assert.strictEqual(r.body.error.code, 'VALIDATION_ERROR');
  assert.ok(
    r.body.error.details.some((d) => /target_page_url/i.test(d.message)),
    'the unrecognized moved key must be reported'
  );
});

// ── branch_count on account responses (FIX 1 — contract: REQUIRED, never undef) ─

test('branch_count is present (number) on account list + get-one + create + update', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'bc-acct');

  // create response carries branch_count = 0 (a new account has no branches yet).
  // (createAccount asserted 201 already; re-create here to read the body shape.)
  let token = await c.csrf();
  const created = await c.req('POST', '/api/accounts', {
    csrf: token,
    body: { name: 'bc-acct2', email: 'bc2@e.com', session_file: 's2', password: 'P!' },
  });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.account.branch_count, 0, 'create emits branch_count 0');

  // get-one carries the live count.
  const getZero = await c.req('GET', `/api/accounts/${accountId}`);
  assert.strictEqual(getZero.status, 200);
  assert.strictEqual(getZero.body.account.branch_count, 0, 'get-one emits branch_count');

  // Add two branches, then re-read: count must reflect them on BOTH list + get.
  for (const name of ['b1', 'b2']) {
    token = await c.csrf();
    await c.req('POST', `/api/accounts/${accountId}/branches`, { csrf: token, body: { name } });
  }
  const getTwo = await c.req('GET', `/api/accounts/${accountId}`);
  assert.strictEqual(getTwo.body.account.branch_count, 2, 'get-one count reflects new branches');

  const list = await c.req('GET', '/api/accounts');
  assert.strictEqual(list.status, 200);
  const entry = list.body.accounts.find((a) => a.id === accountId);
  assert.ok(entry, 'account present in list');
  assert.strictEqual(entry.branch_count, 2, 'list count reflects new branches');
  // Every list entry must carry a numeric branch_count (never undefined).
  for (const a of list.body.accounts) {
    assert.strictEqual(typeof a.branch_count, 'number', `branch_count is a number for "${a.name}"`);
  }

  // update (PATCH) response also carries branch_count.
  token = await c.csrf();
  const patched = await c.req('PATCH', `/api/accounts/${accountId}`, {
    csrf: token, body: { enabled: false },
  });
  assert.strictEqual(patched.status, 200);
  assert.strictEqual(patched.body.account.branch_count, 2, 'update emits branch_count');
});

// ── Branch CRUD ───────────────────────────────────────────────────────────────

test('list branches for a fresh account is an empty array (account exists)', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'br-list-empty');
  const r = await c.req('GET', `/api/accounts/${accountId}/branches`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.branches, []);
});

test('list branches for a non-existent account is 404', async () => {
  const c = await loginClient();
  const r = await c.req('GET', '/api/accounts/999999/branches');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.error.code, 'NOT_FOUND');
});

test('create + get a branch with content arrays (full round-trip)', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'br-create');
  const token = await c.csrf();
  const created = await c.req('POST', `/api/accounts/${accountId}/branches`, {
    csrf: token,
    body: {
      name: 'main-page',
      target_page_url: 'https://www.facebook.com/mypage',
      own_profile_url: 'https://www.facebook.com/me',
      send_dm_to_commenters: true,
      dm_as_page_url: 'https://www.facebook.com/mypage',
      check_interval_minutes: 10,
      daily_action_cap: 50,
      enabled: true,
      comments: ['nice!', 'great post'],
      replies: ['thanks'],
      dm_messages: ['hello there'],
      groups: ['https://www.facebook.com/groups/123'],
    },
  });
  assert.strictEqual(created.status, 201);
  const br = created.body.branch;
  assert.strictEqual(br.account_id, accountId, 'account_id set from the URL');
  assert.strictEqual(br.is_default, false, 'new branch is not default implicitly');
  assert.strictEqual(typeof br.send_dm_to_commenters, 'boolean', 'bool coerced');
  assert.strictEqual(br.send_dm_to_commenters, true);
  assert.strictEqual(br.daily_action_cap, 50);
  assert.deepStrictEqual(br.comments, ['nice!', 'great post']);
  assert.deepStrictEqual(br.groups, ['https://www.facebook.com/groups/123']);

  // GET the branch back and confirm the arrays persisted in order.
  const got = await c.req('GET', `/api/branches/${br.id}`);
  assert.strictEqual(got.status, 200);
  assert.deepStrictEqual(got.body.branch.comments, ['nice!', 'great post']);
  assert.deepStrictEqual(got.body.branch.replies, ['thanks']);
  assert.deepStrictEqual(got.body.branch.dm_messages, ['hello there']);
});

test('GET a non-existent branch is 404', async () => {
  const c = await loginClient();
  const r = await c.req('GET', '/api/branches/999999');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.error.code, 'NOT_FOUND');
});

test('update a branch (columns + content arrays)', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'br-update');
  let token = await c.csrf();
  const created = await c.req('POST', `/api/accounts/${accountId}/branches`, {
    csrf: token,
    body: { name: 'b1', target_page_url: 'https://x.com/a', comments: ['old'] },
  });
  const branchId = created.body.branch.id;

  token = await c.csrf();
  const patched = await c.req('PATCH', `/api/branches/${branchId}`, {
    csrf: token,
    body: {
      check_interval_minutes: 30,
      enabled: false,
      comments: ['new1', 'new2'],
      daily_action_cap: null, // explicitly inherit the account ceiling
    },
  });
  assert.strictEqual(patched.status, 200);
  assert.strictEqual(patched.body.branch.check_interval_minutes, 30);
  assert.strictEqual(patched.body.branch.enabled, false);
  assert.strictEqual(patched.body.branch.daily_action_cap, null);
  assert.deepStrictEqual(patched.body.branch.comments, ['new1', 'new2'], 'arrays replaced wholesale');
});

test('update with an empty body is 422 (at least one field required)', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'br-empty-patch');
  let token = await c.csrf();
  const created = await c.req('POST', `/api/accounts/${accountId}/branches`, {
    csrf: token,
    body: { name: 'b' },
  });
  token = await c.csrf();
  const r = await c.req('PATCH', `/api/branches/${created.body.branch.id}`, {
    csrf: token,
    body: {},
  });
  assert.strictEqual(r.status, 422);
});

test('delete a non-default branch succeeds', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'br-delete');
  let token = await c.csrf();
  const created = await c.req('POST', `/api/accounts/${accountId}/branches`, {
    csrf: token,
    body: { name: 'to-delete' },
  });
  const branchId = created.body.branch.id;

  token = await c.csrf();
  const del = await c.req('DELETE', `/api/branches/${branchId}`, { csrf: token });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.body.ok, true);
  assert.strictEqual(del.body.id, branchId);

  const got = await c.req('GET', `/api/branches/${branchId}`);
  assert.strictEqual(got.status, 404, 'deleted branch is gone');
});

test('delete a non-existent branch is 404', async () => {
  const c = await loginClient();
  const token = await c.csrf();
  const r = await c.req('DELETE', '/api/branches/999999', { csrf: token });
  assert.strictEqual(r.status, 404);
});

// ── set-default + delete-default guard ────────────────────────────────────────

test('set-default promotes a branch and flips the prior default', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'br-default');
  let token = await c.csrf();
  const a = await c.req('POST', `/api/accounts/${accountId}/branches`, {
    csrf: token, body: { name: 'first', comments: ['c1'], replies: ['r1'] },
  });
  token = await c.csrf();
  const b = await c.req('POST', `/api/accounts/${accountId}/branches`, {
    csrf: token, body: { name: 'second' },
  });
  const firstId = a.body.branch.id;
  const secondId = b.body.branch.id;

  // Promote first → default. The set-default envelope is BranchWithChildren —
  // it must carry the content arrays (FIX 2: matches every other item endpoint).
  token = await c.csrf();
  const p1 = await c.req('POST', `/api/branches/${firstId}/default`, { csrf: token });
  assert.strictEqual(p1.status, 200);
  assert.strictEqual(p1.body.branch.is_default, true);
  assert.deepStrictEqual(p1.body.branch.comments, ['c1'], 'set-default returns content arrays');
  assert.deepStrictEqual(p1.body.branch.replies, ['r1'], 'set-default returns content arrays');
  for (const arr of ['comments', 'replies', 'dm_messages', 'groups']) {
    assert.ok(Array.isArray(p1.body.branch[arr]), `set-default branch has ${arr} array`);
  }

  // Promote second → default; first must lose default (one-default invariant).
  token = await c.csrf();
  const p2 = await c.req('POST', `/api/branches/${secondId}/default`, { csrf: token });
  assert.strictEqual(p2.status, 200);
  assert.strictEqual(p2.body.branch.is_default, true);

  const firstAfter = await c.req('GET', `/api/branches/${firstId}`);
  assert.strictEqual(firstAfter.body.branch.is_default, false, 'prior default demoted');

  // Exactly one default for the account.
  const list = await c.req('GET', `/api/accounts/${accountId}/branches`);
  const defaults = list.body.branches.filter((br) => br.is_default);
  assert.strictEqual(defaults.length, 1, 'exactly one default branch');
  assert.strictEqual(defaults[0].id, secondId);
});

test('deleting the DEFAULT branch is refused with 409 (guard)', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'br-delete-default');
  let token = await c.csrf();
  const created = await c.req('POST', `/api/accounts/${accountId}/branches`, {
    csrf: token, body: { name: 'the-default' },
  });
  const branchId = created.body.branch.id;

  // Make it the default, then attempt to delete it.
  token = await c.csrf();
  await c.req('POST', `/api/branches/${branchId}/default`, { csrf: token });

  token = await c.csrf();
  const del = await c.req('DELETE', `/api/branches/${branchId}`, { csrf: token });
  assert.strictEqual(del.status, 409, 'default branch delete must be a clean 409, not 500');
  assert.strictEqual(del.body.error.code, 'CONFLICT');
  assert.ok(/default branch/i.test(del.body.error.message), 'message explains the guard');

  // The branch still exists (the guard prevented the delete).
  const got = await c.req('GET', `/api/branches/${branchId}`);
  assert.strictEqual(got.status, 200, 'guarded branch survives');
});

// ── .strict trust boundary + uniqueness + XSS guard ───────────────────────────

test('branch create REJECTS unknown keys (db.js trust boundary)', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'br-strict');
  const token = await c.csrf();
  const r = await c.req('POST', `/api/accounts/${accountId}/branches`, {
    csrf: token,
    body: { name: 'b', injected_column: 'DROP TABLE branches' },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.body.error.code, 'VALIDATION_ERROR');
  assert.ok(
    r.body.error.details.some((d) => /injected_column/i.test(d.message)),
    'unknown key must be reported'
  );
});

test('branch create REJECTS the non-writable account_id / is_default keys', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'br-nonwritable');
  for (const evil of [{ account_id: 1 }, { is_default: true }, { id: 5 }]) {
    const token = await c.csrf();
    const r = await c.req('POST', `/api/accounts/${accountId}/branches`, {
      csrf: token,
      body: { name: 'b', ...evil },
    });
    assert.strictEqual(r.status, 422, `${JSON.stringify(evil)} must be rejected`);
    assert.strictEqual(r.body.error.code, 'VALIDATION_ERROR');
  }
});

test('branch URL fields reject non-http(s) schemes (stored-XSS defense)', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'br-xss');
  const cases = [
    { target_page_url: 'javascript:alert(1)' },
    { target_page_url: 'https://ok.com', own_profile_url: 'javascript:alert(2)' },
    { target_page_url: 'https://ok.com', dm_as_page_url: 'data:text/html,<script>1</script>' },
    { target_page_url: 'https://ok.com', groups: ['javascript:alert(3)'] },
  ];
  for (const field of cases) {
    const token = await c.csrf();
    const r = await c.req('POST', `/api/accounts/${accountId}/branches`, {
      csrf: token, body: { name: `b-${Math.random()}`, ...field },
    });
    assert.strictEqual(r.status, 422, `expected 422 for ${JSON.stringify(field)}`);
    assert.strictEqual(r.body.error.code, 'VALIDATION_ERROR');
  }

  // Control: clean https on every URL field is accepted (refine isn't over-broad).
  const token = await c.csrf();
  const ok = await c.req('POST', `/api/accounts/${accountId}/branches`, {
    csrf: token,
    body: {
      name: 'b-clean',
      target_page_url: 'https://www.facebook.com/p',
      own_profile_url: 'http://example.com/me',
      groups: ['https://www.facebook.com/groups/1'],
    },
  });
  assert.strictEqual(ok.status, 201, 'clean https URLs must still be accepted');
});

test('duplicate branch name within the SAME account is 409; across accounts is OK', async () => {
  const c = await loginClient();
  const acctA = await createAccount(c, 'br-dup-a');
  const acctB = await createAccount(c, 'br-dup-b');

  let token = await c.csrf();
  const first = await c.req('POST', `/api/accounts/${acctA}/branches`, {
    csrf: token, body: { name: 'shared-name' },
  });
  assert.strictEqual(first.status, 201);

  // Same name, same account → 409.
  token = await c.csrf();
  const dup = await c.req('POST', `/api/accounts/${acctA}/branches`, {
    csrf: token, body: { name: 'shared-name' },
  });
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(dup.body.error.code, 'CONFLICT');

  // Same name, DIFFERENT account → allowed.
  token = await c.csrf();
  const other = await c.req('POST', `/api/accounts/${acctB}/branches`, {
    csrf: token, body: { name: 'shared-name' },
  });
  assert.strictEqual(other.status, 201, 'name is unique per account, not globally');
});

// ── auth + CSRF parity ────────────────────────────────────────────────────────

test('branch mutation without CSRF is 403; reads need only auth', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'br-csrf');
  // Mutation with no CSRF token header → 403.
  const noCsrf = await c.req('POST', `/api/accounts/${accountId}/branches`, {
    body: { name: 'nope' },
  });
  assert.strictEqual(noCsrf.status, 403);

  // Reads do not require CSRF.
  const read = await c.req('GET', `/api/accounts/${accountId}/branches`);
  assert.strictEqual(read.status, 200);
});

test('unauthenticated branch access is 401', async () => {
  const c = makeClient(); // no login
  const r = await c.req('GET', '/api/branches/1');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.error.code, 'UNAUTHORIZED');
});

test('branch serializer never returns a secret and exposes read-only account_id/is_default', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'br-noleak');
  const token = await c.csrf();
  const created = await c.req('POST', `/api/accounts/${accountId}/branches`, {
    csrf: token, body: { name: 'b', target_page_url: 'https://x.com' },
  });
  const serialized = JSON.stringify(created.body);
  assert.ok(!/password|_enc|secret/i.test(serialized), 'no secret-shaped field on a branch');
  assert.ok('account_id' in created.body.branch, 'account_id exposed (read-only)');
  assert.ok('is_default' in created.body.branch, 'is_default exposed (read-only)');
});

// ── GET /api/status: per-branch status + account rollup (re-keyed from v1) ─────

test('GET /api/status groups per-branch status under accounts with a worst-case rollup', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'st-rollup');
  let token = await c.csrf();
  const healthy = await c.req('POST', `/api/accounts/${accountId}/branches`, {
    csrf: token, body: { name: 'healthy' },
  });
  token = await c.csrf();
  const failing = await c.req('POST', `/api/accounts/${accountId}/branches`, {
    csrf: token, body: { name: 'failing' },
  });
  const healthyId = healthy.body.branch.id;
  const failingId = failing.body.branch.id;

  // Worker writes per-branch status (now branch-keyed). 'error' bumps last_cycle_at.
  db.setBranchStatus(healthyId, 'ok', 'cycle complete');
  db.setBranchStatus(failingId, 'error', 'login checkpoint');

  const r = await c.req('GET', '/api/status');
  assert.strictEqual(r.status, 200);
  const acct = r.body.accounts.find((a) => a.id === accountId);
  assert.ok(acct, 'account present in status payload');

  // Account rollup: worst-case wins so the failing branch surfaces, never masked.
  assert.strictEqual(acct.last_status, 'error', 'rollup surfaces the failing branch');
  assert.strictEqual(acct.branch_count, 2);

  const byName = Object.fromEntries(acct.branches.map((b) => [b.name, b]));
  assert.strictEqual(byName.healthy.last_status, 'ok');
  assert.strictEqual(byName.healthy.last_detail, 'cycle complete');
  assert.strictEqual(byName.failing.last_status, 'error');
  assert.ok(
    typeof byName.failing.last_cycle_at === 'string' && byName.failing.last_cycle_at.length > 0,
    'error bumps last_cycle_at to a timestamp'
  );

  // Allowlist discipline: each branch entry exposes EXACTLY the intended keys.
  const expectedBranchKeys = [
    'id', 'name', 'is_default', 'enabled', 'actions_today',
    'last_status', 'last_detail', 'last_cycle_at',
  ].sort();
  assert.deepStrictEqual(
    Object.keys(byName.healthy).sort(), expectedBranchKeys,
    'per-branch status keys are exactly the allowlist'
  );
});

test('GET /api/status: an account with zero branches rolls up to idle, empty branches', async () => {
  const c = await loginClient();
  const accountId = await createAccount(c, 'st-empty');
  const r = await c.req('GET', '/api/status');
  assert.strictEqual(r.status, 200);
  const acct = r.body.accounts.find((a) => a.id === accountId);
  assert.ok(acct, 'account present');
  assert.strictEqual(acct.last_status, 'idle', 'no branches → idle rollup');
  assert.strictEqual(acct.branch_count, 0);
  assert.deepStrictEqual(acct.branches, []);
});
