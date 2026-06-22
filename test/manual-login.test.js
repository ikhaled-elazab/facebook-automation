'use strict';

/* global setTimeout */
// setTimeout is a Node global; declared here because the shared eslint config
// (eslint.config.js) lists it only in some scopes (same convention as login.js).

/**
 * test/manual-login.test.js — the MANUAL (human-in-the-loop) login flow.
 *
 * Covers the `needs_manual` path added so accounts that require an authenticator
 * OTP, a QR scan, or a push-approve (none of which is a typeable code we can drive)
 * can be logged in by a human in a HEADED browser while the control plane captures
 * the resulting storageState. Sister file to login.test.js (the automated path).
 *
 * HARD CONSTRAINTS honored (same as login.test.js):
 *   - node:test runner (not jest/vitest).
 *   - NO real Facebook / NO real browser: a fake browser/context/page steers the
 *     LoginSession state machine (idle → running → needs_manual → ok|failed).
 *   - The only on-disk artifact asserted is the storageState file (NEVER secrets).
 *
 * What is proven here:
 *   1. Manual flow parks at needs_manual, then captures the session once the human
 *      finishes (c_user cookie appears) → ok, storageState written, mode='manual'.
 *   2. Manual flow NEVER fills the password (the human owns the credential step).
 *   3. A manual flow that is never completed times out → failed (no session file).
 *   4. abort() while parked at needs_manual → failed('Aborted.'), browser closed.
 *   5. The control layer RELAXES the credential requirement in manual mode (no 400
 *      for a missing/undecryptable password) and forces a HEADED browser launch.
 *   6. loginLaunchSchema accepts {mode:'manual'} / {} and rejects junk / extra keys.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Set a temp DB + crypto key BEFORE requiring app code (login-control.js pulls in
// ../db + ../crypto at require time). The control-layer test injects fakes, so the
// real DB is never actually queried — these just make the requires succeed.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbcp-manual-'));
process.env.DB_PATH = path.join(TMP_DIR, 'cp-manual-test.db');
process.env.APP_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.SESSION_SECRET = 's'.repeat(48);
process.env.CSRF_SECRET = 'c'.repeat(48);
process.env.NODE_ENV = 'development';

const { LoginSession, LOGIN_STATES } = require('../login-flow');
const { createLoginControl } = require('../server/login-control');
const { loginLaunchSchema } = require('../server/schemas');

// ── A fake Playwright browser/context/page for the MANUAL path ────────────────
//
// The manual flow decides "logged in?" by inspecting the c_user cookie, so the
// fake's context.cookies() is the steering knob: it returns the cookie after
// `completeAfter` calls (simulating the human finishing), or never (neverComplete).
// context.storageState writes a real file so we can assert capture-on-success.
function makeManualFake({ completeAfter = 0, neverComplete = false } = {}) {
  const fills = {};
  const closed = { count: 0 };
  let cookieCalls = 0;
  let closedFlag = false;

  const page = {
    async addInitScript() {},
    async goto() {},
    async waitForTimeout(ms) {
      await new Promise((r) => setTimeout(r, ms));
    },
    isClosed() {
      return closedFlag;
    },
    url() {
      return 'https://www.facebook.com/login';
    },
    async $() {
      // No cookie banner, no email field in the fake — the flow skips both.
      return null;
    },
    async waitForSelector() {
      return null;
    },
    async fill(sel, value) {
      (fills[sel] = fills[sel] || []).push(value);
    },
  };

  const context = {
    async newPage() {
      return page;
    },
    async cookies() {
      cookieCalls += 1;
      if (neverComplete) return [];
      // Human "finishes" once we've polled more than completeAfter times.
      return cookieCalls > completeAfter ? [{ name: 'c_user', value: '100000' }] : [];
    },
    async storageState({ path: p }) {
      fs.writeFileSync(
        p,
        JSON.stringify({ cookies: [{ name: 'c_user', value: '100000' }], origins: [] })
      );
    },
    async close() {},
  };

  const captured = {};
  const browser = {
    async newContext(opts) {
      captured.contextOpts = opts;
      return context;
    },
    async close() {
      closed.count += 1;
      closedFlag = true;
    },
  };

  return { browser, fills, closed, captured, cookieCalls: () => cookieCalls };
}

/** Build a manual-mode LoginSession over the fake (no DB, hand-crafted envelope). */
function makeManualSession(
  fake,
  { sessionFile, email = '', manualTimeoutMs = 2000, manualPollMs = 10, streamFactory } = {}
) {
  const env = {
    name: 'manual-acct',
    sessionFile,
    userAgent: 'UA-test',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    proxy: null,
  };
  return new LoginSession(
    { account: env, email, password: '', settings: {}, mode: 'manual' },
    {
      launchBrowser: () => fake.browser,
      manualTimeoutMs,
      manualPollMs,
      streamFactory,
      logger: () => {},
    }
  );
}

