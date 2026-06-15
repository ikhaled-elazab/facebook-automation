'use strict';

/**
 * test/ops-probe.test.js — host-level ops probe checks (scripts/ops-probe.js).
 *
 * checkDisk runs `df` against the real project mount — deterministic enough to
 * assert it returns a well-formed result (ok is true/false/null, never throws,
 * detail is a string). checkRestartStorm shells out to `pm2 jlist`; on a box
 * without pm2 it must DEGRADE to ok:null (a degraded probe must never page), and
 * with a fresh state file it must record a baseline rather than alert on the first
 * sample. We do not assert a specific disk%/pm2 state — we assert the CONTRACT
 * (shape + never-throws + first-run-baseline) so the probe is safe to cron.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opsprobe-'));
// Point the restart-delta state file at a temp location BEFORE requiring the module.
process.env.OPS_STATE_FILE = path.join(TMP_DIR, 'state.json');

const { checkDisk, checkRestartStorm } = require('../scripts/ops-probe');

test('checkDisk returns a well-formed result and never throws', () => {
  const r = checkDisk();
  assert.strictEqual(r.name, 'disk');
  assert.ok(r.ok === true || r.ok === false || r.ok === null, 'ok is tri-state');
  assert.strictEqual(typeof r.detail, 'string');
  assert.ok(r.detail.length > 0, 'detail explains the result');
});

test('checkRestartStorm degrades gracefully and baselines on first run', () => {
  // No state file exists yet (temp dir is fresh). Whether or not pm2 is installed:
  //   - pm2 present  → first run records a baseline and reports ok:true.
  //   - pm2 absent   → ok:null (degraded), and MUST NOT page (ok !== false).
  const r = checkRestartStorm();
  assert.strictEqual(r.name, 'restart_storm');
  assert.ok(r.ok === true || r.ok === null, 'first run never pages (ok is true or null)');
  assert.strictEqual(typeof r.detail, 'string');

  // If pm2 was reachable, a state file should now exist (baseline persisted).
  if (r.ok === true) {
    assert.ok(fs.existsSync(process.env.OPS_STATE_FILE), 'baseline state persisted after a successful sample');
    const state = JSON.parse(fs.readFileSync(process.env.OPS_STATE_FILE, 'utf8'));
    assert.ok(typeof state.at === 'number' && state.counts && typeof state.counts === 'object',
      'state file holds {at, counts}');
  }
});

test('cleanup temp state dir', () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  assert.ok(!fs.existsSync(TMP_DIR));
});
