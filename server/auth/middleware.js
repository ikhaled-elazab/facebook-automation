'use strict';

/**
 * server/auth/middleware.js — session auth guard + credential verification.
 *
 * Single-login model: one admin user whose bcrypt hash lives in config
 * (ADMIN_PASSWORD_HASH). On successful login we mark the server-side session
 * authenticated; the cookie carries only an opaque session id (the session
 * payload lives in the SQLite-backed store, never in the cookie).
 *
 * SECURITY:
 *   - Password check uses bcrypt.compare (constant-time within bcrypt).
 *   - Username check uses a timing-safe comparison to avoid leaking which half of
 *     the credential pair was wrong.
 *   - We ALWAYS run a bcrypt compare even when the username is wrong (against a
 *     dummy hash) so response timing does not reveal username validity.
 *   - No credential material is ever logged.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { UnauthorizedError } = require('../errors');

// A valid bcrypt hash of a random string, used as a constant-time decoy when the
// submitted username does not match — keeps login timing uniform.
const DECOY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);

/**
 * Timing-safe string equality (length-independent: hashes both sides first so we
 * do not early-return on a length mismatch, which would itself leak length).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Verify submitted credentials against the configured admin.
 * Runs a bcrypt compare in BOTH the matching and non-matching username case so
 * the timing profile does not reveal whether the username existed.
 * @param {{adminUser:string, adminPasswordHash:string}} cfg
 * @param {string} username
 * @param {string} password
 * @returns {Promise<boolean>}
 */
async function verifyCredentials(cfg, username, password) {
  const userOk = safeEqual(username, cfg.adminUser);
  const hashToCheck = userOk ? cfg.adminPasswordHash : DECOY_HASH;
  const passOk = await bcrypt.compare(password, hashToCheck);
  return userOk && passOk;
}

/**
 * Express middleware: require an authenticated session.
 * @type {import('express').RequestHandler}
 */
function requireAuth(req, _res, next) {
  if (req.session && req.session.authenticated === true) {
    return next();
  }
  next(new UnauthorizedError());
}

module.exports = { verifyCredentials, requireAuth };