/** A minimal fake remote-browser stream recording its lifecycle. */
function makeFakeStream() {
  return {
    started: false,
    stopped: false,
    async start() {
      this.started = true;
    },
    async stop() {
      this.stopped = true;
    },
  };
}

let tmpFiles = 0;
function tmpSessionFile() {
  // Deterministic, unique-per-call path (no Date.now reliance for uniqueness).
  return path.join(TMP_DIR, `session-${(tmpFiles += 1)}.json`);
}

before(() => {});
after(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// 1 + 2 — success path captures the session and never touches the password.
test('manual login reaches ok, writes the session file, and never fills a password', async () => {
  const sessionFile = tmpSessionFile();
  const fake = makeManualFake({ completeAfter: 0 }); // logged-in on the first poll
  const session = makeManualSession(fake, { sessionFile, manualPollMs: 10 });

  const result = await session.run();

  assert.equal(result, 'ok');
  assert.equal(session.status, LOGIN_STATES.OK);
  assert.equal(session.toPublic().mode, 'manual');
  assert.ok(fs.existsSync(sessionFile), 'storageState file is written on success');
  assert.ok(
    !Object.keys(fake.fills).some((k) => /pass/i.test(k)),
    'manual mode must never fill the password field'
  );
  assert.ok(fake.closed.count >= 1, 'browser is closed on the success path');
});

// 1 (parked state) — the flow is observably at needs_manual before completion.
test('manual login parks at needs_manual while waiting for the human', async () => {
  const sessionFile = tmpSessionFile();
  const fake = makeManualFake({ neverComplete: true });
  const session = makeManualSession(fake, { sessionFile, manualTimeoutMs: 5000, manualPollMs: 20 });

  const runP = session.run();
  await new Promise((r) => setTimeout(r, 30)); // let it navigate + park
  assert.equal(session.status, LOGIN_STATES.NEEDS_MANUAL, 'parked awaiting the human');
  assert.equal(session.toPublic().mode, 'manual');

  await session.abort();
  await runP;
});

// 3 — never completed → bounded timeout → failed, no session file.
test('manual login times out to failed when the human never finishes', async () => {
  const sessionFile = tmpSessionFile();
  const fake = makeManualFake({ neverComplete: true });
  const session = makeManualSession(fake, { sessionFile, manualTimeoutMs: 120, manualPollMs: 20 });

  const result = await session.run();

  assert.equal(result, 'failed');
  assert.equal(session.status, LOGIN_STATES.FAILED);
  assert.match(session.detail, /not completed/i);
  assert.ok(!fs.existsSync(sessionFile), 'no session file is written on timeout');
  assert.ok(fake.closed.count >= 1, 'browser is closed on the timeout path');
});

// 4 — abort while parked → failed('Aborted.').
test('aborting a parked manual login fails closed and closes the browser', async () => {
  const sessionFile = tmpSessionFile();
  const fake = makeManualFake({ neverComplete: true });
  const session = makeManualSession(fake, { sessionFile, manualTimeoutMs: 5000, manualPollMs: 20 });

  const runP = session.run();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(session.status, LOGIN_STATES.NEEDS_MANUAL);

  await session.abort();
  const result = await runP;

  assert.equal(result, 'failed');
  assert.equal(session.detail, 'Aborted.');
  assert.ok(!fs.existsSync(sessionFile), 'no session file on abort');
  assert.ok(fake.closed.count >= 1, 'browser closed on abort');
});

// 4b — the injected stream is started on the parked page and stopped on success.
test('manual mode starts the remote stream and stops it on the success path', async () => {
  const sessionFile = tmpSessionFile();
  const fake = makeManualFake({ completeAfter: 0 });
  const stream = makeFakeStream();
  const session = makeManualSession(fake, {
    sessionFile,
    manualPollMs: 10,
    streamFactory: () => stream,
  });

  const result = await session.run();

  assert.equal(result, 'ok');
  assert.ok(stream.started, 'stream is started while driving the manual login');
  assert.ok(stream.stopped, 'stream is stopped once the login reaches a terminal state');
  // The session releases its stream reference after teardown.
  assert.equal(session.stream, null);
});

// 4c — the stream is exposed while parked and torn down on abort.
test('manual stream is exposed while parked and torn down on abort', async () => {
  const sessionFile = tmpSessionFile();
  const fake = makeManualFake({ neverComplete: true });
  const stream = makeFakeStream();
  const session = makeManualSession(fake, {
    sessionFile,
    manualTimeoutMs: 5000,
    manualPollMs: 20,
    streamFactory: () => stream,
  });

  const runP = session.run();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(session.status, LOGIN_STATES.NEEDS_MANUAL);
  assert.equal(session.stream, stream, 'stream is reachable while parked (for the WS layer)');
  assert.ok(stream.started);

  await session.abort();
  await runP;
  assert.ok(stream.stopped, 'stream stopped on abort');
});

// 4d — manual re-login reuses a saved session file as the browser identity (datr),
// so Facebook sees a returning device instead of a new one on every login.
test('manual re-login seeds the context from the saved session for device recognition', async () => {
  const sessionFile = tmpSessionFile();
  // A pre-existing, valid saved session (storageState JSON) must be reused.
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({ cookies: [{ name: 'datr', value: 'device-id' }], origins: [] })
  );
  const fake = makeManualFake({ completeAfter: 0 });
  const session = makeManualSession(fake, { sessionFile, manualPollMs: 10 });

  await session.run();

  assert.equal(
    fake.captured.contextOpts.storageState,
    path.resolve(sessionFile),
    'manual login seeds the context from the saved session (carries datr)'
  );
});

