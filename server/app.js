'use strict';

/* global setInterval */
// setInterval is a Node global; declared here because the shared eslint config
// (eslint.config.js, not owned by this module) lists setTimeout but not setInterval.

/**
 * server/app.js — Express application factory for the control plane.
 *
 * Wires, in security-critical order:
 *   1. helmet            — security response headers (CSP, nosniff, etc.) FIRST.
 *   2. cookie + json     — parsers (CSRF + session need parsed cookies/body).
 *   3. session           — SQLite-backed server-side sessions; opaque signed
 *                          cookie (httpOnly, SameSite=strict, Secure in prod).
 *   4. CSRF              — double-submit signed token; required on mutations.
 *   5. routes            — auth (public bits) + authed CRUD/settings/worker/status.
 *   6. 404 + error handler — LAST. Error handler maps to the stable error shape
 *                          and NEVER leaks stacks/internals to clients.
 *
 * The app is created without binding a port (server/index.js owns listen()), so
 * it is directly testable with node:test + a supertest-style raw request.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const SqliteStoreFactory = require('better-sqlite3-session-store');
const { doubleCsrf } = require('csrf-csrf');

const db = require('../db');
const { requireAuth } = require('./auth/middleware');
const { loginRateLimiter } = require('./auth/rate-limit');
const { authRouter } = require('./routes/auth');
const { accountsRouter } = require('./routes/accounts');
const { loginControlRouter } = require('./routes/login-control');
const { createLoginControl } = require('./login-control');
const { branchesRouter } = require('./routes/branches');
const { settingsRouter } = require('./routes/settings');
const { workerRouter } = require('./routes/worker');
const { statusRouter } = require('./routes/status');
const { toErrorResponse, NotFoundError } = require('./errors');

const SESSION_COOKIE = 'fbcp.sid';
const CSRF_COOKIE = 'fbcp.x-csrf';

// Built SPA assets (produced by `npm run ui:build` → web/dist). Served same-origin
// so the session cookie + CSRF token work with no CORS. Resolved to an absolute
// path from the project root so the cwd pm2/node runs under does not matter.
const SPA_DIST_DIR = path.resolve(__dirname, '..', 'web', 'dist');
const SPA_INDEX_HTML = path.join(SPA_DIST_DIR, 'index.html');

/**
 * Build the configured Express app.
 * @param {Readonly<object>} config  result of loadConfig()
 * @param {{logger?: {warn:Function, error:Function}, workerControl?: object}} [opts]
 *   workerControl is injectable for tests (defaults to the real pm2-backed module
 *   inside the worker router).
 * @returns {import('express').Express}
 */
