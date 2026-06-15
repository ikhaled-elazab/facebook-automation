'use strict';

/**
 * server/login-control.js — account-level login-session supervision for the
 * control plane. The server-side counterpart to worker-control.js, but for the
 * INTERACTIVE, RESUMABLE login flow rather than a detached pm2 process.
 *
 * WHY AN IN-PROCESS REGISTRY (and not pm2 like the worker):
 *   The worker is a long-lived detached process pm2 owns. A login is a short,
 *   INTERACTIVE flow that PAUSES at 2FA waiting for a code the operator types into
 *   the UI mid-flow. That pause/resume must be driven from within the control-
 *   plane process (the route that accepts POST /login/2fa must hand the code to
 *   the exact paused flow). So login sessions live IN-PROCESS, one per account, in
 *   this registry — exactly one active LoginSession per account at a time.
 *
 * STATE MACHINE (delegated to login-flow.js LoginSession):
 *   idle → running → needs_2fa → (code) → running → ok | failed
 *
 * CONCURRENCY CONTRACT:
 *   - launch(accountId) refuses (throws ConflictError → 409) if a NON-terminal
 *     session already exists for that account. A terminal (ok/failed) session is
 *     replaced on the next launch (re-login is allowed once the prior attempt has
 *     settled).
 *   - one account → at most one live login session.
 *
 * SECURITY (deep-reviewer discipline):
 *   - Credentials are DECRYPTED here at launch time (crypto.decrypt) from the DB
 *     row, handed to the LoginSession, and never held by the registry beyond the
 *     synchronous launch call. The plaintext password is NOT stored on the session
 *     map, NOT logged, NOT returned by status().
 *   - The 2FA code passed to provide2fa() is transient — fed straight into the
 *     paused flow, never logged, never persisted.
 *   - status()/the public view exposes ONLY {account_name, status, detail,
 *     started_at, finished_at} — no email, no password, no code.
 */

const db = require('../db');
const { decrypt } = require('../crypto');
const { accountEnvelope } = require('../worker/loadConfig');
const {
  LoginSession,
  LOGIN_STATES,
  TERMINAL_STATES,
  defaultLaunchBrowser,
} = require('../login-flow');
const { NotFoundError, ConflictError, BadRequestError } = require('./errors');

/**
 * Create a login-session registry. Browser launching + the data layer are
 * injectable so tests drive the full state machine + DB/crypto wiring without a
 * real browser or a live Facebook.
 *
 * @param {object} [deps]
 * @param {object} [deps.db] data layer (defaults to the real db.js).
 * @param {Function} [deps.decrypt] crypto.decrypt (defaults to the real one).
 * @param {Function} [deps.launchBrowser] async (settings) => Browser (defaults to
 *   the stealth chromium launcher). Tests inject a fake page-driver here.
 * @param {Function} [deps.makeSession] factory (params, sessionDeps) => LoginSession
 *   (defaults to `new LoginSession`). Lets tests substitute a fake session entirely.
 * @param {{warn:Function, error:Function}} [deps.logger] server-side-only logger.
 * @returns {object} the registry API.
 */
