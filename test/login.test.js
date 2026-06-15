'use strict';

/* global fetch */
// `fetch` is a Node 18+ global; declared here because the shared eslint config
// (eslint.config.js) does not list it among Node globals (same as branches.test.js).

/**
 * test/login.test.js — Phase 3.5 DB+UI-driven login tests (node:test).
 *
 * SECURITY-CRITICAL SURFACE — these tests assert the login decrypts stored
 * credentials, runs a RESUMABLE state machine, exposes a clean control-plane
 * contract, and NEVER leaks/logs/persists plaintext secrets.
 *
 * HARD CONSTRAINTS honored:
 *   - Temp DB only (DB_PATH) — never the live db/fb-bot.db.
 *   - node:test runner (not jest/vitest).
 *   - NO real Facebook: a fake browser/page driver steers the LoginSession state
 *     machine (idle→running→needs_2fa→running→ok|failed) with no network to FB.
 *   - The genuine db.js + crypto.js stack is exercised (no mocks of those) so the
 *     encrypt→store→load→decrypt round-trip is really proven.
 *
 * Covers:
 *   1. DB-backed account load + crypto.decrypt round-trip (store password_enc, the
 *      flow reads + decrypts it and fills it into the form).
 *   2. State-machine transitions: idle→running→needs_2fa→running→ok, and →failed.
 *   3. login-control routes: auth (401), CSRF (403), 409 concurrent launch,
 *      202 launch, status, 2fa-accept, and missing/undecryptable-credential 400.
 *   4. NO plaintext password is logged or persisted (only the storageState file is
 *      written; it must not contain the plaintext password; no log line contains it).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Point everything at a temp DB + valid config BEFORE requiring app code.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbcp-login-'));
process.env.DB_PATH = path.join(TMP_DIR, 'cp-login-test.db');
process.env.ADMIN_USER = 'admin';
// bcrypt hash of 'TestAdmin#Pass123' (cost 12) — same fixture as branches.test.js.
process.env.ADMIN_PASSWORD_HASH =
  '$2b$12$B9mJy4Uiav/xsFpSuYnTy.MuGjT6xa1oJm3RMrMS0n6UrHNIHYdOy';
process.env.SESSION_SECRET = 's'.repeat(48);
process.env.CSRF_SECRET = 'c'.repeat(48);
process.env.APP_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.NODE_ENV = 'development';

const { loadConfig } = require('../server/config');
const { createApp } = require('../server/app');
const db = require('../db');
const { encrypt, decrypt } = require('../crypto');
const { LoginSession, LOGIN_STATES } = require('../login-flow');
const { createLoginControl } = require('../server/login-control');

const KNOWN_PASSWORD = 'S3cret-Plaintext-Never-Logged!';
const ADMIN_PASSWORD = 'TestAdmin#Pass123';

// ── A fake Playwright browser/page driver (NO real browser, NO network) ───────
//
// The fake records every value filled into a form field (so we can prove the
// DECRYPTED password reaches the form) and lets each test steer the post-submit
// URL so the flow goes needs_2fa / ok / failed deterministically. context.
// storageState writes a real file (so we can assert it contains no plaintext).

/**
 * @param {object} script controls the fake's behavior:
 *   { urlsAfterSubmit: string[], urlAfter2fa?: string, hasEmailField?: bool,
 *     has2faInput?: bool, fills: Record<string,string[]>, closed: {count}, logs: string[] }
 */