function createApp(config, opts = {}) {
  const logger = opts.logger || console;
  const app = express();

  // Behind an SSH tunnel / loopback only — but if ever fronted by a local proxy,
  // trust loopback so Secure-cookie + rate-limit IP logic behave. Loopback only.
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  // 1) Security headers. API is JSON-only (no inline scripts) so a strict CSP
  //    that forbids everything but same-origin is appropriate; the UI phase can
  //    relax specific directives when it ships its own assets.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Same-origin WebSocket (the remote-browser login stream) needs an
          // explicit connect-src; 'self' covers ws://<same-host> over the tunnel.
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
        },
      },
      // HSTS only matters over TLS; the tunnel terminates TLS at SSH, so leave
      // helmet's default HSTS (it is a no-op over plain HTTP to localhost).
    })
  );

  // 2) Parsers. JSON only; cap body size to blunt memory-abuse.
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser(config.sessionSecret));

  // 3) Server-side session store in the SAME SQLite DB (survives restarts).
  //
  // NOTE: better-sqlite3-session-store starts an expired-session sweeper via
  // setInterval that it NEVER unref's and whose handle it discards (so it cannot
  // be cleared). Worse, its `clear` option is coded as `(opts.expired.clear) ||
  // true`, so `clear:false` cannot disable it — the timer ALWAYS runs. An un-
  // unref'd interval keeps the Node event loop alive forever, preventing clean
  // process exit (hangs the test runner and any embedding process).
  //
  // Fix: replace the prototype's one-line startInterval with an equivalent that
  // (a) unref's the timer so it never blocks process exit, and (b) stores the
  // handle on the instance so graceful shutdown can clear it. The sweeper still
  // fires for the lifetime of a running server (unref only affects exit blocking).
  const SqliteStore = SqliteStoreFactory(session);
  if (!SqliteStore.prototype.__sweepPatched) {
    SqliteStore.prototype.startInterval = function startIntervalUnref() {
      this._sweepTimer = setInterval(
        this.clearExpiredSessions.bind(this),
        this.expired.intervalMs
      );
      if (this._sweepTimer && typeof this._sweepTimer.unref === 'function') {
        this._sweepTimer.unref();
      }
    };
    SqliteStore.prototype.__sweepPatched = true;
  }
  const store = new SqliteStore({
    client: db.getDb(), // reuse the opened better-sqlite3 connection
    expired: { clear: true, intervalMs: 15 * 60 * 1000 },
  });
  // Expose for explicit teardown (graceful shutdown / tests).
  app.locals.sessionStore = store;

  // Capture the session middleware in a variable (not just app.use'd inline) so the
  // WebSocket upgrade handler (server/login-stream-ws.js) can run the SAME session
  // logic to authenticate a stream connection. Exposed via app.locals for index.js.
  const sessionMiddleware = session({
    name: SESSION_COOKIE,
    secret: config.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false, // no session row until login (or CSRF needs it)
    rolling: true, // refresh expiry on activity
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.isProduction,
      maxAge: config.sessionTtlMs,
      path: '/',
    },
  });
  app.use(sessionMiddleware);
  app.locals.sessionMiddleware = sessionMiddleware;

  // 4) CSRF — double-submit signed token bound to the session id.
  const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
    getSecret: () => config.csrfSecret,
    // Bind the CSRF token to the canonical express-session id (req.sessionID).
    // The /csrf endpoint persists the session (see routes/auth.js) so this id is
    // stable across the unauthenticated -> authenticated transition; on login we
    // re-issue a token bound to the regenerated session id.
    getSessionIdentifier: (req) => req.sessionID || 'anonymous',
    cookieName: CSRF_COOKIE,
    cookieOptions: {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.isProduction,
      path: '/',
    },
    size: 32,
    // Methods that mutate require a valid token; safe methods are ignored.
    ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
    getCsrfTokenFromRequest: (req) =>
      req.headers['x-csrf-token'] || (req.body && req.body._csrf),
  });

  // Health check — unauthenticated, no secrets, for liveness probes / tunnel test.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'fb-control-plane' });
  });

  // Auth router: /csrf + /me + /login are reachable pre-auth; /logout needs a
  // session but not the requireAuth gate. Login is rate-limited + CSRF-checked.
  app.use(
    '/api/auth',
    authRouter({
      config,
      csrfProtection: doubleCsrfProtection,
      generateCsrfToken,
      loginLimiter: loginRateLimiter(config),
    })
  );

  // Everything below /api requires authentication.
  app.use('/api', requireAuth);

  app.use('/api/accounts', accountsRouter({ csrfProtection: doubleCsrfProtection }));
  // Account-level login control (Phase 3.5). Mounted at /api/accounts so it owns
  // /api/accounts/:id/login[/status|/2fa]. Mounted AFTER accountsRouter — the
  // account item routes (/:id) match a SINGLE segment, so the two-segment
  // /api/accounts/:id/login paths fall through to here. The registry is injectable
  // (undefined in prod -> a real in-process registry created here) and exposed on
  // app.locals so graceful shutdown can abort in-flight login flows (no orphaned
  // chromium). A SINGLE registry instance is shared by every login route so a
  // launch and its later /2fa land on the same paused in-process session.
  const loginControl = opts.loginControl || createLoginControl({ logger });
  app.locals.loginControl = loginControl;
  app.use('/api/accounts', loginControlRouter({ csrfProtection: doubleCsrfProtection, loginControl }));
  // Branch CRUD is mounted at /api so it can own BOTH the account-scoped collection
  // (/api/accounts/:accountId/branches) and the branch-scoped item ops
  // (/api/branches/:id[/default]). It is registered AFTER accountsRouter so the
  // single-segment account routes (/api/accounts/:id) keep precedence — Express
  // `/:id` matches one segment, so `/api/accounts/5/branches` falls through to here.
  app.use('/api', branchesRouter({ csrfProtection: doubleCsrfProtection }));
  app.use('/api/settings', settingsRouter({ csrfProtection: doubleCsrfProtection }));
  app.use(
    '/api/worker',
    workerRouter({
      config,
      csrfProtection: doubleCsrfProtection,
      workerControl: opts.workerControl, // undefined in prod -> real module
      logger, // server-side-only logging of pm2 mechanism failures
    })
  );
  app.use('/api/status', statusRouter());

  // ──────────────────────────────────────────────────────────────────────────
  // 5b) Static SPA (the admin UI), served SAME-ORIGIN.
  //
  // Mounted AFTER every /api/* route so the API always takes precedence and an
  // unknown /api/* path still reaches the JSON 404 below (never the SPA HTML).
  // The built assets are immutable + content-hashed (Vite), so /assets/* gets a
  // long cache; index.html is always revalidated so a new deploy is picked up.
  //
  // Robust to an ABSENT build: before `npm run ui:build` has run, web/dist does
  // not exist. We must NOT crash `npm run control` — instead the SPA routes serve
  // a short, helpful message telling the operator to build the UI. The API is
  // fully functional regardless.
  const spaBuilt = fs.existsSync(SPA_INDEX_HTML);

  if (spaBuilt) {
    // Serve hashed static assets. `index:false` so directory requests fall
    // through to the explicit SPA fallback (single source of truth for index).
    app.use(
      express.static(SPA_DIST_DIR, {
        index: false,
        // Hashed asset filenames are safe to cache aggressively; HTML is not
        // hashed so express.static won't be the one serving it (index:false).
        setHeaders: (res, filePath) => {
          if (filePath.startsWith(path.join(SPA_DIST_DIR, 'assets'))) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );

    // SPA history fallback: serve index.html for client-side routes.
    // CONTRACT: only GET/HEAD, and NEVER /api/* (those must 404 as JSON). This is
    // the inverse of an over-broad matcher — API paths are explicitly excluded so
    // the SPA catch-all can never mask a real API 404 with HTML.
    app.get(/.*/, (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/healthz') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(SPA_INDEX_HTML, (err) => {
        if (err) next(err);
      });
    });
  } else {
    // No build yet — friendly guidance instead of a hard 404 on the root.
    app.get('/', (_req, res) => {
      res
        .status(200)
        .type('text/plain')
        .send(
          'Control plane is running, but the admin UI has not been built yet.\n' +
            'Run `npm run ui:build`, then reload this page.\n' +
            'The JSON API under /api/* is fully available now.'
        );
    });
  }

  // 404 for anything unmatched (Express 5 wildcard syntax). With the SPA mounted
  // this is reached by: unknown /api/* paths (always), and any path when the SPA
  // is not built. The JSON error shape is preserved for API clients.
  app.use((req, _res, next) => {
    next(new NotFoundError(`No route for ${req.method} ${req.path}`));
  });

  // 6) Central error handler — MUST be last and MUST have 4 args (Express
  //    identifies error handlers by arity; _next is required even if unused).
  app.use((err, req, res, _next) => {
    // CSRF library throws its own error type; normalize to 403.
    if (err && err.code === 'EBADCSRFTOKEN') {
      return res
        .status(403)
        .json({ error: { code: 'CSRF_INVALID', message: 'Invalid CSRF token' } });
    }
    if (err && err.name === 'ForbiddenError' && /csrf/i.test(err.message || '')) {
      return res
        .status(403)
        .json({ error: { code: 'CSRF_INVALID', message: 'Invalid CSRF token' } });
    }

    // Body-parser (express.json) errors are operational client errors, not 500s.
    // They carry a `type` (e.g. 'entity.too.large', 'entity.parse.failed') and a
    // status. Map them to a stable shape without leaking internals.
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large (max 256kb)' },
      });
    }
    if (err && (err.type === 'entity.parse.failed' || err.type === 'charset.unsupported')) {
      return res.status(400).json({
        error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
      });
    }

    const { status, body } = toErrorResponse(err);
    // Log full detail server-side only (never to the client). 5xx = unexpected.
    if (status >= 500) {
      logger.error('[control-plane] unhandled error:', err && err.stack ? err.stack : err);
    }
    res.status(status).json(body);
  });

  return app;
}

module.exports = { createApp, SESSION_COOKIE, CSRF_COOKIE };
