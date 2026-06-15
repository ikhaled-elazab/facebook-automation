'use strict';

/* global fetch */
// `fetch` is a Node 18+ global; declared here because the shared eslint config
// (eslint.config.js) does not list it among Node globals.

/**
 * test/contract.test.js — Express ↔ SPA contract-drift guard (P4-ts flag).
 *
 * The frontend (web/) consumes the control-plane API through hand-maintained
 * TypeScript interfaces in web/src/api/types.ts. Those types are NOT generated —
 * they mirror the server's serializers/route builders by convention, so the two
 * sides can silently drift (a server field renamed/removed, or a TS field the
 * server never sends). The frontend builds in a separate toolchain, so a Node
 * test never type-checks against the live API.
 *
 * This test closes that gap WITHOUT a TS toolchain: it parses the field names
 * out of the relevant interfaces in types.ts at runtime, then drives the REAL
 * endpoints (real Express app, real temp SQLite — same harness as server.test.js)
 * and asserts every field the UI's type depends on is actually present in the
 * response. If the server drops/renames a field the UI expects, OR the TS type
 * declares a field the server doesn't emit, this fails — catching drift in BOTH
 * directions before it reaches a user as a runtime `undefined`.
 *
 * Read-only on web/ + server/ (we only LEARN their shapes; we edit neither).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Temp DB + valid config BEFORE requiring app code (mirrors server.test.js).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbcontract-'));
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
const TYPES_PATH = path.join(__dirname, '..', 'web', 'src', 'api', 'types.ts');

let server;
let baseUrl;

const fakeWorkerControl = {
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

/**
 * Extract the top-level field names declared in a TS `interface <Name> { ... }`
 * block from a source string. Only the interface's OWN fields (not nested object
 * literals) are returned. Optional markers (`?`) are stripped from the name.
 * @param {string} src the full types.ts source
 * @param {string} interfaceName
 * @returns {string[]} declared field names
 */
function interfaceFields(src, interfaceName) {
  const re = new RegExp(`export interface ${interfaceName}\\s*(?:extends [^{]+)?{`);
  const m = re.exec(src);
  assert.ok(m, `interface ${interfaceName} not found in types.ts`);
  const start = m.index + m[0].length;

  // Walk braces to find the matching close for THIS interface body.
  let depth = 1;
  let i = start;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  const body = src.slice(start, i - 1);

  const fields = [];
  let nest = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    // Track nested object-literal depth so we only capture THIS level's keys.
    const opens = (line.match(/{/g) || []).length;
    const closes = (line.match(/}/g) || []).length;
    if (nest === 0) {
      // A field declaration looks like `name: Type;` or `name?: Type;`.
      const fm = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
      // Skip comment / index-signature (`[key: string]`) / blank lines.
      if (fm && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('[')) {
        fields.push(fm[1]);
      }
    }
    nest += opens - closes;
    if (nest < 0) nest = 0;
  }
  return fields;
}

/** Assert every TS-declared field is a key in the response object. */
function assertContainsFields(actual, expectedFields, label) {
  assert.ok(actual && typeof actual === 'object', `${label}: response object present`);
  const missing = expectedFields.filter((f) => !(f in actual));
  assert.deepStrictEqual(missing, [], `${label}: server is MISSING TS-declared field(s): ${missing.join(', ')}`);
}

// ── Cookie-aware client (CSRF flow) ──────────────────────────────────────────

function makeClient() {
  const cookies = new Map();
  const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  function store(res) {
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
    store(res);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json };
  }
  return { req };
}

let typesSrc;
let client;