// 4e — with NO prior session file, nothing is seeded (the genuine first login).
test('first manual login (no saved session) does not seed storageState', async () => {
  const sessionFile = tmpSessionFile(); // never written before run()
  const fake = makeManualFake({ completeAfter: 0 });
  const session = makeManualSession(fake, { sessionFile, manualPollMs: 10 });

  await session.run();

  assert.equal(
    fake.captured.contextOpts.storageState,
    undefined,
    'a first login starts from a clean context (no file to reuse)'
  );
});

// 5 — control layer relaxes creds in manual mode, runs headless, and attaches a stream.
test('control layer: manual launch allows a passwordless account, headless + streamed', async () => {
  // A row with NO email and NO password — fatal in auto mode, fine in manual.
  const row = {
    id: 1,
    name: 'no-creds-acct',
    email: null,
    password_enc: null,
    proxy_password_enc: null,
    session_file: tmpSessionFile(),
    user_agent: null,
    locale: null,
    timezone_id: null,
    proxy_server: null,
    proxy_username: null,
    daily_action_cap: 100,
    enabled: 1,
  };

  let capturedParams = null;
  let capturedDeps = null;
  let launchedSettings = null;

  const control = createLoginControl({
    db: {
      getAccountById: (id) => (id === 1 ? row : null),
      getSettings: () => ({ headless: true }), // default headless ON; manual must override
    },
    decrypt: () => '',
    // Records the settings the control layer hands the launcher (to prove headed).
    launchBrowser: (settings) => {
      launchedSettings = settings;
      return { async newContext() {}, async close() {} };
    },
    // Capture what the control layer constructs without running a real session.
    makeSession: (params, deps) => {
      capturedParams = params;
      capturedDeps = deps;
      return {
        status: LOGIN_STATES.NEEDS_MANUAL,
        async run() {
          return LOGIN_STATES.NEEDS_MANUAL;
        },
        toPublic: () => ({
          account_name: row.name,
          status: LOGIN_STATES.NEEDS_MANUAL,
          detail: null,
          mode: 'manual',
          started_at: null,
          finished_at: null,
        }),
      };
    },
    logger: { warn() {}, error() {} },
  });

  // Must NOT throw despite the account having no email and no password.
  const view = control.launch(1, { mode: 'manual' });
  assert.equal(view.status, LOGIN_STATES.NEEDS_MANUAL);
  assert.equal(view.mode, 'manual');

  // The session was built in manual mode with an empty (omitted) password.
  assert.equal(capturedParams.mode, 'manual');
  assert.equal(capturedParams.password, '');

  // A streamed manual login is built with a stream factory (auto logins are not).
  assert.equal(typeof capturedDeps.streamFactory, 'function', 'manual login gets a stream factory');

  // Invoke the injected launcher exactly as run() would, to prove the headless
  // override (CDP screencast needs no display — portable on a headless VPS).
  await capturedDeps.launchBrowser();
  assert.equal(launchedSettings.headless, true, 'streamed manual launch runs headless');
});

// 6 — schema contract for the optional launch body.
test('loginLaunchSchema accepts mode|empty and rejects junk + extra keys', () => {
  assert.deepEqual(loginLaunchSchema.parse({ mode: 'manual' }), { mode: 'manual' });
  assert.deepEqual(loginLaunchSchema.parse({ mode: 'auto' }), { mode: 'auto' });
  assert.deepEqual(loginLaunchSchema.parse({}), {}); // absent mode → defaults to auto downstream
  assert.throws(() => loginLaunchSchema.parse({ mode: 'sideways' }), 'rejects an unknown mode');
  assert.throws(() => loginLaunchSchema.parse({ mode: 'manual', extra: 1 }), 'strict: no extra keys');
});