function makeFakeBrowser(script) {
  const fills = script.fills;
  let submitted = false;
  let twoFaSubmitted = false;

  const recordFill = (selector, value) => {
    if (!fills[selector]) fills[selector] = [];
    fills[selector].push(value);
  };

  const page = {
    async addInitScript() {},
    async goto() {},
    async waitForTimeout() {},
    async waitForURL() {},
    url() {
      if (twoFaSubmitted) return script.urlAfter2fa || 'https://www.facebook.com/home';
      // The submit toggles the URL from the login page to the post-submit URL.
      return submitted
        ? script.urlAfterSubmit || 'https://www.facebook.com/checkpoint/'
        : 'https://www.facebook.com/login';
    },
    async waitForSelector(sel) {
      // Email field discovery (the flow tries several selectors).
      if (/email|#email/.test(sel)) {
        return script.hasEmailField === false ? null : { async fill(v) { recordFill('email', v); } };
      }
      return null;
    },
    async $(sel) {
      // Cookie buttons: none.
      if (/cookie|Allow all|Accept All|essential/i.test(sel)) return null;
      // 2FA code input — present ONLY when the script explicitly opts in, so the
      // "clean login, no 2FA" path is the default (matches a real logged-in flow
      // where no approvals_code field exists).
      if (/approvals_code|one-time-code/.test(sel)) {
        return script.has2faInput === true
          ? { async fill(v) { recordFill('twofa', v); } }
          : null;
      }
      // Login submit button.
      if (/name="login"|aria-label="Log in"/.test(sel)) {
        return {
          async click() {
            submitted = true;
          },
        };
      }
      // 2FA submit / continue button.
      if (/type="submit"|Continue/.test(sel)) {
        return {
          async click() {
            twoFaSubmitted = true;
          },
        };
      }
      // "Not Now" (save browser) dialog.
      if (/Not Now/.test(sel)) return null;
      return null;
    },
    async fill(sel, value) {
      // Password field fill — THE critical assertion target.
      recordFill(sel, value);
    },
    async press() {
      submitted = true;
    },
    async screenshot() {
      // Record that a screenshot was requested but write nothing real.
      script.screenshots = (script.screenshots || 0) + 1;
    },
  };

  const context = {
    async newPage() {
      return page;
    },
    async storageState({ path: p }) {
      // Write a realistic-ish storageState file (cookies only — NEVER credentials).
      fs.writeFileSync(
        p,
        JSON.stringify({ cookies: [{ name: 'c_user', value: '100000' }], origins: [] })
      );
    },
    async close() {},
  };

  const browser = {
    async newContext() {
      return context;
    },
    async close() {
      script.closed.count += 1;
    },
  };

  return browser;
}

/** Build a LoginSession over the fake browser for a given account row. */
function sessionForRow(row, script, extraDeps = {}) {
  const env = require('../worker/loadConfig').accountEnvelope(row);
  const password = row.password_enc ? decrypt(row.password_enc) : '';
  const settings = db.getSettings();
  return new LoginSession(
    { account: env, email: env.email, password, settings },
    {
      launchBrowser: () => makeFakeBrowser(script),
      logger: (msg) => script.logs.push(msg),
      twoFaTimeoutMs: 2000,
      ...extraDeps,
    }
  );
}

// ── Server harness (mirrors branches.test.js) ─────────────────────────────────

let server;
let baseUrl;
let fakeLoginControl;

// A fake login-control registry injected into the app so route tests drive the
// full auth/CSRF/409 contract without a real browser. It is a thin in-memory
// state machine matching the real registry's public surface.
function makeFakeLoginControl() {
  const { ConflictError, NotFoundError, BadRequestError } = require('../server/errors');
  const map = new Map(); // accountId -> { status, detail }
  return {
    _map: map,
    launch(id) {
      if (!db.getAccountById(id)) throw new NotFoundError('Account not found');
      const cur = map.get(id);
      if (cur && cur.status !== 'ok' && cur.status !== 'failed') {
        throw new ConflictError('A login is already in progress for this account.');
      }
      const acct = db.getAccountById(id);
      if (!acct.password_enc) {
        throw new BadRequestError('No stored password for this account.');
      }
      const view = { account_name: acct.name, status: 'needs_2fa', detail: '2FA detected', started_at: Date.now(), finished_at: null };
      map.set(id, view);
      return view;
    },
    status(id) {
      if (!db.getAccountById(id)) throw new NotFoundError('Account not found');
      const cur = map.get(id);
      if (!cur) {
        return { account_name: db.getAccountById(id).name, status: 'idle', detail: null, started_at: null, finished_at: null };
      }
      return cur;
    },
    provide2fa(id, code) {
      if (!db.getAccountById(id)) throw new NotFoundError('Account not found');
      const cur = map.get(id);
      if (!cur) throw new NotFoundError('No login session for this account.');
      if (cur.status !== 'needs_2fa') throw new ConflictError('Not awaiting a 2FA code.');
      // Record (but NEVER expose) that a code was accepted; transition to ok.
      cur._codeLen = String(code).length;
      cur.status = 'ok';
      cur.detail = 'Session saved.';
      cur.finished_at = Date.now();
      return { account_name: cur.account_name, status: cur.status, detail: cur.detail, started_at: cur.started_at, finished_at: cur.finished_at };
    },
    async abortAll() {},
  };
}

