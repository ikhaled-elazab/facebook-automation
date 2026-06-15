#!/usr/bin/env node
'use strict';

/* global AbortController, fetch, clearTimeout, setTimeout */
// Node 18+ globals — declared for the shared eslint config, same convention as
// scripts/healthcheck.js. `fetch`/`AbortController` back the bounded /healthz probe.

/**
 * scripts/ops-probe.js — host-level operational probes for one VPS (obs #5).
 *
 * WHY THIS EXISTS
 *   healthcheck.js  → is the worker ALIVE (heartbeat)?
 *   error-rate.js   → is the worker WORKING (action failures / ban signal)?
 *   ops-probe.js    → is the HOST + control plane OK? Three host-level failures that
 *                     silently take the whole deployment down on a headless VPS:
 *
 *     1. CONTROL-PLANE DOWN — the Express management API (fb-control) is the
 *        operator's only way in over the SSH tunnel. If it's down, the UI is dead
 *        and the worker is unmanageable. We probe GET /healthz over loopback.
 *
 *     2. DISK FULL — SQLite (WAL), pm2 logs, logger.js's automation_*.log, and
 *        chromium temp all write to disk. A full disk corrupts the DB and wedges
 *        the worker with cryptic errors. We check the mount holding the project.
 *
 *     3. RESTART STORM — pm2 keeps restarting a crash-looping app. A single restart
 *        count is meaningless; the SIGNAL is the DELTA since the last probe. We
 *        persist the last counts and alert when restarts/min exceeds a threshold —
 *        the classic "is something crash-looping right now?" signal.
 *
 *   Designed for the single-VPS model: this runs ON the same host (the control
 *   plane binds loopback-only, so a remote probe can't reach it anyway).
 *
 * EXIT CODES (cron / uptime-kuma / monit friendly)
 *   0  HEALTHY     — all three checks pass.
 *   1  UNHEALTHY   — at least one check tripped. THE PAGE. (reasons[] lists which.)
 *   2  PROBE ERROR — the probe itself could not run a check meaningfully (rare).
 *
 * TUNABLES (env-overridable)
 *   CONTROL_PORT / CONTROL_HOST   where fb-control listens   (default 127.0.0.1:8080)
 *   OPS_HEALTHZ_TIMEOUT_MS        /healthz probe timeout      (default 4000)
 *   OPS_DISK_THRESHOLD_PCT        disk use% that trips        (default 90)
 *   OPS_RESTART_RATE_PER_MIN      restarts/min that trips     (default 3)
 *   OPS_WEBHOOK_URL               optional alert webhook
 *   OPS_WEBHOOK_TIMEOUT_MS        bounded POST timeout        (default 5000)
 *   OPS_STATE_FILE                restart-delta state         (default logs/ops-probe.state.json)
 *
 * USAGE
 *   node scripts/ops-probe.js            # exit code only (cron-friendly)
 *   node scripts/ops-probe.js --json     # machine-readable result on stdout
 *   node scripts/ops-probe.js --quiet    # suppress the human stderr line
 *   npm run probe:ops                    # same as the bare invocation
 *
 * RAW SHELL EQUIVALENTS (documented in docs/RUNBOOK.md §11 for operators who prefer
 * one-liners over this script). This script bundles them with bounded timeouts +
 * a single alert path + restart-delta state, which the shell one-liners can't do.
 */

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ── Tunables ──────────────────────────────────────────────────────────────────--

// Defaults MUST match server/config.js DEFAULTS (host 127.0.0.1, port 8080) so the
// probe reaches the control plane out-of-the-box with no extra env wiring.
const CONTROL_HOST = (process.env.CONTROL_HOST || '127.0.0.1').trim();
const CONTROL_PORT = positiveIntEnv('CONTROL_PORT', 8080);
const HEALTHZ_TIMEOUT_MS = positiveIntEnv('OPS_HEALTHZ_TIMEOUT_MS', 4000);
const DISK_THRESHOLD_PCT = positiveIntEnv('OPS_DISK_THRESHOLD_PCT', 90);
const RESTART_RATE_PER_MIN = positiveNumEnv('OPS_RESTART_RATE_PER_MIN', 3);
const WEBHOOK_URL = (process.env.OPS_WEBHOOK_URL || '').trim();
const WEBHOOK_TIMEOUT_MS = positiveIntEnv('OPS_WEBHOOK_TIMEOUT_MS', 5000);
const STATE_FILE =
  (process.env.OPS_STATE_FILE || '').trim() ||
  path.join(__dirname, '..', 'logs', 'ops-probe.state.json');

