/**
 * pm2.config.js — process topology for the single-VPS deployment.
 *
 * Two long-lived apps, both managed by one pm2 daemon:
 *
 *   fb-control  — server/index.js. The Express control plane (loopback-only
 *                 management API + static UI). Always up; this is the operator's
 *                 way in (over an SSH tunnel) and the thing that supervises the
 *                 worker on demand. Restart it freely; it is stateless beyond the
 *                 SQLite file it shares with the worker.
 *
 *   fb-worker   — index.js. The chromium-heavy automation worker (one browser per
 *                 enabled account). The control plane STARTS/STOPS this app
 *                 PROGRAMMATICALLY (server/worker-control.js) by NAME, so the name
 *                 and script below are a HARD CONTRACT — see the matching note.
 *
 * ── HARD CONTRACT WITH server/worker-control.js ─────────────────────────────
 * The control plane drives the worker through pm2's programmatic API, building
 * its start config from FROZEN constants in server/config.js:
 *
 *     DEFAULTS.workerAppName = 'fb-worker'          (server/config.js:41)
 *     DEFAULTS.workerScript  = 'index.js'           (server/config.js:42)
 *     worker-control.start(): p.start({ name: 'fb-worker', script: <abs>/index.js, … })
 *                                                    (server/worker-control.js:107-117)
 *
 * Therefore the worker app HERE MUST be named exactly 'fb-worker' running
 * 'index.js'. If they diverge:
 *   - `pm2 start pm2.config.js` brings up a worker under one name, while the UI's
 *     Start/Stop manages the OTHER name → you end up with TWO worker processes,
 *     each opening its own browser per account → DOUBLE Facebook activity → BAN
 *     RISK, and the UI button appears to do nothing.
 * The previous config named it 'fb-bot' (the H5 mismatch); this is now corrected.
 *
 * ── H5 FIX: restart policy + chromium memory cap ────────────────────────────
 * The old config had `max_restarts: 10` and NO `max_memory_restart`. Two failure
 * modes flowed from that:
 *   1. SILENT PERMANENT DEATH — after 10 crashes pm2 gives up and the worker stays
 *      dead with no further attempts. On a headless VPS nobody notices until FB
 *      activity has been stopped for hours/days. The healthcheck (scripts/
 *      healthcheck.js) is the backstop, but the supervisor itself should also keep
 *      trying with backoff rather than abandoning the app.
 *   2. CHROMIUM MEMORY CREEP — long-running Playwright/chromium trees leak; with no
 *      memory ceiling the worker grows until the VPS OOM-killer reaps it (or thrashes
 *      swap), taking the control plane down with it. A bounded `max_memory_restart`
 *      makes pm2 recycle the worker on its OWN terms (clean SIGTERM → exit 0 → fresh
 *      start, all accounts resume from DB state) BEFORE the kernel intervenes.
 *
 * ── autorestart vs the control plane's deliberate stop ──────────────────────
 * The control plane stops the worker via pm2's `stop` verb (not by killing it).
 * `pm2 stop` parks the app in the "stopped" state and pm2 does NOT autorestart a
 * deliberately-stopped app — autorestart only reacts to a process that EXITS on its
 * own. So `autorestart: true` here does not fight a UI "Stop". (The worker also exits
 * 0 on SIGTERM — index.js:101 — so even an exit-path stop reads as a clean shutdown,
 * not a crash to be restarted.) autorestart only kicks in when the worker dies
 * UNEXPECTEDLY, which is exactly what we want.
 */

'use strict';

const path = require('path');

// Resolve scripts to absolute paths so `pm2 start pm2.config.js` behaves identically
// regardless of the operator's current working directory.
const ROOT = __dirname;

module.exports = {
  apps: [
    {
      // ── Control plane ──────────────────────────────────────────────────────
      name: 'fb-control',
      script: path.join(ROOT, 'server', 'index.js'),
      cwd: ROOT,
      exec_mode: 'fork', // single instance; it binds a fixed loopback port (no cluster)
      instances: 1,
      autorestart: true,
      watch: false,
      // The control plane is light (Express + SQLite reads). A ceiling here is a
      // safety net against an unexpected leak, generous enough never to trip in
      // normal operation.
      max_memory_restart: '300M',
      // Crash-loop protection: if it dies, wait then retry with pm2's exponential
      // backoff so a misconfig (e.g. bad .env) doesn't spin the CPU. min_uptime
      // means "a run shorter than this counts as a failed start" — it must stay up
      // 5s to be considered healthy.
      restart_delay: 3000,
      exp_backoff_restart_delay: 200,
      min_uptime: '5s',
      max_restarts: 15,
      // Named, separated logs (logs/ is gitignored). pm2 timestamps each line.
      error_file: path.join(ROOT, 'logs', 'fb-control.error.log'),
      out_file: path.join(ROOT, 'logs', 'fb-control.out.log'),
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      // ── Worker (chromium-heavy) ─────────────────────────────────────────────
      // NAME + SCRIPT ARE A CONTRACT — see the header. Must equal
      // server/config.js DEFAULTS.workerAppName ('fb-worker') and workerScript
      // ('index.js'). Do not rename without changing server/config.js in lockstep.
      name: 'fb-worker',
      script: path.join(ROOT, 'index.js'),
      cwd: ROOT,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      // CHROMIUM MEMORY CAP (H5). One browser per enabled account; each chromium
      // tree is heavy and leaks over long runs. 1G is a pragmatic ceiling for a
      // handful of accounts on a modest VPS — pm2 recycles the worker (clean
      // SIGTERM → exit 0 → all accounts resume from DB state) before the kernel
      // OOM-kills it and risks taking fb-control down too. If you run many
      // accounts, raise this in proportion (rough rule: ~250-350M per concurrent
      // account browser) AND make sure the VPS has the RAM + swap headroom.
      max_memory_restart: '1G',
      // RESTART POLICY (H5). Unlike the old `max_restarts: 10` that abandoned the
      // worker permanently, we keep retrying with exponential backoff so a
      // transient failure (FB hiccup, momentary network loss) self-heals, but a
      // hard crash-loop (e.g. corrupt session, missing .env) backs off instead of
      // hammering Facebook. min_uptime guards against fast crash loops: a run that
      // dies in under 20s counts as a failed start and feeds the backoff.
      //
      //   - exp_backoff_restart_delay: 1000  → delay grows 1s, 2s, 4s, … capped by
      //     pm2 (~15s), so a persistent failure is retried slowly, not in a tight
      //     loop, without ever giving up silently.
      //   - max_restarts: 50  → a high budget (not the old miserly 10) so the worker
      //     is not abandoned after a handful of transient blips. Combined with the
      //     backoff this cannot become a CPU spinner.
      //
      // BACKSTOP: scripts/healthcheck.js (cron) is the out-of-band detector for the
      // case where the worker is "up" per pm2 but silently wedged (stale heartbeat).
      // pm2's restart policy handles process death; the healthcheck handles liveness.
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      min_uptime: '20s',
      max_restarts: 50,
      // pm2's stop/restart sends SIGTERM; the worker closes all browsers then exits
      // (index.js gracefulShutdown). Give it room to drain chromium trees before pm2
      // escalates to SIGKILL — its internal hard deadline is 12s (index.js
      // SHUTDOWN_DEADLINE_MS), so 15s here leaves margin and avoids orphaned chromium.
      kill_timeout: 15000,
      error_file: path.join(ROOT, 'logs', 'fb-worker.error.log'),
      out_file: path.join(ROOT, 'logs', 'fb-worker.out.log'),
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
