'use strict';

/**
 * server/index.js — control-plane entry point.
 *
 * Responsibilities:
 *   - Load .env, parse + validate config (fail fast on misconfig).
 *   - Create the Express app and bind it to 127.0.0.1 ONLY (loopback). This is a
 *     HARD security requirement: the control plane is reached via an SSH tunnel on
 *     the VPS and must never listen on a public interface.
 *   - Wire graceful shutdown (SIGINT/SIGTERM): stop accepting connections, close
 *     the DB, exit cleanly.
 *
 * Run:  npm run control   (or: node server/index.js)
 */

require('dotenv').config();

const { loadConfig } = require('./config');
const { createApp } = require('./app');
const db = require('../db');
const { isKeyConfigured } = require('../crypto');

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('[control-plane] FATAL:', err.message);
    process.exit(1);
    return;
  }

  // The encryption key is required to store/return account credentials safely.
  // Warn loudly if absent — account create/update will fail at encrypt() time.
  if (!isKeyConfigured()) {
    console.error(
      '[control-plane] WARNING: APP_ENCRYPTION_KEY is missing/invalid. ' +
        'Account credential writes will fail until it is set (see .env.example).'
    );
  }

  // Initialize DB (applies schema + singletons) before serving.
  db.getDb();

  const app = createApp(config);

  // BIND TO LOOPBACK ONLY. Passing the host explicitly prevents binding 0.0.0.0.
  const server = app.listen(config.port, config.host, () => {
    console.log(
      `[control-plane] listening on http://${config.host}:${config.port} ` +
        `(env=${config.isProduction ? 'production' : 'development'})`
    );
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[control-plane] FATAL: port ${config.port} already in use.`);
    } else {
      console.error('[control-plane] FATAL server error:', err.message);
    }
    process.exit(1);
  });

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[control-plane] ${signal} received, shutting down...`);
    // Abort any in-flight login flows FIRST so their browsers close cleanly and no
    // chromium process tree is orphaned on exit (parity with the worker's HIGH-3
    // shutdown discipline). Best-effort + bounded by the hard-exit timer below.
    const loginControl = app.locals && app.locals.loginControl;
    Promise.resolve(loginControl ? loginControl.abortAll() : undefined)
      .catch((e) => console.error('[control-plane] error aborting login flows:', e.message))
      .finally(() => {
        server.close((closeErr) => {
          if (closeErr) console.error('[control-plane] error closing server:', closeErr.message);
          try {
            db.closeDb();
          } catch (e) {
            console.error('[control-plane] error closing DB:', e.message);
          }
          process.exit(closeErr ? 1 : 0);
        });
      });
    // Hard exit if connections do not drain promptly.
    setTimeout(() => {
      console.error('[control-plane] forced exit after shutdown timeout.');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

// Only run when invoked directly (so tests can require app.js without binding).
if (require.main === module) {
  main();
}

module.exports = { main };
