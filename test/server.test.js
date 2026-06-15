'use strict';

/* global fetch */
// `fetch` is a Node 18+ global; declared here because the shared eslint config
// (eslint.config.js) does not list it among Node globals.

/**
 * test/server.test.js — control-plane API tests (node:test).
 *
 * Drives the Express app in-process (no port bind) via Node's built-in fetch
 * against a real ephemeral http.Server on an OS-assigned port, with a real
 * temp SQLite DB. No mocks of db.js/crypto — we exercise the genuine stack so a
 * broken migration / encryption path fails the test (the project's policy).
 *
 * Covers: auth required, CSRF required + valid flow, validation rejects bad input
 * and unknown keys (the db.js dynamic-column trust boundary), secret never
 * returned, settings update, worker desired-state write.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Point everything at a temp DB + valid config BEFORE requiring app code.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbcp-'));
process.env.DB_PATH = path.join(TMP_DIR, 'cp-test.db');
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

// Fake worker-control so tests never connect to a live pm2 daemon (which would
// hang the runner and pollute the environment). Records calls for assertions.
const fakeWorkerControl = {
  calls: [],
  async start() {
    this.calls.push('start');
    return { action: 'started', status: 'online' };
  },
  async stop() {
    this.calls.push('stop');
    return { action: 'stopped', status: 'stopped' };
  },
  async status() {
    this.calls.push('status');
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

// ── Tiny cookie-aware client ──────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────────────

test('healthz is public', async () => {
  const c = makeClient();
  const r = await c.req('GET', '/healthz');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
});

test('unauthenticated API access is 401', async () => {
  const c = makeClient();
  const r = await c.req('GET', '/api/accounts');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.error.code, 'UNAUTHORIZED');
});

test('login without CSRF token is 403', async () => {
  const c = makeClient();
  await c.csrf(); // establishes session cookie but we omit the token header
  const r = await c.req('POST', '/api/auth/login', {
    body: { username: 'admin', password: ADMIN_PASSWORD },
  });
  assert.strictEqual(r.status, 403);
});

test('login with wrong password is 401 (uniform message)', async () => {
  const c = makeClient();
  const token = await c.csrf();
  const r = await c.req('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'nope' },
    csrf: token,
  });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.error.code, 'UNAUTHORIZED');
});

test('full login flow then authed read', async () => {
  const c = await loginClient();
  const me = await c.req('GET', '/api/auth/me');
  assert.strictEqual(me.body.authenticated, true);
  const list = await c.req('GET', '/api/accounts');
  assert.strictEqual(list.status, 200);
  assert.ok(Array.isArray(list.body.accounts));
});

test('create account encrypts secret and never returns it', async () => {
  const c = await loginClient();
  const token = await c.csrf();
  const r = await c.req('POST', '/api/accounts', {
    csrf: token,
    body: {
      name: 'unitAcct',
      email: 'unit@example.com',
      password: 'PlaintextSecret!',
      session_file: 'sessions/unitAcct.json',
      target_page_url: 'https://www.facebook.com/p',
      comments: ['hi', 'there'],
    },
  });
  assert.strictEqual(r.status, 201);
  const acct = r.body.account;
  assert.strictEqual(acct.has_password, true);
  assert.deepStrictEqual(acct.comments, ['hi', 'there']);
  // No secret in the serialized response, in any form.
  const serialized = JSON.stringify(r.body);
  assert.ok(!serialized.includes('PlaintextSecret'), 'plaintext must not leak');
  assert.ok(!serialized.includes('password_enc'), 'ciphertext field must not leak');

  // And the ciphertext in the DB actually decrypts back (encryption is real).
  const row = db.getAccountById(acct.id);
  const { decrypt } = require('../crypto');
  assert.strictEqual(decrypt(row.password_enc), 'PlaintextSecret!');
});

test('validation rejects unknown keys (db.js trust boundary)', async () => {
  const c = await loginClient();
  const token = await c.csrf();
  const r = await c.req('POST', '/api/accounts', {
    csrf: token,
    body: {
      name: 'x',
      email: 'x@e.com',
      session_file: 's',
      target_page_url: 'https://x.com',
      injected_column: 'DROP TABLE accounts',
    },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.body.error.code, 'VALIDATION_ERROR');
  assert.ok(
    r.body.error.details.some((d) => /injected_column/i.test(d.message)),
    'unknown key must be reported'
  );
});

test('validation rejects bad email', async () => {
  const c = await loginClient();
  const token = await c.csrf();
  const r = await c.req('POST', '/api/accounts', {
    csrf: token,
    body: { name: 'y', email: 'not-email', session_file: 's', target_page_url: 'https://x.com' },
  });
  assert.strictEqual(r.status, 422);
});

test('validation rejects a non-http(s) URL scheme (stored-XSS defense)', async () => {
  const c = await loginClient();
  // A javascript: URL parses as a valid URL (zod .url() accepts it) but must be
  // rejected by the http(s)-scheme refine — it would otherwise render into an
  // <a href> in the UI and execute on click. Cover each URL field + the array.
  const cases = [
    { field: { target_page_url: 'javascript:alert(1)' }, base: { name: 'xss1', email: 'a@e.com', session_file: 's' } },
    { field: { target_page_url: 'https://ok.com', own_profile_url: 'javascript:alert(2)' }, base: { name: 'xss2', email: 'a@e.com', session_file: 's' } },
    { field: { target_page_url: 'https://ok.com', dm_as_page_url: 'data:text/html,<script>1</script>' }, base: { name: 'xss3', email: 'a@e.com', session_file: 's' } },
    { field: { target_page_url: 'https://ok.com', groups: ['javascript:alert(3)'] }, base: { name: 'xss4', email: 'a@e.com', session_file: 's' } },
  ];
  for (const { field, base } of cases) {
    const token = await c.csrf();
    const r = await c.req('POST', '/api/accounts', { csrf: token, body: { ...base, ...field } });
    assert.strictEqual(r.status, 422, `expected 422 for ${JSON.stringify(field)}`);
    assert.strictEqual(r.body.error.code, 'VALIDATION_ERROR');
  }

  // Control: a clean https URL on every field is accepted (the refine is not
  // over-broad — it rejects only dangerous schemes, not valid http(s)).
  const token = await c.csrf();
  const ok = await c.req('POST', '/api/accounts', {
    csrf: token,
    body: {
      name: 'xss-ok',
      email: 'a@e.com',
      session_file: 's',
      target_page_url: 'https://www.facebook.com/p',
      own_profile_url: 'http://example.com/me',
      groups: ['https://www.facebook.com/groups/1'],
    },
  });
  assert.strictEqual(ok.status, 201, 'clean https URLs must still be accepted');
});

test('duplicate account name is 409', async () => {
  const c = await loginClient();
  let token = await c.csrf();
  await c.req('POST', '/api/accounts', {
    csrf: token,
    body: { name: 'dup', email: 'a@e.com', session_file: 's', target_page_url: 'https://x.com' },
  });
  token = await c.csrf();
  const r = await c.req('POST', '/api/accounts', {
    csrf: token,
    body: { name: 'dup', email: 'b@e.com', session_file: 's2', target_page_url: 'https://y.com' },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error.code, 'CONFLICT');
});

test('settings get + update with cross-field validation', async () => {
  const c = await loginClient();
  const get = await c.req('GET', '/api/settings');
  assert.strictEqual(get.status, 200);
  assert.ok('pacing_enabled' in get.body.settings);

  let token = await c.csrf();
  const ok = await c.req('PATCH', '/api/settings', {
    csrf: token,
    body: { global_daily_action_cap: 123, min_action_ms: 1000, max_action_ms: 2000 },
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.settings.global_daily_action_cap, 123);

  token = await c.csrf();
  const bad = await c.req('PATCH', '/api/settings', {
    csrf: token,
    body: { min_action_ms: 9000, max_action_ms: 1000 },
  });
  assert.strictEqual(bad.status, 422, 'min>max must be rejected');
});

test('worker start writes desired_state=running and invokes mechanism', async () => {
  const c = await loginClient();
  const token = await c.csrf();
  const r = await c.req('POST', '/api/worker/start', { csrf: token });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.desired_state, 'running');
  assert.strictEqual(db.getWorkerState().desired_state, 'running', 'intent recorded in DB');
  assert.ok(fakeWorkerControl.calls.includes('start'), 'mechanism (pm2) invoked');
});

test('worker start returns the UNIFIED status shape (matches GET /status) + action', async () => {
  const c = await loginClient();
  const token = await c.csrf();
  const start = await c.req('POST', '/api/worker/start', { csrf: token });
  assert.strictEqual(start.status, 200);
  // Idempotency action enum is layered ON TOP of the canonical shape.
  assert.ok(['started', 'restarted'].includes(start.body.action), 'start action enum present');

  const status = await c.req('GET', '/api/worker/status');
  assert.strictEqual(status.status, 200);
  // The canonical status keys must be IDENTICAL across both endpoints (HIGH-2):
  // the UI builds one status component for both.
  const canonical = ['desired_state', 'reported_status', 'detail', 'heartbeat', 'process', 'updated_at'];
  for (const k of canonical) {
    assert.ok(k in start.body, `start response includes "${k}"`);
    assert.ok(k in status.body, `status response includes "${k}"`);
  }
  assert.deepStrictEqual(
    Object.keys(status.body).sort(),
    canonical.slice().sort(),
    'GET /status returns exactly the canonical keys'
  );
});

test('worker stop writes desired_state=stopped and invokes mechanism', async () => {
  const c = await loginClient();
  const token = await c.csrf();
  const r = await c.req('POST', '/api/worker/stop', { csrf: token });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.desired_state, 'stopped');
  // Intent is written FIRST, so the DB reflects 'stopped' regardless of mechanism.
  assert.strictEqual(db.getWorkerState().desired_state, 'stopped');
});

test('worker status combines DB intent + heartbeat + process view', async () => {
  const c = await loginClient();
  const r = await c.req('GET', '/api/worker/status');
  assert.strictEqual(r.status, 200);
  assert.ok('desired_state' in r.body);
  assert.ok('heartbeat' in r.body);
  assert.ok('process' in r.body);
});

test('oversized body is 413, not 500', async () => {
  const c = await loginClient();
  const token = await c.csrf();
  const r = await c.req('POST', '/api/accounts', {
    csrf: token,
    body: {
      name: 'big',
      email: 'a@e.com',
      session_file: 's',
      target_page_url: 'https://x.com',
      user_agent: 'A'.repeat(300000),
    },
  });
  assert.strictEqual(r.status, 413);
  assert.strictEqual(r.body.error.code, 'PAYLOAD_TOO_LARGE');
});

test('logout then access is blocked', async () => {
  const c = await loginClient();
  const token = await c.csrf();
  const out = await c.req('POST', '/api/auth/logout', { csrf: token });
  assert.strictEqual(out.status, 200);
  const after = await c.req('GET', '/api/accounts');
  assert.strictEqual(after.status, 401);
});

test('csrf endpoint returns snake_case csrf_token (boundary consistency)', async () => {
  const c = makeClient();
  const r = await c.req('GET', '/api/auth/csrf');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(typeof r.body.csrf_token, 'string');
  assert.ok(r.body.csrf_token.length > 0, 'token is non-empty');
  assert.ok(!('csrfToken' in r.body), 'legacy camelCase field is gone');
});

test('settings response is an explicit allowlist (no schema passthrough)', async () => {
  const c = await loginClient();
  const r = await c.req('GET', '/api/settings');
  assert.strictEqual(r.status, 200);
  const { SETTINGS_PUBLIC_FIELDS } = require('../server/serializers');
  const keys = Object.keys(r.body.settings).sort();
  assert.deepStrictEqual(
    keys,
    SETTINGS_PUBLIC_FIELDS.slice().sort(),
    'settings keys are exactly the allowlist'
  );
  // The singleton id is intentionally not exposed.
  assert.ok(!('id' in r.body.settings), 'singleton id not exposed');
  // Booleans are coerced to real booleans, not 0/1.
  assert.strictEqual(typeof r.body.settings.pacing_enabled, 'boolean');
});

test('status/events returns pagination metadata and cursor-pages older rows', async () => {
  const c = await loginClient();

  // Seed enough action_log rows to force a second page.
  for (let i = 0; i < 5; i += 1) {
    db.logAction({ actionType: 'monitor', status: 'ok', detail: `evt-${i}` });
  }

  const page1 = await c.req('GET', '/api/status/events?limit=2');
  assert.strictEqual(page1.status, 200);
  // Contract: events + total + has_more + next_before.
  assert.ok(Array.isArray(page1.body.events));
  assert.strictEqual(page1.body.events.length, 2, 'limit respected');
  assert.strictEqual(typeof page1.body.total, 'number');
  assert.ok(page1.body.total >= 5, 'total counts the whole feed, not the page');
  assert.strictEqual(page1.body.has_more, true, 'more rows exist beyond page 1');
  assert.strictEqual(typeof page1.body.next_before, 'number', 'cursor provided');
  // Newest first (DESC by id).
  assert.ok(page1.body.events[0].id > page1.body.events[1].id, 'newest first');

  // Page older via the cursor.
  const page2 = await c.req(
    'GET',
    `/api/status/events?limit=2&before=${page1.body.next_before}`
  );
  assert.strictEqual(page2.status, 200);
  assert.ok(
    page2.body.events.every((e) => e.id < page1.body.next_before),
    'page 2 rows are strictly older than the cursor'
  );
});

test('status/events rejects an out-of-range limit (max 500)', async () => {
  const c = await loginClient();
  const r = await c.req('GET', '/api/status/events?limit=501');
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.body.error.code, 'VALIDATION_ERROR');
});

// obs #3: GET /api/status must surface the per-account account_status masking-fix
// (last_status/last_detail/last_cycle_at), otherwise a single failing account is
// invisible behind the single global worker_state row.
test('GET /api/status surfaces per-account status (account_status masking-fix)', async () => {
  const c = await loginClient();
  const token = await c.csrf();

  // Create two accounts: one that has "run" (error) and one that never ran.
  const failing = await c.req('POST', '/api/accounts', {
    csrf: token,
    body: {
      name: 'status-failing',
      email: 'f@e.com',
      session_file: 'sf',
      target_page_url: 'https://x.com/p',
    },
  });
  assert.strictEqual(failing.status, 201, 'failing account created');
  const freshAcct = await c.req('POST', '/api/accounts', {
    csrf: token,
    body: {
      name: 'status-fresh',
      email: 'n@e.com',
      session_file: 'sn',
      target_page_url: 'https://x.com/q',
    },
  });
  assert.strictEqual(freshAcct.status, 201, 'fresh account created');

  // Write a per-account terminal status for the failing one (worker writes these).
  // 'error' bumps last_cycle_at; the fresh account stays without an account_status row.
  db.setAccountStatus(failing.body.account.id, 'error', 'login checkpoint');

  const r = await c.req('GET', '/api/status');
  assert.strictEqual(r.status, 200);
  const byName = Object.fromEntries(r.body.accounts.map((a) => [a.name, a]));

  // The account that ran surfaces its real last status + detail + cycle timestamp.
  const f = byName['status-failing'];
  assert.ok(f, 'failing account present in status payload');
  assert.strictEqual(f.last_status, 'error', 'failing account surfaces last_status=error');
  assert.strictEqual(f.last_detail, 'login checkpoint', 'failing account surfaces last_detail');
  assert.ok(typeof f.last_cycle_at === 'string' && f.last_cycle_at.length > 0,
    'error bumps last_cycle_at to a timestamp');

  // The never-run account surfaces the safe defaults, never undefined/missing keys.
  const n = byName['status-fresh'];
  assert.ok(n, 'fresh account present in status payload');
  assert.strictEqual(n.last_status, 'idle', 'never-run account defaults to idle');
  assert.strictEqual(n.last_detail, null, 'never-run account has null detail');
  assert.strictEqual(n.last_cycle_at, null, 'never-run account has null last_cycle_at');

  // Allowlist discipline: every per-account entry exposes EXACTLY the intended keys
  // (no secret/internal column leaks via a future account_status passthrough).
  const expectedKeys = [
    'id', 'name', 'enabled', 'actions_today', 'last_status', 'last_detail', 'last_cycle_at',
  ].sort();
  assert.deepStrictEqual(Object.keys(f).sort(), expectedKeys, 'per-account keys are exactly the allowlist');
});

test('loadConfig REJECTS a non-loopback CONTROL_HOST (INFO-1)', () => {
  const base = {
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD_HASH: '$2b$12$B9mJy4Uiav/xsFpSuYnTy.MuGjT6xa1oJm3RMrMS0n6UrHNIHYdOy',
    SESSION_SECRET: 's'.repeat(48),
    CSRF_SECRET: 'c'.repeat(48),
  };
  // A public bind must abort startup.
  assert.throws(
    () => loadConfig({ ...base, CONTROL_HOST: '0.0.0.0' }),
    /CONTROL_HOST must be loopback only/,
    '0.0.0.0 must be rejected'
  );
  assert.throws(
    () => loadConfig({ ...base, CONTROL_HOST: '10.0.0.5' }),
    /loopback only/,
    'a LAN IP must be rejected'
  );
  // Loopback values must be accepted.
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    const cfg = loadConfig({ ...base, CONTROL_HOST: host });
    assert.strictEqual(cfg.host, host, `${host} accepted`);
  }
});
