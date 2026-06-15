'use strict';

/**
 * server/worker-control.js — injection-safe worker supervision via pm2's
 * programmatic API.
 *
 * SECURITY (command-injection / privilege-escalation defense):
 *   - We use require('pm2') programmatically. There is NO child_process, NO exec,
 *     NO shell, and NO string interpolation of any user input anywhere here.
 *   - The pm2 start config is built ONLY from frozen constants in config.worker
 *     (hardcoded app name 'fb-worker', absolute script path). Request bodies never
 *     contribute to it. The only operations exposed are start/stop/restart of that
 *     single named app.
 *
 * COORDINATION (desired vs actual):
 *   - worker_state.desired_state in SQLite is the source of truth for INTENT.
 *     start()/stop() here only drive the pm2 MECHANISM. The route writes the DB
 *     desired_state; this module reports the mechanism's actual status.
 *   - The worker itself writes worker_state.status + last_heartbeat via db.heartbeat().
 *     /worker/status combines pm2's view, the DB desired/actual, and heartbeat age.
 *
 * Every pm2 call is bracketed connect -> op -> disconnect (disconnect in finally),
 * so we never leak a connection to the pm2 daemon.
 *
 * pm2 is lazy-required (only when a supervision verb runs) so the control plane
 * boots without opening pm2's IPC pipe unless/until the worker is actually
 * managed — smaller idle footprint and full isolation of the pm2 dependency.
 */

/** Lazily load pm2 only when a supervision operation is invoked. */
function getPm2() {
  return require('pm2');
}

/**
 * Run a function with a connected pm2 client, always disconnecting afterward.
 * @template T
 * @param {(p: import('pm2')) => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withPm2(fn) {
  const pm2 = getPm2();
  return new Promise((resolve, reject) => {
    pm2.connect((connErr) => {
      if (connErr) {
        // connect failed — nothing to disconnect.
        reject(wrapPm2Error('connect', connErr));
        return;
      }
      Promise.resolve()
        .then(() => fn(pm2))
        .then(
          (result) => {
            pm2.disconnect();
            resolve(result);
          },
          (opErr) => {
            pm2.disconnect();
            reject(opErr);
          }
        );
    });
  });
}

/** Normalize a pm2 callback error into a plain Error with a safe message. */
function wrapPm2Error(op, err) {
  const msg = err && err.message ? err.message : String(err);
  const e = new Error(`pm2 ${op} failed: ${msg}`);
  e.cause = err;
  return e;
}

/** Promisified pm2.describe — returns the first proc description or null. */
function describe(p, appName) {
  return new Promise((resolve, reject) => {
    p.describe(appName, (err, list) => {
      if (err) return reject(wrapPm2Error('describe', err));
      resolve(Array.isArray(list) && list.length > 0 ? list[0] : null);
    });
  });
}

/**
 * Start (or restart if already present) the worker app. Idempotent.
 * @param {{appName:string, script:string, cwd:string}} workerCfg
 * @returns {Promise<{action:'started'|'restarted', status:string}>}
 */
