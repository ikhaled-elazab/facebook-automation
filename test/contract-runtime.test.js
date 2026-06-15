'use strict';

/* global fetch */
// `fetch` is a Node 18+ global; declared here because the shared eslint config
// (eslint.config.js) does not list it among Node globals (same as the other
// server-driven suites: server.test.js / branches.test.js / login.test.js).

/**
 * test/contract-runtime.test.js — RUNTIME contract-assertion guard for the
 * untyped-JS-server ↔ typed-TS-client boundary (typescript-expert raised this
 * gate twice).
 *
 * WHY THIS EXISTS (and how it differs from contract.test.js):
 *   contract.test.js parses the TS interfaces out of web/src/api/types.ts and
 *   asserts every TS-declared field is PRESENT in the live response — a one-way
 *   "server is not MISSING a field" check. It does NOT catch the other drift
 *   direction: the server adding/leaking an EXTRA key the TS type never declared
 *   (e.g. a future serializer column, or a secret-shaped field). `tsc` cannot
 *   catch that either — the server is plain JS, so an extra runtime key is
 *   invisible to the type-checker until it surfaces as an unexpected field in the
 *   browser.
 *
 *   This suite closes that gap with EXACT-KEY assertions: it drives the REAL
 *   endpoints (real Express app, real temp SQLite — the established harness) and
 *   asserts the SERIALIZED JSON keys of each endpoint EXACTLY equal the documented
 *   contract via deepStrictEqual on the sorted key set. An added key (leak) OR a
 *   removed key (drift) fails — both directions, at the serialization boundary,
 *   which is precisely what tsc cannot see.
 *
 *   Pattern extended from branches.test.js:619-626 (the per-branch status exact-key
 *   assertion) to: account (list + get-one, incl. branch_count), branch
 *   (serializeBranch list-shape vs serializeBranchWithChildren item-shape), status
 *   (per-account superset + per-branch superset), and the login envelope
 *   ({ login: LoginSessionView }).
 *
 * HARD CONSTRAINTS honored: temp DB only (DB_PATH); node:test; no real Facebook
 * (the login envelope is asserted via an injected fake login-control, like
 * login.test.js); the genuine db.js + serializers stack is exercised.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Temp DB + valid config BEFORE requiring app code (mirrors server.test.js).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbcontract-rt-'));
process.env.DB_PATH = path.join(TMP_DIR, 'cp-test.db');
process.env.ADMIN_USER = 'admin';
// bcrypt hash of 'TestAdmin#Pass123' (cost 12) — same fixture as server.test.js.
process.env.ADMIN_PASSWORD_HASH = '$2b$12$B9mJy4Uiav/xsFpSuYnTy.MuGjT6xa1oJm3RMrMS0n6UrHNIHYdOy';
process.env.SESSION_SECRET = 's'.repeat(48);
process.env.CSRF_SECRET = 'c'.repeat(48);
process.env.APP_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.NODE_ENV = 'development';

const { loadConfig } = require('../server/config');
const { createApp } = require('../server/app');
const db = require('../db');

const ADMIN_PASSWORD = 'TestAdmin#Pass123';

let server;
let baseUrl;

const fakeWorkerControl = {
  async start() { return { action: 'started', status: 'online' }; },
  async stop() { return { action: 'stopped', status: 'stopped' }; },
  async status() { return { present: false, status: 'stopped', pid: null, uptime: null, restarts: null, cpu: null, memory: null }; },
};

// A fake login-control that returns a FULLY-POPULATED public session view so the
// envelope's exact key set is asserted (account_name/status/detail/started_at/
// finished_at). Mirrors server/login-control.js toPublic() — the contract source.
function makeFakeLoginControl() {
  const { NotFoundError } = require('../server/errors');
  return {
    launch(id) {
      const acct = db.getAccountById(id);
      if (!acct) throw new NotFoundError('Account not found');
      return {
        account_name: acct.name,
        status: 'needs_2fa',
        detail: '2FA detected',
        started_at: Date.now(),
        finished_at: null,
      };
    },
    status(id) {
      const acct = db.getAccountById(id);
      if (!acct) throw new NotFoundError('Account not found');
      return {
        account_name: acct.name,
        status: 'idle',
        detail: null,
        started_at: null,
        finished_at: null,
      };
    },
    provide2fa() { throw new NotFoundError('No login session for this account.'); },
    async abortAll() {},
  };
}

// ── Cookie-aware client (mirrors server.test.js) ──────────────────────────────

function makeClient() {
  const cookies = new Map();
  const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
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
    const text = await res.text();
    let json = null;
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
  assert.strictEqual(r.status, 200, 'admin login should succeed');
  return c;
}

/** assert the sorted key set of `obj` EXACTLY equals `expected` (both directions). */
function assertExactKeys(obj, expected, label) {
  assert.ok(obj && typeof obj === 'object', `${label}: object present`);
  assert.deepStrictEqual(
    Object.keys(obj).sort(),
    expected.slice().sort(),
    `${label}: serialized keys must EXACTLY equal the contract (no missing, no extra)`
  );
}

