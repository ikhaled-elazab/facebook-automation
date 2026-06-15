'use strict';

/**
 * server/auth/rate-limit.js — login brute-force throttle.
 *
 * Limits failed login attempts per source. Because the control plane binds to
 * 127.0.0.1 and is reached over an SSH tunnel, the practical "source" is the
 * tunnel; the limiter still defends against a local process spraying guesses.
 *
 * We count FAILED attempts only (skipSuccessfulRequests) so a legitimate admin
 * logging in and out repeatedly is never locked out. The limiter is applied to
 * the login route only — read/CRUD routes use session auth, not this.
 */

const rateLimit = require('express-rate-limit');
const { TooManyRequestsError } = require('../errors');

/**
 * Build the login rate limiter.
 * @param {{loginRateMax:number, loginRateWindowMs:number}} cfg
 * @returns {import('express').RequestHandler}
 */
function loginRateLimiter(cfg) {
  return rateLimit({
    windowMs: cfg.loginRateWindowMs,
    limit: cfg.loginRateMax,
    skipSuccessfulRequests: true, // only failed logins count toward the cap
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new TooManyRequestsError('Too many login attempts. Try again later.'));
    },
  });
}

module.exports = { loginRateLimiter };
