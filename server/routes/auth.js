'use strict';

/**
 * server/routes/auth.js — login / logout / session introspection.
 *
 * Flow:
 *   GET  /api/auth/csrf   -> issue a CSRF token (needed before any mutation/login)
 *   POST /api/auth/login  -> verify creds, regenerate session, mark authenticated
 *   POST /api/auth/logout -> destroy session + clear cookie
 *   GET  /api/auth/me     -> current auth status (for the UI to bootstrap)
 *
 * Session fixation defense: on successful login we regenerate the session id
 * (req.session.regenerate) so a pre-auth session id cannot be reused post-auth.
 */

const express = require('express');
const { asyncHandler, parseOrThrow } = require('./helpers');
const { loginSchema } = require('../schemas');
const { verifyCredentials } = require('../auth/middleware');
const { UnauthorizedError } = require('../errors');

/**
 * @param {{config: Readonly<object>, csrfProtection: import('express').RequestHandler, generateCsrfToken: Function, loginLimiter: import('express').RequestHandler}} deps
 * @returns {import('express').Router}
 */
function authRouter({ config, csrfProtection, generateCsrfToken, loginLimiter }) {
  const router = express.Router();

  // Issue a CSRF token. The double-submit pattern sets a signed cookie and
  // returns the matching token the client must echo in the x-csrf-token header.
  //
  // The token is bound to req.sessionID (see app.js getSessionIdentifier). With
  // saveUninitialized:false, an unmodified session is never persisted and its id
  // would change on the next request, invalidating the token. So we mark the
  // session and save() it here, fixing the sessionID before the token is issued.
  //
  // ABUSE GUARD (unbounded session-store growth): /csrf is reachable PRE-AUTH, so
  // every anonymous hit would otherwise persist a full 8h session row. We cap the
  // pre-auth bootstrap session to a short TTL — long enough to complete the very
  // next login POST, short enough that anonymous churn self-expires quickly. The
  // anon->authed flow is unaffected: on successful login we regenerate() the
  // session, and the fresh session inherits the default 8h TTL from the session
  // middleware. Only an already-authenticated session keeps its full lifetime.
  router.get('/csrf', (req, res, next) => {
    if (!req.session.authenticated) {
      // Short-lived bootstrap window for the impending login (default 5 min,
      // overridable via CSRF_BOOTSTRAP_TTL_MS).
      req.session.cookie.maxAge = config.csrfBootstrapTtlMs;
    }
    req.session.csrfBootstrap = true; // marks the session modified -> persisted
    req.session.save((err) => {
      if (err) return next(err);
      const token = generateCsrfToken(req, res);
      res.json({ csrf_token: token });
    });
  });

  // Login: rate-limited + CSRF-protected (mutating). Regenerate session on success.
  router.post(
    '/login',
    loginLimiter,
    csrfProtection,
    asyncHandler(async (req, res, next) => {
      const { username, password } = parseOrThrow(loginSchema, req.body);
      const ok = await verifyCredentials(config, username, password);
      if (!ok) {
        // Uniform message — never reveal which field was wrong.
        return next(new UnauthorizedError('Invalid credentials'));
      }
      // Defeat session fixation: new session id post-auth.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.authenticated = true;
        req.session.user = config.adminUser;
        req.session.loginAt = new Date().toISOString();
        res.json({ ok: true, user: config.adminUser });
      });
    })
  );

  // Logout: CSRF-protected. Destroy server session + clear cookie.
  router.post('/logout', csrfProtection, (req, res, next) => {
    if (!req.session) {
      res.clearCookie('fbcp.sid');
      return res.json({ ok: true });
    }
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('fbcp.sid');
      res.json({ ok: true });
    });
  });

  // Current auth status — safe to call unauthenticated (returns authenticated:false).
  router.get('/me', (req, res) => {
    const authed = !!(req.session && req.session.authenticated);
    res.json({
      authenticated: authed,
      user: authed ? req.session.user : null,
    });
  });

  return router;
}

module.exports = { authRouter };