before(async () => {
  db.getDb();
  // Seed one account so /accounts returns a populated Account to inspect.
  // v2: the account is the LOGIN ENVELOPE only — the per-target field
  // target_page_url moved to branches, so it is NOT an account column anymore.
  // The status endpoint (StatusAccountSummary) needs a branch under the account so
  // the per-account rollup populates its branches[] drill-down.
  const contractAcctId = db.insertAccount({
    name: 'contractAcct',
    email: 'c@x.com',
    password_enc: 'iv:tag:ct',
    session_file: 'sessions/c.json',
  });
  db.insertBranch({
    account_id: contractAcctId,
    name: 'default',
    is_default: 1,
    target_page_url: 'https://fb.com/page',
  });

  typesSrc = fs.readFileSync(TYPES_PATH, 'utf8');

  const app = createApp(loadConfig(), {
    logger: { warn() {}, error() {} },
    workerControl: fakeWorkerControl,
  });
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Authenticate (the reads below are behind requireAuth).
  client = makeClient();
  const csrf = (await client.req('GET', '/api/auth/csrf')).json.csrf_token;
  const login = await client.req('POST', '/api/auth/login', {
    body: { username: 'admin', password: ADMIN_PASSWORD },
    csrf,
  });
  assert.strictEqual(login.status, 200, 'login succeeds for the contract reads');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── /accounts → Account[] ─────────────────────────────────────────────────────

test('GET /api/accounts items contain every field the TS Account interface declares', async () => {
  const fields = interfaceFields(typesSrc, 'Account');
  assert.ok(fields.length >= 15, `sanity: parsed a plausible Account field set (${fields.length})`);
  const res = await client.req('GET', '/api/accounts');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.json.accounts) && res.json.accounts.length > 0, 'accounts array populated');
  assertContainsFields(res.json.accounts[0], fields, 'Account');
});

// ── /settings → Settings ──────────────────────────────────────────────────────

test('GET /api/settings contains every field the TS Settings interface declares', async () => {
  const fields = interfaceFields(typesSrc, 'Settings');
  // Pacing fields must be present — the UI edits them, the governor enforces them.
  for (const required of ['pacing_enabled', 'global_daily_action_cap', 'active_hours_start', 'active_hours_end']) {
    assert.ok(fields.includes(required), `Settings TS type declares ${required}`);
  }
  const res = await client.req('GET', '/api/settings');
  assert.strictEqual(res.status, 200);
  assertContainsFields(res.json.settings, fields, 'Settings');
});

// ── /worker/status → WorkerStatus ─────────────────────────────────────────────

test('GET /api/worker/status contains every top-level field the TS WorkerStatus declares', async () => {
  const fields = interfaceFields(typesSrc, 'WorkerStatus');
  const res = await client.req('GET', '/api/worker/status');
  assert.strictEqual(res.status, 200);
  assertContainsFields(res.json, fields, 'WorkerStatus');
  // The nested heartbeat object is its own contract — assert its fields too.
  const hbFields = interfaceFields(typesSrc, 'HeartbeatHealth');
  assertContainsFields(res.json.heartbeat, hbFields, 'WorkerStatus.heartbeat');
});

// ── /status → StatusResponse (+ nested account summary) ───────────────────────

test('GET /api/status contains every field the TS StatusResponse declares', async () => {
  const fields = interfaceFields(typesSrc, 'StatusResponse');
  const res = await client.req('GET', '/api/status');
  assert.strictEqual(res.status, 200);
  assertContainsFields(res.json, fields, 'StatusResponse');
  // Per-account summary shape (the UI reads actions_today off each entry).
  const summaryFields = interfaceFields(typesSrc, 'StatusAccountSummary');
  assert.ok(Array.isArray(res.json.accounts) && res.json.accounts.length > 0, 'status accounts populated');
  assertContainsFields(res.json.accounts[0], summaryFields, 'StatusAccountSummary');
});

// ── /status/events → EventsResponse (the feed) ────────────────────────────────

test('GET /api/status/events contains every field the TS EventsResponse declares', async () => {
  // Seed a couple of action_log rows so events is non-empty.
  db.logAction({ actionType: 'monitor', status: 'ok', detail: 'contract-1' });
  db.logAction({ actionType: 'like', status: 'ok', detail: 'contract-2' });
  const fields = interfaceFields(typesSrc, 'EventsResponse');
  const res = await client.req('GET', '/api/status/events?limit=10');
  assert.strictEqual(res.status, 200);
  assertContainsFields(res.json, fields, 'EventsResponse');
  const eventFields = interfaceFields(typesSrc, 'ActionLogEvent');
  assert.ok(Array.isArray(res.json.events) && res.json.events.length > 0, 'events populated');
  assertContainsFields(res.json.events[0], eventFields, 'ActionLogEvent');
});