function createLoginControl(deps = {}) {
  const data = deps.db || db;
  const decryptFn = deps.decrypt || decrypt;
  const launchBrowser = deps.launchBrowser || defaultLaunchBrowser;
  const makeSession =
    deps.makeSession || ((params, sessionDeps) => new LoginSession(params, sessionDeps));
  const logger = deps.logger || console;

  /** @type {Map<number, LoginSession>} accountId → live/last login session. */
  const sessions = new Map();

  /**
   * Resolve the credentials + envelope for an account from the DB at launch time.
   * Decrypts the password (required) and proxy password (optional) HERE; the
   * plaintext lives only for the duration of the launch call.
   * @param {number} accountId
   * @returns {{env:object, email:string, password:string, proxyPassword:string|undefined, settings:object}}
   * @throws {NotFoundError} if the account does not exist
   * @throws {BadRequestError} if no usable password can be resolved
   */
  function resolveLaunchParams(accountId) {
    const row = data.getAccountById(accountId);
    if (!row) throw new NotFoundError('Account not found');

    const env = accountEnvelope(row);
    const settings = data.getSettings();

    const email = env.email || '';
    if (!email) {
      // The server has no terminal to prompt — a missing email is a hard error.
      throw new BadRequestError(
        'Account has no email on file. Set the account email before logging in.'
      );
    }

    // Password: DB ciphertext is the canonical server path (no env/prompt fallback
    // server-side). A decrypt failure or absent ciphertext is a clean 400 telling
    // the operator to (re)enter the password via the account editor.
    let password = '';
    if (env.passwordEnc) {
      try {
        password = decryptFn(env.passwordEnc) || '';
      } catch (err) {
        // Never log the ciphertext/secret — only the failure reason, server-side.
        logger.error(
          `[login-control] password decrypt failed for account ${accountId}: ${err.message}`
        );
        throw new BadRequestError(
          'Stored password could not be decrypted. Re-enter the account password and try again.'
        );
      }
    }
    if (!password) {
      throw new BadRequestError(
        'No stored password for this account. Set the password via the account editor, then log in.'
      );
    }

    let proxyPassword;
    const proxyEnc = env.proxy && env.proxy.passwordEnc;
    if (proxyEnc) {
      try {
        proxyPassword = decryptFn(proxyEnc) || undefined;
      } catch (err) {
        // Proxy auth is non-fatal — proceed without it (parity with worker/loop.js).
        logger.warn(
          `[login-control] proxy password decrypt failed for account ${accountId}: ${err.message}`
        );
        proxyPassword = undefined;
      }
    }

    return { env, email, password, proxyPassword, settings };
  }

  /**
   * Launch a login for an account. Refuses (409) if a non-terminal session is
   * already live for that account. Drives the flow asynchronously (the route
   * returns immediately with status=running); 2FA is resolved later via provide2fa.
   * @param {number} accountId
   * @returns {object} the public session view at launch (status: running|needs_2fa|...).
   * @throws {ConflictError} if a login is already in progress for this account
   * @throws {NotFoundError|BadRequestError} per resolveLaunchParams
   */
  function launch(accountId) {
    const existing = sessions.get(accountId);
    if (existing && !TERMINAL_STATES.has(existing.status)) {
      throw new ConflictError('A login is already in progress for this account.');
    }

    const { env, email, password, proxyPassword, settings } = resolveLaunchParams(accountId);

    const session = makeSession(
      { account: env, email, password, settings, proxyPassword },
      {
        launchBrowser: () => launchBrowser(settings),
        // Server-side logger is intentionally a no-op for flow chatter to avoid any
        // risk of secret leakage in control-plane logs; real failures are surfaced
        // via session.detail (which is secret-free).
        logger: () => {},
      }
    );
    sessions.set(accountId, session);

    // Drive the flow in the background. run() NEVER throws (it maps every failure
    // to the `failed` terminal state), so a bare .catch() is belt-and-suspenders.
    session.run().catch((err) => {
      logger.error(`[login-control] login flow crashed for account ${accountId}: ${err.message}`);
    });

    return session.toPublic();
  }

  /**
   * Read the current login status for an account (secret-free public view).
   * Returns an explicit idle view when no session has ever been started, so the
   * UI can render a stable shape without a 404 for the common "not yet" case.
   * @param {number} accountId
   * @returns {object} public session view
   * @throws {NotFoundError} if the account itself does not exist
   */
  function status(accountId) {
    if (!data.getAccountById(accountId)) throw new NotFoundError('Account not found');
    const session = sessions.get(accountId);
    if (!session) {
      const row = data.getAccountById(accountId);
      return {
        account_name: row.name,
        status: LOGIN_STATES.IDLE,
        detail: null,
        started_at: null,
        finished_at: null,
      };
    }
    return session.toPublic();
  }

  /**
   * Feed a 2FA code into an account's paused login flow.
   * @param {number} accountId
   * @param {string} code the 2FA / SMS code (transient — never logged/persisted).
   * @returns {object} the public session view after accepting the code.
   * @throws {NotFoundError} if the account does not exist OR has no session.
   * @throws {ConflictError} if the session is not awaiting a 2FA code.
   */
  function provide2fa(accountId, code) {
    if (!data.getAccountById(accountId)) throw new NotFoundError('Account not found');
    const session = sessions.get(accountId);
    if (!session) throw new NotFoundError('No login session for this account.');
    if (session.status !== LOGIN_STATES.NEEDS_2FA) {
      throw new ConflictError(
        `Login session is not awaiting a 2FA code (status: ${session.status}).`
      );
    }
    const accepted = session.provide2fa(code);
    if (!accepted) {
      // Race: it moved off needs_2fa between the check and the call.
      throw new ConflictError('Login session is no longer awaiting a 2FA code.');
    }
    return session.toPublic();
  }

  /**
   * Abort all in-flight login sessions (graceful shutdown). Best-effort; never
   * throws. Used by server shutdown so no chromium is orphaned on process exit.
   * @returns {Promise<void>}
   */
  async function abortAll() {
    const live = [...sessions.values()].filter((s) => !TERMINAL_STATES.has(s.status));
    await Promise.all(live.map((s) => s.abort().catch(() => {})));
  }

  return { launch, status, provide2fa, abortAll };
}

module.exports = { createLoginControl };