// ── The documented contracts (mirror types.ts + serializers.js EXACTLY) ───────

// Account = serializeAccount allowlist + has_password/has_proxy_password + branch_count.
const ACCOUNT_KEYS = [
  'id', 'name', 'email', 'session_file', 'user_agent', 'locale', 'timezone_id',
  'proxy_server', 'proxy_username', 'daily_action_cap', 'created_at', 'updated_at',
  'enabled', 'has_password', 'has_proxy_password', 'branch_count',
];

// Branch (list shape) = serializeBranch allowlist (NO child arrays).
const BRANCH_LIST_KEYS = [
  'id', 'account_id', 'name', 'target_page_url', 'own_profile_url', 'dm_as_page_url',
  'check_interval_minutes', 'daily_action_cap', 'created_at', 'updated_at',
  'is_default', 'send_dm_to_commenters', 'enabled',
];

// Branch (item shape) = serializeBranchWithChildren = list shape + the 4 child arrays.
const BRANCH_ITEM_KEYS = [...BRANCH_LIST_KEYS, 'comments', 'replies', 'dm_messages', 'groups'];

// StatusAccountSummary (per-account rollup) — status.js perAccount mapping.
const STATUS_ACCOUNT_KEYS = [
  'id', 'name', 'enabled', 'actions_today', 'last_status', 'branch_count', 'branches',
];

// StatusBranchSummary (per-branch drill-down) — status.js branchesByAccount mapping.
const STATUS_BRANCH_KEYS = [
  'id', 'name', 'is_default', 'enabled', 'actions_today', 'last_status', 'last_detail', 'last_cycle_at',
];

// LoginSessionView — LoginSession.toPublic() / the login envelope's `login` value.
const LOGIN_VIEW_KEYS = ['account_name', 'status', 'detail', 'started_at', 'finished_at'];

let createdAccountId;
let createdBranchId;