const FLAGS = new Set(process.argv.slice(2));
const AS_JSON = FLAGS.has('--json');
const QUIET = FLAGS.has('--quiet');

const VERDICT = Object.freeze({ HEALTHY: 0, UNHEALTHY: 1, PROBE_ERROR: 2 });

// ── Check 1: control-plane /healthz liveness ──────────────────────────────────--

async function checkControlPlane() {
  const url = `http://${CONTROL_HOST}:${CONTROL_PORT}/healthz`;
  if (typeof fetch !== 'function') {
    return { name: 'control_plane', ok: null, detail: 'fetch unavailable (old Node) — skipped' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTHZ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return { name: 'control_plane', ok: false, detail: `GET /healthz returned HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => null);
    if (!body || body.ok !== true) {
      return { name: 'control_plane', ok: false, detail: 'GET /healthz body missing {ok:true}' };
    }
    return { name: 'control_plane', ok: true, detail: 'control plane responding on /healthz' };
  } catch (err) {
    return {
      name: 'control_plane',
      ok: false,
      detail: `control plane unreachable at ${url}: ${err.name === 'AbortError' ? 'timeout' : err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Check 2: disk usage of the mount holding the project ──────────────────────--

function checkDisk() {
  const target = path.join(__dirname, '..');
  try {
    // `df -P` gives a portable, stable single-line-per-fs format (POSIX). We read
    // the mount that holds the project dir. execFileSync (no shell) — no injection.
    const out = execFileSync('df', ['-P', target], { encoding: 'utf8', timeout: 4000 });
    const lines = out.trim().split('\n');
    if (lines.length < 2) {
      return { name: 'disk', ok: null, detail: 'could not parse df output' };
    }
    // Columns: Filesystem 1024-blocks Used Available Capacity Mounted-on
    // Capacity is e.g. "87%". Mounted-on may contain spaces, so take the 5th token.
    const cols = lines[1].trim().split(/\s+/);
    const capRaw = cols[4] || '';
    const usePct = Number(capRaw.replace('%', ''));
    if (!Number.isFinite(usePct)) {
      return { name: 'disk', ok: null, detail: `could not parse disk capacity from "${capRaw}"` };
    }
    if (usePct >= DISK_THRESHOLD_PCT) {
      return {
        name: 'disk',
        ok: false,
        detail: `disk ${usePct}% used >= ${DISK_THRESHOLD_PCT}% threshold (mount for ${target}) — free space NOW (SQLite/WAL corruption risk)`,
      };
    }
    return { name: 'disk', ok: true, detail: `disk ${usePct}% used (< ${DISK_THRESHOLD_PCT}%)` };
  } catch (err) {
    return { name: 'disk', ok: null, detail: `df check failed: ${err.message}` };
  }
}

// ── Check 3: pm2 restart storm (delta since last probe) ───────────────────────--

/**
 * Read pm2's restart counts via `pm2 jlist` (JSON, no shell). Compare against the
 * persisted last counts to compute restarts/min. First run (no state) records a
 * baseline and reports healthy — a delta needs two samples.
 */
function checkRestartStorm() {
  let list;
  try {
    const out = execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 6000 });
    list = JSON.parse(out);
  } catch (err) {
    return { name: 'restart_storm', ok: null, detail: `pm2 jlist failed: ${err.message}` };
  }
  if (!Array.isArray(list)) {
    return { name: 'restart_storm', ok: null, detail: 'pm2 jlist did not return an array' };
  }

  const now = Date.now();
  const current = {};
  for (const proc of list) {
    const name = proc && proc.name;
    const restarts = proc && proc.pm2_env && typeof proc.pm2_env.restart_time === 'number'
      ? proc.pm2_env.restart_time
      : 0;
    if (name) current[name] = restarts;
  }

  const prev = readState();
  // Persist the new sample regardless of verdict (best-effort).
  writeState({ at: now, counts: current });

  if (!prev || !prev.at || !prev.counts) {
    return { name: 'restart_storm', ok: true, detail: 'baseline recorded (need a second sample for a delta)' };
  }

  const elapsedMin = Math.max((now - prev.at) / 60000, 1 / 60); // floor at 1s
  const storming = [];
  for (const [name, count] of Object.entries(current)) {
    const before = typeof prev.counts[name] === 'number' ? prev.counts[name] : count;
    const delta = count - before;
    if (delta <= 0) continue; // count can reset (pm2 restart of pm2 itself); ignore.
    const ratePerMin = delta / elapsedMin;
    if (ratePerMin >= RESTART_RATE_PER_MIN) {
      storming.push(`${name}: ${delta} restart(s) in ${elapsedMin.toFixed(1)}m (${ratePerMin.toFixed(1)}/min)`);
    }
  }

  if (storming.length > 0) {
    return {
      name: 'restart_storm',
      ok: false,
      detail: `RESTART STORM (>= ${RESTART_RATE_PER_MIN}/min): ${storming.join('; ')} — a process is crash-looping`,
    };
  }
  return { name: 'restart_storm', ok: true, detail: `no restart storm (threshold ${RESTART_RATE_PER_MIN}/min)` };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null; // missing/corrupt → treated as "first run".
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  } catch {
    // Best-effort: a missing state file just means the next run re-baselines.
  }
}

// ── Optional alert webhook (best-effort, bounded, never alters exit code) ─────────

async function fireWebhook(result) {
  if (!WEBHOOK_URL) return;
  const failed = result.checks.filter((c) => c.ok === false).map((c) => c.detail);
  const payload = JSON.stringify({
    text: `[fb-automation] OPS probe UNHEALTHY: ${failed.join(' | ')}`,
    host: os.hostname(),
    verdict: result.verdict,
    checks: result.checks,
    at: new Date().toISOString(),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    if (typeof fetch !== 'function') return;
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal,
    });
  } catch (err) {
    if (!QUIET) process.stderr.write(`[ops-probe] webhook POST failed (ignored): ${err.message}\n`);
  } finally {
    clearTimeout(timer);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function positiveNumEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function emit(result) {
  if (AS_JSON) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (!QUIET) {
    const summary = result.checks
      .map((c) => `${c.name}=${c.ok === true ? 'ok' : c.ok === false ? 'FAIL' : 'skip'}`)
      .join(' ');
    process.stderr.write(`[ops-probe] ${result.verdict.toUpperCase()}: ${summary}\n`);
    for (const c of result.checks) {
      if (c.ok === false) process.stderr.write(`  - ${c.detail}\n`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────--

async function main() {
  // Each check is independent and self-contained — one failing check never prevents
  // the others from running (a down control plane shouldn't hide a full disk).
  const checks = [await checkControlPlane(), checkDisk(), checkRestartStorm()];

  // ok===false trips the page. ok===null means "could not run THIS check" — it does
  // NOT by itself page (avoids spurious pages when, e.g., pm2 isn't installed on a
  // dev box), but it is surfaced in the detail so the operator sees a degraded probe.
  const anyFailed = checks.some((c) => c.ok === false);

  const result = {
    code: anyFailed ? VERDICT.UNHEALTHY : VERDICT.HEALTHY,
    verdict: anyFailed ? 'unhealthy' : 'healthy',
    checks,
    at: new Date().toISOString(),
  };

  emit(result);
  if (result.code === VERDICT.UNHEALTHY) await fireWebhook(result);
  process.exit(result.code);
}

if (require.main === module) {
  void main();
}

module.exports = { checkDisk, checkRestartStorm, VERDICT };