before(async () => {
  db.getDb();
  fakeLoginControl = makeFakeLoginControl();
  const app = createApp(loadConfig(), {
    logger: { warn() {}, error() {} },
    workerControl: {
      async start() { return { action: 'started', status: 'online' }; },
      async stop() { return { action: 'stopped', status: 'stopped' }; },
      async status() { return { present: false, status: 'stopped', pid: null, uptime: null, restarts: null, cpu: null, memory: null }; },
    },
    loginControl: fakeLoginControl,
  });
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── Cookie-aware client (mirrors branches.test.js) ────────────────────────────

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

/** Insert an account row directly (encrypting the password like the route does). */
function seedAccount(name, { withPassword = true } = {}) {
  const fields = {
    name,
    email: `${name}@example.com`,
    session_file: path.join(TMP_DIR, `sessions/${name}.json`),
    user_agent: 'UA/1.0',
    locale: 'en-US',
    timezone_id: 'America/New_York',
  };
  if (withPassword) fields.password_enc = encrypt(KNOWN_PASSWORD);
  return db.insertAccount(fields);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. DB-backed account load + crypto.decrypt round-trip
// ═══════════════════════════════════════════════════════════════════════════

test('crypto round-trip: stored password_enc decrypts and reaches the login form', async () => {
  const id = seedAccount('rt-acct');
  const row = db.getAccountById(id);

  // Prove the stored ciphertext is NOT the plaintext, and decrypts back to it.
  assert.notStrictEqual(row.password_enc, KNOWN_PASSWORD, 'stored value is ciphertext, not plaintext');
  assert.strictEqual(decrypt(row.password_enc), KNOWN_PASSWORD, 'round-trips to the original');

  const script = { fills: {}, logs: [], closed: { count: 0 }, urlAfterSubmit: 'https://www.facebook.com/home' };
  const session = sessionForRow(row, script);
  const final = await session.run(); // server-driven: no interactiveAsk

  assert.strictEqual(final, LOGIN_STATES.OK, 'clean login reaches ok');
  // The DECRYPTED plaintext must have been filled into the password field.
  const passFills = script.fills['input[name="pass"], #pass'] || [];
  assert.ok(passFills.includes(KNOWN_PASSWORD), 'the decrypted password was filled into the form');
  // The email envelope field was filled too.
  assert.ok((script.fills.email || []).includes('rt-acct@example.com'), 'email filled from DB');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. State-machine transitions
// ═══════════════════════════════════════════════════════════════════════════

test('state machine: idle → running → needs_2fa → (code) → running → ok', async () => {
  const id = seedAccount('sm-2fa');
  const row = db.getAccountById(id);
  // After submit the URL is a checkpoint (needs_2fa); after 2FA it is home (ok).
  const script = {
    fills: {}, logs: [], closed: { count: 0 },
    urlAfterSubmit: 'https://www.facebook.com/checkpoint/?next',
    urlAfter2fa: 'https://www.facebook.com/home',
    has2faInput: true,
  };
  const session = sessionForRow(row, script);

  assert.strictEqual(session.status, LOGIN_STATES.IDLE, 'starts idle');

  // Drive run() without awaiting — it will PAUSE at needs_2fa.
  const runPromise = session.run(); // no interactiveAsk → server-driven pause

  // Wait until it parks at needs_2fa.
  await waitFor(() => session.status === LOGIN_STATES.NEEDS_2FA, 1000);
  assert.strictEqual(session.status, LOGIN_STATES.NEEDS_2FA, 'pauses at needs_2fa');

  // Provide the code → resumes → ok.
  const accepted = session.provide2fa('123456');
  assert.strictEqual(accepted, true, 'code accepted into the paused flow');

  const final = await runPromise;
  assert.strictEqual(final, LOGIN_STATES.OK, 'resumes to ok after the code');
  assert.ok((script.fills.twofa || []).includes('123456'), '2FA code filled into the checkpoint form');
  assert.strictEqual(script.closed.count, 1, 'browser closed on the ok path (no orphan)');
});

test('state machine: bad credentials → failed (stays logged-out)', async () => {
  const id = seedAccount('sm-fail');
  const row = db.getAccountById(id);
  // Post-submit URL is still /login (no 2FA) → verifySuccess is false → failed.
  const script = {
    fills: {}, logs: [], closed: { count: 0 },
    urlAfterSubmit: 'https://www.facebook.com/login/?error',
  };
  const session = sessionForRow(row, script);
  const final = await session.run();
  assert.strictEqual(final, LOGIN_STATES.FAILED, 'a logged-out final URL → failed');
  assert.strictEqual(session.status, LOGIN_STATES.FAILED);
  assert.strictEqual(script.closed.count, 1, 'browser closed on the failed path (no orphan)');
});

test('state machine: missing email field → failed (no submit)', async () => {
  const id = seedAccount('sm-noemail');
  const row = db.getAccountById(id);
  const script = { fills: {}, logs: [], closed: { count: 0 }, hasEmailField: false };
  const session = sessionForRow(row, script);
  const final = await session.run();
  assert.strictEqual(final, LOGIN_STATES.FAILED, 'no email field → failed');
  assert.strictEqual(script.closed.count, 1, 'browser closed even on early failure');
});

test('state machine: 2FA timeout (no code provided) → failed', async () => {
  const id = seedAccount('sm-2fa-timeout');
  const row = db.getAccountById(id);
  const script = {
    fills: {}, logs: [], closed: { count: 0 },
    urlAfterSubmit: 'https://www.facebook.com/checkpoint/',
    has2faInput: true,
  };
  // 50ms 2FA timeout so the test is fast.
  const session = sessionForRow(row, script, { twoFaTimeoutMs: 50 });
  const final = await session.run(); // never provide a code
  assert.strictEqual(final, LOGIN_STATES.FAILED, 'no code in time → failed');
  assert.ok(/2FA/i.test(session.detail || ''), 'detail explains the 2FA timeout');
  assert.strictEqual(script.closed.count, 1, 'browser closed after 2FA timeout');
});

test('CLI fallback: interactiveAsk resolves the 2FA branch without server pause', async () => {
  const id = seedAccount('sm-cli-2fa');
  const row = db.getAccountById(id);
  const script = {
    fills: {}, logs: [], closed: { count: 0 },
    urlAfterSubmit: 'https://www.facebook.com/two_step_verification/',
    urlAfter2fa: 'https://www.facebook.com/home',
    has2faInput: true,
  };
  const session = sessionForRow(row, script);
  // CLI provides a blocking prompt — the flow must NOT park on the server deferred.
  const final = await session.run({ interactiveAsk: async () => '654321' });
  assert.strictEqual(final, LOGIN_STATES.OK, 'CLI 2FA prompt resolves to ok');
  assert.ok((script.fills.twofa || []).includes('654321'), 'CLI-entered code filled');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. NO plaintext password is logged or persisted
// ═══════════════════════════════════════════════════════════════════════════

test('no plaintext: password is never in logs, never in the session file', async () => {
  const id = seedAccount('leak-check');
  const row = db.getAccountById(id);
  const sessionPath = row.session_file;
  const script = { fills: {}, logs: [], closed: { count: 0 }, urlAfterSubmit: 'https://www.facebook.com/home' };
  const session = sessionForRow(row, script);
  const final = await session.run();
  assert.strictEqual(final, LOGIN_STATES.OK);

  // No log line may contain the plaintext password.
  const allLogs = script.logs.join('\n');
  assert.ok(!allLogs.includes(KNOWN_PASSWORD), 'plaintext password never logged');

  // The only on-disk artifact is the storageState session file. It must NOT
  // contain the plaintext password (it holds cookies only).
  assert.ok(fs.existsSync(sessionPath), 'session storageState was written');
  const sessionContents = fs.readFileSync(sessionPath, 'utf8');
  assert.ok(!sessionContents.includes(KNOWN_PASSWORD), 'session file contains no plaintext password');

  // The DB still holds only ciphertext (the flow never wrote plaintext back).
  const after = db.getAccountById(id);
  assert.notStrictEqual(after.password_enc, KNOWN_PASSWORD, 'DB still ciphertext, not plaintext');
});

test('public session view exposes no secret-shaped fields', async () => {
  const id = seedAccount('public-view');
  const row = db.getAccountById(id);
  const script = { fills: {}, logs: [], closed: { count: 0 }, urlAfterSubmit: 'https://www.facebook.com/home' };
  const session = sessionForRow(row, script);
  await session.run();
  const view = session.toPublic();
  const serialized = JSON.stringify(view);
  assert.ok(!/password|_enc|secret|654321|123456/i.test(serialized), 'no secret-shaped field in the public view');
  assert.deepStrictEqual(
    Object.keys(view).sort(),
    ['account_name', 'detail', 'finished_at', 'started_at', 'status'].sort(),
    'public view is exactly the intended allowlist'
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. login-control routes: auth / CSRF / 409 / 202 / status / 2fa / 400
// ═══════════════════════════════════════════════════════════════════════════

test('route: unauthenticated login launch is 401', async () => {
  const id = seedAccount('rt-401');
  const c = makeClient(); // no login
  const r = await c.req('POST', `/api/accounts/${id}/login`, { body: {} });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.error.code, 'UNAUTHORIZED');
});

test('route: login launch without CSRF is 403', async () => {
  const id = seedAccount('rt-403');
  const c = await loginClient();
  const r = await c.req('POST', `/api/accounts/${id}/login`, { body: {} }); // no csrf
  assert.strictEqual(r.status, 403);
});

test('route: launch returns 202 + needs_2fa; status reflects it; concurrent launch is 409', async () => {
  const id = seedAccount('rt-202');
  const c = await loginClient();

  let token = await c.csrf();
  const launch = await c.req('POST', `/api/accounts/${id}/login`, { csrf: token });
  assert.strictEqual(launch.status, 202, 'launch is accepted (202)');
  assert.strictEqual(launch.body.login.status, 'needs_2fa');
  assert.strictEqual(launch.body.login.account_name, 'rt-202');

  // Status (a read — no CSRF) reflects the in-progress state.
  const status = await c.req('GET', `/api/accounts/${id}/login/status`);
  assert.strictEqual(status.status, 200);
  assert.strictEqual(status.body.login.status, 'needs_2fa');

  // A second launch while the first is non-terminal → 409.
  token = await c.csrf();
  const concurrent = await c.req('POST', `/api/accounts/${id}/login`, { csrf: token });
  assert.strictEqual(concurrent.status, 409, 'concurrent launch refused');
  assert.strictEqual(concurrent.body.error.code, 'CONFLICT');
});

test('route: 2FA code is accepted and resumes the flow to ok', async () => {
  const id = seedAccount('rt-2fa');
  const c = await loginClient();
  let token = await c.csrf();
  await c.req('POST', `/api/accounts/${id}/login`, { csrf: token });

  token = await c.csrf();
  const r = await c.req('POST', `/api/accounts/${id}/login/2fa`, {
    csrf: token,
    body: { code: '123456' },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.login.status, 'ok');
  // The response must NOT echo the code anywhere.
  assert.ok(!JSON.stringify(r.body).includes('123456'), '2FA code never echoed in the response');
});

test('route: 2FA without CSRF is 403; with a bad/empty code is 422', async () => {
  const id = seedAccount('rt-2fa-bad');
  const c = await loginClient();
  let token = await c.csrf();
  await c.req('POST', `/api/accounts/${id}/login`, { csrf: token });

  // No CSRF → 403.
  const noCsrf = await c.req('POST', `/api/accounts/${id}/login/2fa`, { body: { code: '111111' } });
  assert.strictEqual(noCsrf.status, 403);

  // Empty code → 422 (schema .strict + min(1)).
  token = await c.csrf();
  const empty = await c.req('POST', `/api/accounts/${id}/login/2fa`, { csrf: token, body: { code: '' } });
  assert.strictEqual(empty.status, 422);
  assert.strictEqual(empty.body.error.code, 'VALIDATION_ERROR');

  // Unknown key → 422 (.strict()).
  token = await c.csrf();
  const extra = await c.req('POST', `/api/accounts/${id}/login/2fa`, {
    csrf: token, body: { code: '111111', injected: 'x' },
  });
  assert.strictEqual(extra.status, 422);
});

test('route: status for a never-started account is idle; missing account is 404', async () => {
  const id = seedAccount('rt-idle');
  const c = await loginClient();
  const idle = await c.req('GET', `/api/accounts/${id}/login/status`);
  assert.strictEqual(idle.status, 200);
  assert.strictEqual(idle.body.login.status, 'idle');

  const missing = await c.req('GET', '/api/accounts/999999/login/status');
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.body.error.code, 'NOT_FOUND');
});

test('route: launch on an account with no stored password is 400 (not 500)', async () => {
  const id = seedAccount('rt-nopass', { withPassword: false });
  const c = await loginClient();
  const token = await c.csrf();
  const r = await c.req('POST', `/api/accounts/${id}/login`, { csrf: token });
  assert.strictEqual(r.status, 400, 'no-credential launch is a clean 400');
  assert.strictEqual(r.body.error.code, 'BAD_REQUEST');
});

// ═══════════════════════════════════════════════════════════════════════════
// Real registry (createLoginControl): credential decrypt + 400 paths exercised
// against the GENUINE control layer (no fake), using a fake browser launcher.
// ═══════════════════════════════════════════════════════════════════════════

test('real registry: launch decrypts DB credentials and drives to needs_2fa, then 2fa→ok', async () => {
  const id = seedAccount('reg-real');
  const script = { fills: {}, logs: [], closed: { count: 0 },
    urlAfterSubmit: 'https://www.facebook.com/checkpoint/', urlAfter2fa: 'https://www.facebook.com/home', has2faInput: true };
  const control = createLoginControl({
    launchBrowser: () => makeFakeBrowser(script),
    logger: { warn() {}, error() {} },
  });

  const launched = control.launch(id);
  assert.ok(['running', 'needs_2fa'].includes(launched.status), 'launch returns a running/needs_2fa view');

  await waitFor(() => control.status(id).status === 'needs_2fa', 1000);
  // The genuine decrypt path filled the real plaintext into the form.
  assert.ok((script.fills['input[name="pass"], #pass'] || []).includes(KNOWN_PASSWORD),
    'real registry decrypted the DB password into the form');

  const after2fa = control.provide2fa(id, '222333');
  // run() resumes async; poll for terminal ok.
  await waitFor(() => control.status(id).status === 'ok', 1000);
  assert.strictEqual(control.status(id).status, 'ok');
  assert.ok(!JSON.stringify(after2fa).includes('222333'), 'provide2fa view never echoes the code');
});

test('real registry: concurrent launch is rejected; no-password account throws BadRequest', async () => {
  const { ConflictError, BadRequestError } = require('../server/errors');
  const id = seedAccount('reg-concurrent');
  const script = { fills: {}, logs: [], closed: { count: 0 }, urlAfterSubmit: 'https://www.facebook.com/checkpoint/', has2faInput: true };
  const control = createLoginControl({ launchBrowser: () => makeFakeBrowser(script), logger: { warn() {}, error() {} } });

  control.launch(id);
  await waitFor(() => control.status(id).status === 'needs_2fa', 1000);
  assert.throws(() => control.launch(id), ConflictError, 'second launch while non-terminal throws Conflict');

  const noPassId = seedAccount('reg-nopass', { withPassword: false });
  assert.throws(() => control.launch(noPassId), BadRequestError, 'no-password launch throws BadRequest');

  await control.abortAll();
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY GAP (deep-reviewer): tampered / wrong-key ciphertext in password_enc
// must FAIL CLOSED — a clean 400 at the decrypt catch (login-control.js:105),
// NOT a 500, NOT a crash, NOT a leaked stack/secret. Previously only an ABSENT
// password was covered; a CORRUPT/undecryptable one is the more dangerous path
// (a key rotation or a DB-restore from a different key lands here).
// ═══════════════════════════════════════════════════════════════════════════

test('security: undecryptable password_enc → real registry throws BadRequest (fail-closed, no leak)', async () => {
  const { BadRequestError } = require('../server/errors');
  // Seed an account whose password_enc is well-formed "iv:tag:ct" base64 shape but
  // was encrypted under a DIFFERENT key (so the auth-tag verification throws inside
  // crypto.decrypt). We forge it by encrypting under a foreign key, then storing it.
  const id = seedAccount('reg-tampered', { withPassword: false });
  const foreignKey = require('crypto').randomBytes(32).toString('hex');
  const prevKey = process.env.APP_ENCRYPTION_KEY;
  let foreignCipher;
  try {
    process.env.APP_ENCRYPTION_KEY = foreignKey; // encrypt under the WRONG key
    delete require.cache[require.resolve('../crypto')];
    foreignCipher = require('../crypto').encrypt('whatever-plaintext');
  } finally {
    process.env.APP_ENCRYPTION_KEY = prevKey; // restore the real key for decrypt
    delete require.cache[require.resolve('../crypto')];
  }
  db.updateAccount(id, { password_enc: foreignCipher });

  // The control layer decrypts at launch; the wrong-key ciphertext fails the auth
  // tag → the decrypt catch (login-control.js:105) maps it to a clean BadRequest.
  const logs = [];
  const control = createLoginControl({
    launchBrowser: () => makeFakeBrowser({ fills: {}, logs: [], closed: { count: 0 } }),
    logger: { warn() {}, error: (m) => logs.push(String(m)) },
  });
  assert.throws(
    () => control.launch(id),
    BadRequestError,
    'undecryptable ciphertext is a BadRequest (fail-closed), not a thrown crypto error'
  );
  // The server-side error log must NOT contain the ciphertext/secret material.
  const allLogs = logs.join('\n');
  assert.ok(!allLogs.includes(foreignCipher), 'the ciphertext is never written to the server log');
  assert.ok(!/whatever-plaintext/.test(allLogs), 'no plaintext leaks into the log');
});

test('security: undecryptable password_enc launch is HTTP 400 (not 500), no stack/secret in body', async () => {
  // Mount a SECOND app wired with the GENUINE createLoginControl (the suite-wide
  // app uses a fake), so the real decrypt-catch path is exercised end-to-end over
  // HTTP and we can assert the status + the sanitized error body.
  const realControl = createLoginControl({
    launchBrowser: () => makeFakeBrowser({ fills: {}, logs: [], closed: { count: 0 } }),
    logger: { warn() {}, error() {} },
  });
  const app = createApp(loadConfig(), {
    logger: { warn() {}, error() {} },
    workerControl: {
      async start() { return { action: 'started', status: 'online' }; },
      async stop() { return { action: 'stopped', status: 'stopped' }; },
      async status() { return { present: false, status: 'stopped', pid: null, uptime: null, restarts: null, cpu: null, memory: null }; },
    },
    loginControl: realControl,
  });
  const realServer = await new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => resolve(srv));
  });
  const realBase = `http://127.0.0.1:${realServer.address().port}`;

  // A local cookie-aware client bound to THIS server.
  const cookies = new Map();
  const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of raw) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
  };
  const reqLocal = async (method, urlPath, { body, csrf } = {}) => {
    const headers = { cookie: cookieHeader() };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf) headers['x-csrf-token'] = csrf;
    const res = await fetch(realBase + urlPath, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    store(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, rawText: text };
  };
  const csrfLocal = async () => (await reqLocal('GET', '/api/auth/csrf')).body.csrf_token;

  try {
    // Authenticate against this server.
    let token = await csrfLocal();
    const login = await reqLocal('POST', '/api/auth/login', {
      body: { username: 'admin', password: ADMIN_PASSWORD }, csrf: token,
    });
    assert.strictEqual(login.status, 200, 'admin login on the real-control server');

    // Seed an account with wrong-key ciphertext (same forge as the unit test).
    const id = seedAccount('http-tampered', { withPassword: false });
    const foreignKey = require('crypto').randomBytes(32).toString('hex');
    const prevKey = process.env.APP_ENCRYPTION_KEY;
    let foreignCipher;
    try {
      process.env.APP_ENCRYPTION_KEY = foreignKey;
      delete require.cache[require.resolve('../crypto')];
      foreignCipher = require('../crypto').encrypt('plaintext-must-not-leak');
    } finally {
      process.env.APP_ENCRYPTION_KEY = prevKey;
      delete require.cache[require.resolve('../crypto')];
    }
    db.updateAccount(id, { password_enc: foreignCipher });

    token = await csrfLocal();
    const launch = await reqLocal('POST', `/api/accounts/${id}/login`, { csrf: token });

    assert.strictEqual(launch.status, 400, 'undecryptable credential is a clean 400, not a 500');
    assert.strictEqual(launch.body.error.code, 'BAD_REQUEST', 'maps to the BAD_REQUEST contract');
    // The error body must NOT leak a stack trace, the ciphertext, or the plaintext.
    assert.ok(!('stack' in launch.body.error), 'no stack on the error body');
    assert.ok(!/plaintext-must-not-leak/.test(launch.rawText), 'no plaintext in the response');
    assert.ok(!launch.rawText.includes(foreignCipher), 'no ciphertext in the response');
    assert.ok(!/\bat \//.test(launch.rawText), 'no "at /path" stack frames in the response body');
  } finally {
    await new Promise((resolve) => realServer.close(resolve));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY GAP (deep-reviewer): abort() called DURING an in-flight launchBrowser()
// must close the browser (no orphaned chromium) when the abort RACES the launch.
// Previously only the 4 common close paths (ok / failed / no-email / 2fa-timeout)
// were covered; the abort-vs-launch race (login-flow.js abort/run finally interplay)
// is the leak-prone path on a control-plane shutdown landing mid-launch.
// ═══════════════════════════════════════════════════════════════════════════

test('security: abort() racing an in-flight launchBrowser() closes the browser (no orphan)', async () => {
  const id = seedAccount('abort-race');
  const row = db.getAccountById(id);
  const password = decrypt(row.password_enc);
  const env = require('../worker/loadConfig').accountEnvelope(row);

  // A browser whose close() is tracked. The launcher PARKS until we explicitly
  // release it — so we can fire abort() while run() is awaiting launchBrowser().
  let closeCalls = 0;
  let contextCalls = 0;
  const browser = {
    async newContext() { contextCalls += 1; return { async newPage() { return {}; }, async close() {} }; },
    async close() { closeCalls += 1; },
  };
  let releaseLaunch;
  const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
  const launchBrowser = async () => {
    await launchGate; // park here until the test releases — abort() fires meanwhile
    return browser;
  };

  const session = new LoginSession(
    { account: env, email: env.email, password, settings: db.getSettings() },
    { launchBrowser, logger: () => {}, twoFaTimeoutMs: 1000 }
  );

  // Start run() — it parks inside launchBrowser()'s await.
  const runPromise = session.run();
  // Give run() a tick to reach the launch await.
  await new Promise((r) => setTimeout(r, 20));

  // Abort while the launch is still in flight, THEN release the launch so run()
  // resumes, sees _aborted, and must close the (now-resolved) browser.
  const abortPromise = session.abort();
  releaseLaunch();
  await Promise.all([runPromise, abortPromise]);

  assert.strictEqual(session.status, LOGIN_STATES.FAILED, 'aborted session ends failed (terminal)');
  assert.strictEqual(contextCalls, 0, 'no context/cycle ran on the aborted launch');
  assert.strictEqual(closeCalls >= 1, true, 'the in-flight-launched browser was CLOSED (no orphan)');
});

// ── tiny polling helper ───────────────────────────────────────────────────────

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch {
        ok = false;
      }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}
