'use strict';

/**
 * test/loop.test.js — reliability tests for worker/loop.js, the most
 * reliability-critical file in the worker (per-account cycle + supervisor +
 * heartbeat + orphan-browser shutdown) and previously the only one with no test.
 *
 * These tests are fully deterministic: the browser is faked via the existing
 * `deps.launchBrowser` injection point, the heartbeat is faked via
 * `startHeartbeat({ heartbeat, setInterval })`, and NO real browser / network /
 * wall-clock timer is used. They assert the three reliability invariants from
 * the gate:
 *   (a) HIGH-1 — a throwing cycle does NOT break the account loop (it continues).
 *   (b) HIGH-3 — registered browsers are closed on shutdown (SIGTERM path).
 *   (c) HIGH-2 — a heartbeat is written on boot and on every ticker tick.
 *
 * The DB is a throwaway temp SQLite (same pattern as loadConfig.test.js) so the
 * cycle-boundary db.heartbeat() writes inside runAccountSession have a real,
 * isolated target and never touch the project DB.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate the DB BEFORE requiring db (db resolves DB_PATH lazily on first getDb).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbloop-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.APP_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');

const db = require('../db');
const loop = require('../worker/loop.js');
const {
  runAccountSession,
  registerBrowser,
  shutdownAllBrowsers,
  startHeartbeat,
  stopHeartbeat,
} = loop;

// A throwaway session file so runAccount's fs.existsSync guard would pass (we
// call runAccountSession directly here, but keep parity for any future test).
const SESSION_PATH = path.join(TMP_DIR, 'session.json');

before(() => {
  db.getDb(); // materialize schema (creates the single worker_state row)
  fs.writeFileSync(SESSION_PATH, '{}');
});

after(() => {
  stopHeartbeat();
  db.closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/**
 * Build a fake browser whose newContext() behavior is supplied by the test.
 * Tracks whether close() was called so HIGH-3 can be asserted.
 * @param {() => any} newContextImpl called on each newContext()
 */
function makeFakeBrowser(newContextImpl) {
  const fake = {
    closed: false,
    closeCalls: 0,
    contextCalls: 0,
    async newContext() {
      fake.contextCalls++;
      return newContextImpl();
    },
    async close() {
      fake.closeCalls++;
      fake.closed = true;
    },
  };
  return fake;
}

/** A fake page/context pair where the cycle body would no-op (unused when the
 *  test makes newContext throw, but provided for the happy-path-ish shape). */
function makeFakeContext() {
  const page = {
    async addInitScript() {},
    async goto() {},
    async waitForSelector() {
      return null;
    },
    async $() {
      return null;
    },
    async $$() {
      return [];
    },
    async evaluate() {
      return 0;
    },
    keyboard: { async press() {} },
  };
  return {
    async newPage() {
      return page;
    },
    async close() {},
  };
}

// ─── HIGH-1: a throwing cycle does NOT break the account loop ─────────────────

test('HIGH-1: a throwing cycle is swallowed and the loop CONTINUES (does not break)', async () => {
  // The fake browser throws inside newContext() on every cycle, simulating a
  // bad cycle (the real-world case is monitorAndReplyToComments throwing, which
  // used to reject runOneCycle → break the while-loop → zombie account). We let
  // it throw THREE times to prove the loop keeps going past each failure, then
  // flip the shutdown flag (via the real exported shutdownAllBrowsers) so the
  // inner `while (!shuttingDown)` exits cleanly and the test terminates.
  const TARGET_CYCLES = 3;
  let cycles = 0;

  const browser = makeFakeBrowser(() => {
    cycles++;
    if (cycles >= TARGET_CYCLES) {
      // Stop the loop AFTER throwing on this cycle too — set shutdown so the
      // next `while (!shuttingDown)` check (and the post-sleep guard) exits.
      // Schedule it as a resolved microtask so this throw still happens first.
      Promise.resolve().then(() => shutdownAllBrowsers({ timeoutMs: 50 }));
    }
    throw new Error('simulated bad cycle (newContext failed)');
  });

  const account = { id: 1, name: 'looptest', checkIntervalMinutes: 0.0001 }; // ~6ms interval
  const ctx = {
    settings: {},
    h: {},
    withRetry: async () => undefined,
  };

  // Must RESOLVE (not reject). If a throwing cycle broke the loop with an
  // unhandled rejection, this await would reject and fail the test.
  await runAccountSession(account, SESSION_PATH, {}, ctx, { launchBrowser: () => browser });

  // The loop attempted at least TARGET_CYCLES cycles → it CONTINUED past the
  // first (and second) throw instead of dying on the first one.
  assert.ok(
    cycles >= TARGET_CYCLES,
    `expected the loop to survive >= ${TARGET_CYCLES} throwing cycles, got ${cycles}`
  );
  // The browser opened a context each cycle; the session's finally still closed
  // the browser (no leak) even though every cycle threw.
  assert.strictEqual(browser.contextCalls, cycles, 'newContext called once per cycle');
  assert.ok(browser.closed, 'browser closed by the session finally even though all cycles threw');

  // Reset module shutdown state for the next test (shutdownAllBrowsers set it).
  loop.__resetForTest && loop.__resetForTest();
});