async function start(workerCfg) {
  return withPm2(async (p) => {
    const existing = await describe(p, workerCfg.appName);

    if (existing) {
      // App is known to pm2 — restart to apply a clean run (idempotent start).
      await new Promise((resolve, reject) => {
        p.restart(workerCfg.appName, (err, proc) => {
          if (err) return reject(wrapPm2Error('restart', err));
          resolve(proc);
        });
      });
      const after = await describe(p, workerCfg.appName);
      return { action: 'restarted', status: pm2Status(after) };
    }

    // Not known to pm2 — start fresh from the FIXED config object.
    //
    // ── SOURCE-OF-TRUTH NOTE (restart/memory policy lives in pm2.config.js) ────
    // The fields below (max_restarts / restart_delay, and the ABSENCE of a
    // max_memory_restart cap) DIVERGE from pm2.config.js, which sets the
    // production policy: max_restarts:50, exp_backoff_restart_delay:1000,
    // min_uptime:'20s', max_memory_restart:'1G', kill_timeout:15000 (the H5 fix).
    //
    // This divergence is SAFE under the documented runbook because this cold-start
    // branch is NOT the normal path: the operator brings the whole topology up with
    // `pm2 start pm2.config.js` (npm run pm2:start), which registers BOTH apps with
    // the full ecosystem policy. From then on the worker is KNOWN to pm2, so the
    // UI's Start button always lands in the restart() branch above — which preserves
    // the ecosystem-file policy and never touches these fields. This object is only
    // reached if the worker was never started from the ecosystem file at all (e.g.
    // an operator who skipped the runbook), in which case a conservative-but-
    // functional default is preferable to refusing to start.
    //
    // DO NOT treat these values as the policy. If you need to change restart or
    // memory behavior, edit pm2.config.js (the ecosystem file is the single source
    // of truth) and re-run `pm2 start pm2.config.js`. Editing only here would
    // create silent drift between the cold-start path and the steady-state policy.
    await new Promise((resolve, reject) => {
      p.start(
        {
          name: workerCfg.appName, // hardcoded constant
          script: workerCfg.script, // absolute path constant
          cwd: workerCfg.cwd,
          autorestart: true,
          max_restarts: 10,
          restart_delay: 10000,
          watch: false,
          env: { NODE_ENV: 'production' },
        },
        (err, proc) => {
          if (err) return reject(wrapPm2Error('start', err));
          resolve(proc);
        }
      );
    });
    const after = await describe(p, workerCfg.appName);
    return { action: 'started', status: pm2Status(after) };
  });
}

/**
 * Stop the worker app. Idempotent — stopping an absent/stopped app is a no-op.
 * @param {{appName:string}} workerCfg
 * @returns {Promise<{action:'stopped'|'noop', status:string}>}
 */
async function stop(workerCfg) {
  return withPm2(async (p) => {
    const existing = await describe(p, workerCfg.appName);
    if (!existing) {
      return { action: 'noop', status: 'stopped' };
    }
    await new Promise((resolve, reject) => {
      p.stop(workerCfg.appName, (err) => {
        // pm2 returns an error if the process is already stopped; treat that as noop.
        if (err && !/not.*found|already/i.test(err.message || '')) {
          return reject(wrapPm2Error('stop', err));
        }
        resolve();
      });
    });
    const after = await describe(p, workerCfg.appName);
    return { action: 'stopped', status: pm2Status(after) };
  });
}

/**
 * Read the pm2-reported status of the worker app without mutating anything.
 * @param {{appName:string}} workerCfg
 * @returns {Promise<{present:boolean, status:string, pid:number|null, uptime:number|null, restarts:number|null, cpu:number|null, memory:number|null}>}
 */
async function status(workerCfg) {
  return withPm2(async (p) => {
    const proc = await describe(p, workerCfg.appName);
    if (!proc) {
      return {
        present: false,
        status: 'stopped',
        pid: null,
        uptime: null,
        restarts: null,
        cpu: null,
        memory: null,
      };
    }
    const env = proc.pm2_env || {};
    const monit = proc.monit || {};
    return {
      present: true,
      status: pm2Status(proc),
      pid: proc.pid || null,
      uptime: env.pm_uptime || null,
      restarts: typeof env.restart_time === 'number' ? env.restart_time : null,
      cpu: typeof monit.cpu === 'number' ? monit.cpu : null,
      memory: typeof monit.memory === 'number' ? monit.memory : null,
    };
  });
}

/** Extract a normalized status string from a pm2 describe() entry. */
function pm2Status(proc) {
  if (!proc) return 'stopped';
  const s = proc.pm2_env && proc.pm2_env.status;
  return s || 'unknown';
}

module.exports = { start, stop, status };
