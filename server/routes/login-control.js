'use strict';

/**
 * server/routes/login-control.js — account-level login control (Phase 3.5).
 *
 *   POST /api/accounts/:id/login        -> launch a login for that account.
 *                                          409 if one is already in progress.
 *   GET  /api/accounts/:id/login/status -> idle|running|needs_2fa|ok|failed (+detail)
 *   POST /api/accounts/:id/login/2fa    -> { code } fed into the paused login flow.
 *
 * Login is ACCOUNT-level (`:id` is the account id) — one login = one browser = one
 * stored session_file. It is NOT branch-scoped.
 *
 * SECURITY (identical posture to accounts.js / worker.js):
 *   - Behind requireAuth (the `/api` gate in app.js) + CSRF on every mutation.
 *   - `:id` is validated by idParamSchema; the 2FA body by login2faSchema
 *     (.strict()) so no extra keys ride along.
 *   - The 2FA code is transient — passed to the control layer, never logged here,
 *     never persisted. The control layer decrypts credentials at launch time; this
 *     route never touches plaintext credentials.
 *   - Responses carry ONLY the secret-free public session view (account_name,
 *     status, detail, started_at, finished_at) the control layer produces.
 *
 * The loginControl module is INJECTABLE (defaults to a freshly-created registry)
 * so tests substitute a fake that drives the state machine without a real browser.
 */

const express = require('express');
const { asyncHandler, parseOrThrow } = require('./helpers');
const { idParamSchema, login2faSchema } = require('../schemas');
const { createLoginControl } = require('../login-control');

/**
 * @param {object} deps
 * @param {import('express').RequestHandler} deps.csrfProtection CSRF middleware.
 * @param {object} [deps.loginControl] injectable login-session registry (defaults
 *   to a real createLoginControl()). One registry instance is shared across the
 *   router so a launch and its later /2fa land on the SAME in-process session.
 * @returns {import('express').Router}
 */
function loginControlRouter({ csrfProtection, loginControl }) {
  const router = express.Router();
  // A single registry instance for the lifetime of the app (state lives here).
  const control = loginControl || createLoginControl();

  // Launch a login for the account. Mutation → CSRF. The control layer throws a
  // ConflictError (→ 409) if a login is already in progress for this account, and
  // NotFound/BadRequest for missing account / unusable credentials — all flow
  // through the central error handler to the stable error shape.
  router.post(
    '/:id/login',
    csrfProtection,
    asyncHandler(async (req, res) => {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const view = control.launch(id);
      // 202 Accepted: the login was started and runs asynchronously (it may pause
      // at needs_2fa). The body carries the current public session view.
      res.status(202).json({ login: view });
    })
  );

  // Read login status. A read — no CSRF, no mutation. Returns idle when no session
  // has been started yet (stable shape; 404 only if the ACCOUNT does not exist).
  router.get(
    '/:id/login/status',
    asyncHandler(async (req, res) => {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const view = control.status(id);
      res.json({ login: view });
    })
  );

  // Provide a 2FA code mid-flow. Mutation → CSRF. The code is validated for shape
  // and handed straight to the paused session; the control layer 409s if the
  // session is not awaiting a code, 404s if there is no session/account.
  router.post(
    '/:id/login/2fa',
    csrfProtection,
    asyncHandler(async (req, res) => {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const { code } = parseOrThrow(login2faSchema, req.body);
      const view = control.provide2fa(id, code);
      res.json({ login: view });
    })
  );

  return router;
}

module.exports = { loginControlRouter };