// ─── HIGH-3: browsers are closed on shutdown (SIGTERM path) ───────────────────

test('HIGH-3: shutdownAllBrowsers closes ALL registered browsers (bounded)', async () => {
  const a = makeFakeBrowser(makeFakeContext);
  const b = makeFakeBrowser(makeFakeContext);
  const c = makeFakeBrowser(makeFakeContext);
  registerBrowser(a);
  registerBrowser(b);
  registerBrowser(c);

  await shutdownAllBrowsers({ timeoutMs: 100 });

  assert.ok(a.closed && b.closed && c.closed, 'every registered browser was closed');
  assert.strictEqual(a.closeCalls, 1, 'each browser closed exactly once');

  // A second shutdown is a safe no-op (idempotent) — registry was cleared.
  await shutdownAllBrowsers({ timeoutMs: 100 });
  assert.strictEqual(a.closeCalls, 1, 'idempotent: not closed again on a second shutdown');

  loop.__resetForTest && loop.__resetForTest();
});

test('HIGH-3: a hung browser.close() is bounded by the timeout and does not block', async () => {
  // A browser whose close() never resolves must NOT wedge shutdown forever.
  const hung = {
    closed: false,
    close() {
      return new Promise(() => {}); // never resolves
    },
  };
  registerBrowser(hung);

  const start = Date.now();
  await shutdownAllBrowsers({ timeoutMs: 60 }); // bounded
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 1500, `shutdown returned promptly despite hung close (took ${elapsed}ms)`);

  loop.__resetForTest && loop.__resetForTest();
});

// ─── HIGH-2: a heartbeat is written on boot and on every ticker tick ──────────

test('HIGH-2: startHeartbeat writes an immediate boot beat then one per tick', () => {
  const beats = [];
  const fakeBeat = (status, detail) => beats.push({ status, detail });

  // A controllable fake setInterval: capture the tick fn + return a fake handle
  // with unref()/no-op so we can drive ticks manually (deterministic, no timers).
  let tickFn = null;
  const fakeSetInterval = (fn) => {
    tickFn = fn;
    return { unref() {}, _fake: true };
  };

  const handle = startHeartbeat({ heartbeat: fakeBeat, setInterval: fakeSetInterval });
  assert.ok(handle && handle._fake, 'startHeartbeat returned the (fake) timer handle');

  // Boot beat fired immediately.
  assert.strictEqual(beats.length, 1, 'one immediate boot heartbeat');
  assert.strictEqual(beats[0].status, 'running', 'boot heartbeat status is running');

  // Drive three ticks → three more beats.
  tickFn();
  tickFn();
  tickFn();
  assert.strictEqual(beats.length, 4, 'boot + 3 ticks = 4 heartbeats');
  assert.ok(
    beats.every((b) => b.status === 'running'),
    'every liveness beat is status=running'
  );

  // Idempotent: a second startHeartbeat while one is running is a no-op.
  const second = startHeartbeat({ heartbeat: fakeBeat, setInterval: fakeSetInterval });
  assert.strictEqual(second, null, 'second startHeartbeat is a no-op (returns null)');

  stopHeartbeat();
  loop.__resetForTest && loop.__resetForTest();
});

test('HIGH-2: heartbeat interval is comfortably under the 90s control-plane staleness threshold', () => {
  // The control-plane treats a heartbeat older than ~90s as a dead worker. The
  // liveness ticker MUST fire well under that so a long (>90s) cycle never looks
  // dead. This guards against a regression that bumps the interval too high.
  assert.ok(
    loop.HEARTBEAT_INTERVAL_MS < 90000,
    `heartbeat interval (${loop.HEARTBEAT_INTERVAL_MS}ms) must be < 90s staleness threshold`
  );
  assert.ok(
    loop.HEARTBEAT_INTERVAL_MS <= 30000,
    'heartbeat interval should leave generous margin (<= 30s) below the 90s threshold'
  );
});

// ─── HIGH (race): register-after-sweep orphan ────────────────────────────────
// shutdownAllBrowsers snapshots-then-clears liveBrowsers. A browser whose launch
// was parked in an await when SIGTERM landed would otherwise register into the
// already-swept Set and be orphaned on exit. registerBrowser must refuse (and
// close) the browser once shutdown has begun.