before(async () => {
  db.getDb();
  const app = createApp(loadConfig(), {
    logger: { warn() {}, error() {} },
    workerControl: fakeWorkerControl,
    loginControl: makeFakeLoginControl(),
  });
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Seed an account + a branch (with content) through the REAL routes so every
  // serializer path below runs against genuinely-created rows.
  const c = await loginClient();
  let token = await c.csrf();
  const acct = await c.req('POST', '/api/accounts', {
    csrf: token,
    body: { name: 'ct-acct', email: 'ct@e.com', session_file: 's', password: 'P!' },
  });
  assert.strictEqual(acct.status, 201, 'seed account created');
  createdAccountId = acct.body.account.id;

  token = await c.csrf();
  const branch = await c.req('POST', `/api/accounts/${createdAccountId}/branches`, {
    csrf: token,
    body: { name: 'ct-branch', target_page_url: 'https://fb.com/p', comments: ['hi'] },
  });
  assert.strictEqual(branch.status, 201, 'seed branch created');
  createdBranchId = branch.body.branch.id;

  // Give the branch a status row so the status drill-down has a populated entry.
  db.setBranchStatus(createdBranchId, 'ok', 'cycle complete');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── Account: list + get-one exact keys (incl. branch_count) ───────────────────

test('contract: GET /api/accounts list items serialize EXACTLY the Account contract', async () => {
  const c = await loginClient();
  const r = await c.req('GET', '/api/accounts');
  assert.strictEqual(r.status, 200);
  const entry = r.body.accounts.find((a) => a.id === createdAccountId);
  assert.ok(entry, 'seeded account present in list');
  assertExactKeys(entry, ACCOUNT_KEYS, 'Account (list)');
  // Spot the drift-prone derived field that tsc cannot enforce on a JS server.
  assert.strictEqual(typeof entry.branch_count, 'number', 'branch_count is a number');
});

test('contract: GET /api/accounts/:id get-one serializes EXACTLY the Account contract', async () => {
  const c = await loginClient();
  const r = await c.req('GET', `/api/accounts/${createdAccountId}`);
  assert.strictEqual(r.status, 200);
  assertExactKeys(r.body.account, ACCOUNT_KEYS, 'Account (get-one)');
});

// ── Branch: list shape vs item shape (children only on the item endpoint) ─────

test('contract: branch LIST items serialize EXACTLY the Branch (no-children) contract', async () => {
  const c = await loginClient();
  const r = await c.req('GET', `/api/accounts/${createdAccountId}/branches`);
  assert.strictEqual(r.status, 200);
  const entry = r.body.branches.find((b) => b.id === createdBranchId);
  assert.ok(entry, 'seeded branch present in list');
  assertExactKeys(entry, BRANCH_LIST_KEYS, 'Branch (list — serializeBranch)');
});

test('contract: branch GET-one serializes EXACTLY the BranchWithChildren contract', async () => {
  const c = await loginClient();
  const r = await c.req('GET', `/api/branches/${createdBranchId}`);
  assert.strictEqual(r.status, 200);
  assertExactKeys(r.body.branch, BRANCH_ITEM_KEYS, 'Branch (item — serializeBranchWithChildren)');
});

// ── Status: per-account rollup superset + per-branch drill-down superset ──────

test('contract: GET /api/status per-account + per-branch entries serialize EXACTLY their contracts', async () => {
  const c = await loginClient();
  const r = await c.req('GET', '/api/status');
  assert.strictEqual(r.status, 200);
  const acct = r.body.accounts.find((a) => a.id === createdAccountId);
  assert.ok(acct, 'seeded account present in status payload');
  assertExactKeys(acct, STATUS_ACCOUNT_KEYS, 'StatusAccountSummary');

  const branch = acct.branches.find((b) => b.id === createdBranchId);
  assert.ok(branch, 'seeded branch present in status drill-down');
  assertExactKeys(branch, STATUS_BRANCH_KEYS, 'StatusBranchSummary');
});

// ── Login envelope: { login: LoginSessionView } exact keys (both wrapper + view) ─

test('contract: login launch/status envelopes serialize EXACTLY { login: LoginSessionView }', async () => {
  const c = await loginClient();

  // Launch (202) — { login: <view> }.
  const token = await c.csrf();
  const launch = await c.req('POST', `/api/accounts/${createdAccountId}/login`, { csrf: token });
  assert.strictEqual(launch.status, 202);
  assertExactKeys(launch.body, ['login'], 'LoginEnvelope (launch wrapper)');
  assertExactKeys(launch.body.login, LOGIN_VIEW_KEYS, 'LoginSessionView (launch)');
  assert.strictEqual(launch.body.login.account_name, 'ct-acct', 'view names the account');

  // Status (200) — same envelope shape.
  const status = await c.req('GET', `/api/accounts/${createdAccountId}/login/status`);
  assert.strictEqual(status.status, 200);
  assertExactKeys(status.body, ['login'], 'LoginEnvelope (status wrapper)');
  assertExactKeys(status.body.login, LOGIN_VIEW_KEYS, 'LoginSessionView (status)');

  // The view must never carry a secret-shaped field (defense in depth at the boundary).
  const serialized = JSON.stringify(status.body);
  assert.ok(!/password|_enc|secret/i.test(serialized), 'login envelope carries no secret-shaped field');
});
