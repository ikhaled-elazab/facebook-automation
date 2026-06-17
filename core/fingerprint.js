'use strict';

/**
 * core/fingerprint.js — shared browser-fingerprint defaults.
 *
 * DEFAULT_USER_AGENT is used whenever an account has no user_agent set (the
 * column is nullable and the UI / migration may leave it empty). It MUST be
 * identical at login time (login-flow.js) and at worker run time
 * (worker/loop.js): the worker reuses the session created at login via
 * storageState, and a user-agent that CHANGES between login and activity is a
 * fingerprint inconsistency Facebook's anti-bot can flag. Sharing one constant
 * across both call sites guarantees they always agree.
 *
 * It also prevents the crash that motivated this module: passing `null` to
 * Playwright's newContext({ userAgent }) throws
 *   "browser.newContext: userAgent: expected string, got object"
 * because typeof null === 'object'. The `|| DEFAULT_USER_AGENT` guard at each
 * call site turns a missing UA into a real string instead.
 */

// Realistic desktop Chrome UA (matches accounts.example.json). Bump the Chrome
// major version here when you want the fleet's default fingerprint to move; both
// the login flow and the worker pick it up from this single source of truth.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

module.exports = { DEFAULT_USER_AGENT };