test('HIGH-race: registerBrowser refuses + closes a browser when shutdown already began', async () => {
  // Begin shutdown (sets the module shuttingDown flag, sweeps the empty Set).
  await shutdownAllBrowsers({ timeoutMs: 50 });

  // A browser whose launch "resolved" after the sweep tries to register.
  const late = makeFakeBrowser(makeFakeContext);
  const accepted = registerBrowser(late);

  assert.strictEqual(accepted, false, 'registration refused while shutting down');
  // registerBrowser closes it on a microtask — let that settle, then assert.
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(late.closed, 'the refused browser was closed, not orphaned');

  // And a SECOND shutdown must not find it lingering in the registry.
  late.closeCalls = 0;
  await shutdownAllBrowsers({ timeoutMs: 50 });
  assert.strictEqual(late.closeCalls, 0, 'refused browser was never added to liveBrowsers');

  loop.__resetForTest && loop.__resetForTest();
});

test('HIGH-race: runAccountSession aborts (no leak) when shutdown lands during launchBrowser()', async () => {
  // The integration path: launchBrowser is parked (awaiting) when SIGTERM fires.
  // We trigger shutdown DURING the launch await, then resolve the browser. The
  // session must abort without registering/leaking the late browser, and the
  // late browser must be closed.
  const late = makeFakeBrowser(makeFakeContext);

  const launchBrowser = async () => {
    // Simulate SIGTERM arriving while we're parked inside launch: flip shutdown
    // via the real exported shutdownAllBrowsers (which sets shuttingDown), then
    // resolve with the late browser as if the launch had already been in flight.
    await shutdownAllBrowsers({ timeoutMs: 50 });
    return late;
  };

  const account = { id: 1, name: 'racetest', checkIntervalMinutes: 7 };
  const ctx = { settings: {}, h: {}, withRetry: async () => undefined };

  // Must resolve cleanly (session aborts at the registration refusal).
  await runAccountSession(account, SESSION_PATH, {}, ctx, { launchBrowser });

  // The session never ran a cycle (it bailed before runCycleGuarded).
  assert.strictEqual(late.contextCalls, 0, 'no cycle ran on the late browser');
  // registerBrowser closed it on a microtask — let that settle.
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(late.closed, 'late browser closed, not orphaned into the swept registry');

  loop.__resetForTest && loop.__resetForTest();
});

// ─── MEDIUM: backoff resets after a healthy session, doubles while flapping ───

test('MEDIUM backoff: computeNextBackoff resets to base after a healthy session', () => {
  const { computeNextBackoff, RESTART_BACKOFF_BASE_MS, RESTART_BACKOFF_MAX_MS, HEALTHY_SESSION_MS } = loop;

  // A grown backoff (e.g. after several flaps) + a healthy-length session → base.
  assert.strictEqual(
    computeNextBackoff(RESTART_BACKOFF_MAX_MS, HEALTHY_SESSION_MS),
    RESTART_BACKOFF_BASE_MS,
    'healthy session (>= threshold) resets a maxed-out backoff to base'
  );
  assert.strictEqual(
    computeNextBackoff(80000, HEALTHY_SESSION_MS),
    RESTART_BACKOFF_BASE_MS,
    'healthy session at exactly the threshold resets to base'
  );
});

test('MEDIUM backoff: computeNextBackoff doubles (capped) while flapping (fast deaths)', () => {
  const { computeNextBackoff, RESTART_BACKOFF_BASE_MS, RESTART_BACKOFF_MAX_MS, HEALTHY_SESSION_MS } = loop;

  // Fast death from base → doubles.
  assert.strictEqual(
    computeNextBackoff(RESTART_BACKOFF_BASE_MS, 500),
    RESTART_BACKOFF_BASE_MS * 2,
    'a fast death doubles the backoff'
  );
  // Fast death just under the healthy threshold still counts as a flap → doubles.
  assert.strictEqual(
    computeNextBackoff(RESTART_BACKOFF_BASE_MS, HEALTHY_SESSION_MS - 1),
    RESTART_BACKOFF_BASE_MS * 2,
    'just-under-threshold death is a flap, not healthy'
  );
  // Doubling is capped at the max.
  assert.strictEqual(
    computeNextBackoff(RESTART_BACKOFF_MAX_MS, 500),
    RESTART_BACKOFF_MAX_MS,
    'backoff never exceeds the cap'
  );
  assert.strictEqual(
    computeNextBackoff(RESTART_BACKOFF_MAX_MS * 0.75, 500),
    RESTART_BACKOFF_MAX_MS,
    'a double that would exceed the cap is clamped to the cap'
  );
});
