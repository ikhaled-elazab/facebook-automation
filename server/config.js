'use strict';

/**
 * server/config.js — control-plane configuration, parsed + validated at startup.
 *
 * Fail-fast philosophy: a misconfigured control plane must refuse to boot rather
 * than start with insecure defaults (e.g. a guessable session secret, or auth
 * effectively disabled). Every secret is sourced from the environment; nothing
 * is hardcoded. This mirrors crypto.js's "throw loudly on missing key" stance.
 *
 * Required env (see .env.example):
 *   ADMIN_USER           — admin login username
 *   ADMIN_PASSWORD_HASH  — bcrypt hash of the admin password (see set-password.js)
 *   SESSION_SECRET       — >= 32 chars; signs the session cookie
 *   CSRF_SECRET          — >= 32 chars; signs the CSRF double-submit token
 *
 * Optional env:
 *   CONTROL_HOST         — bind host (default 127.0.0.1). MUST be loopback only
 *                          (127.0.0.1 / ::1 / localhost) — startup REJECTS any
 *                          other value so the control plane cannot be exposed.
 *   CONTROL_PORT         — bind port (default 8080)
 *   NODE_ENV             — 'production' enables Secure cookie flag
 *   WORKER_SCRIPT        — worker entry script for pm2 (default: index.js)
 *   SESSION_TTL_MS       — session lifetime (default 8h)
 *   CSRF_BOOTSTRAP_TTL_MS — pre-auth /csrf session lifetime (default 5m)
 *   LOGIN_RATE_MAX       — max failed logins per window (default 5)
 *   LOGIN_RATE_WINDOW_MS — login rate window (default 15m)
 */

const path = require('path');

/** @typedef {Object} ControlConfig */

const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 8080,
  sessionTtlMs: 8 * 60 * 60 * 1000, // 8 hours
  csrfBootstrapTtlMs: 5 * 60 * 1000, // 5 minutes (pre-auth /csrf session window)
  loginRateMax: 5,
  loginRateWindowMs: 15 * 60 * 1000, // 15 minutes
  workerAppName: 'fb-worker',
  workerScript: 'index.js',
});

const MIN_SECRET_LEN = 32;

/**
 * Hosts the control plane is permitted to bind. Loopback ONLY — the control
 * plane is reached over an SSH tunnel, never exposed on a routable interface.
 * A non-loopback CONTROL_HOST is a misconfiguration that must abort startup.
 */
const LOOPBACK_HOSTS = Object.freeze(new Set(['127.0.0.1', '::1', 'localhost']));

/**
 * Read + validate configuration from process.env.
 * Throws an aggregated error listing every problem (so ops fixes them in one pass).
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {Readonly<ControlConfig>}
 */
function loadConfig(env = process.env) {
  const problems = [];

  const adminUser = (env.ADMIN_USER || '').trim();
  if (!adminUser) problems.push('ADMIN_USER is required.');

  const adminPasswordHash = (env.ADMIN_PASSWORD_HASH || '').trim();
  if (!adminPasswordHash) {
    problems.push(
      'ADMIN_PASSWORD_HASH is required. Generate it: npm run set-password -- "<password>"'
    );
  } else if (!/^\$2[aby]\$\d{2}\$/.test(adminPasswordHash)) {
    problems.push('ADMIN_PASSWORD_HASH does not look like a bcrypt hash ($2a/$2b/$2y$...).');
  }

  const sessionSecret = env.SESSION_SECRET || '';
  if (sessionSecret.length < MIN_SECRET_LEN) {
    problems.push(`SESSION_SECRET must be at least ${MIN_SECRET_LEN} characters.`);
  }

  const csrfSecret = env.CSRF_SECRET || '';
  if (csrfSecret.length < MIN_SECRET_LEN) {
    problems.push(`CSRF_SECRET must be at least ${MIN_SECRET_LEN} characters.`);
  }

  const host = (env.CONTROL_HOST || DEFAULTS.host).trim();
  // SECURITY (INFO-1): enforce the localhost-only guarantee. A non-loopback bind
  // would expose the control plane on a routable interface; reject at startup so
  // a stray env can never silently make it publicly reachable.
  if (!LOOPBACK_HOSTS.has(host)) {
    problems.push(
      `CONTROL_HOST must be loopback only (127.0.0.1, ::1, or localhost); got "${host}". ` +
        'The control plane is reached over an SSH tunnel and must not bind a public interface.'
    );
  }

  const port = parsePositiveInt(env.CONTROL_PORT, DEFAULTS.port);
  if (port === null || port < 1 || port > 65535) {
    problems.push('CONTROL_PORT must be an integer in 1..65535.');
  }

  const sessionTtlMs = parsePositiveInt(env.SESSION_TTL_MS, DEFAULTS.sessionTtlMs);
  if (sessionTtlMs === null) problems.push('SESSION_TTL_MS must be a positive integer (ms).');

  const csrfBootstrapTtlMs = parsePositiveInt(
    env.CSRF_BOOTSTRAP_TTL_MS,
    DEFAULTS.csrfBootstrapTtlMs
  );
  if (csrfBootstrapTtlMs === null) {
    problems.push('CSRF_BOOTSTRAP_TTL_MS must be a positive integer (ms).');
  }

  const loginRateMax = parsePositiveInt(env.LOGIN_RATE_MAX, DEFAULTS.loginRateMax);
  if (loginRateMax === null) problems.push('LOGIN_RATE_MAX must be a positive integer.');

  const loginRateWindowMs = parsePositiveInt(env.LOGIN_RATE_WINDOW_MS, DEFAULTS.loginRateWindowMs);
  if (loginRateWindowMs === null) problems.push('LOGIN_RATE_WINDOW_MS must be a positive integer (ms).');

  if (problems.length > 0) {
    throw new Error(
      'Control-plane configuration invalid:\n  - ' + problems.join('\n  - ')
    );
  }

  const isProduction = env.NODE_ENV === 'production';

  // The worker script pm2 will launch. Resolved to an absolute path against the
  // project root so pm2's cwd does not matter. Hardcoded app name (no user input).
  const projectRoot = path.resolve(__dirname, '..');
  const workerScript = (env.WORKER_SCRIPT || DEFAULTS.workerScript).trim();

  return Object.freeze({
    host,
    port,
    isProduction,
    adminUser,
    adminPasswordHash,
    sessionSecret,
    csrfSecret,
    sessionTtlMs,
    csrfBootstrapTtlMs,
    loginRateMax,
    loginRateWindowMs,
    worker: Object.freeze({
      appName: DEFAULTS.workerAppName, // FIXED — never from user input
      script: path.isAbsolute(workerScript)
        ? workerScript
        : path.join(projectRoot, workerScript),
      cwd: projectRoot,
    }),
  });
}

/**
 * Parse a strictly-positive integer from a string env value.
 * Returns the fallback when the value is absent, or null when present but invalid.
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number|null}
 */
function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

module.exports = { loadConfig, DEFAULTS, MIN_SECRET_LEN };
