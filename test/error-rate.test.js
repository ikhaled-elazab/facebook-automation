'use strict';

/**
 * test/error-rate.test.js — unit tests for the pure verdict logic of the
 * action-failure / ban-signal probe (scripts/error-rate.js).
 *
 * We test the side-effect-free `evaluate(counts, opts)` directly with plain count
 * objects — no DB, no process.exit, no webhook — exactly as healthcheck's evaluate
 * is testable. The DB read (countsInWindow) is integration-tested implicitly by the
 * cron/runbook path; here we lock the decision boundaries that page (or don't).
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { evaluate, VERDICT } = require('../scripts/error-rate');

const OPTS = { threshold: 0.7, minAttempts: 5, windowMin: 30 };

test('BAN SIGNAL pages immediately regardless of rate or sample size', () => {
  // A single blocked row with otherwise perfect health still pages — ban risk.
  const r = evaluate({ ok: 100, failed: 0, skipped: 0, blocked: 1 }, OPTS);
  assert.strictEqual(r.code, VERDICT.UNHEALTHY);
  assert.strictEqual(r.ban_signal, true);
  assert.match(r.reason, /BAN SIGNAL/);
});

test('ban signal wins even when below the min-attempt floor', () => {
  // Only 1 attempt (below floor) but a blocked row → still pages.
  const r = evaluate({ ok: 0, failed: 1, skipped: 0, blocked: 2 }, OPTS);
  assert.strictEqual(r.code, VERDICT.UNHEALTHY);
  assert.strictEqual(r.ban_signal, true);
});

test('below the min-attempt floor is HEALTHY (no false page on small samples)', () => {
  // 1 failure out of 1 attempt is 100% rate, but < minAttempts → not enough signal.
  const r = evaluate({ ok: 0, failed: 1, skipped: 0, blocked: 0 }, OPTS);
  assert.strictEqual(r.code, VERDICT.HEALTHY);
  assert.strictEqual(r.error_rate, 1);
  assert.strictEqual(r.attempts, 1);
  assert.match(r.reason, /not enough/);
});

test('error rate AT the threshold pages (>= is the boundary)', () => {
  // 7 failed of 10 attempts = 0.70 exactly. At-or-above must trip.
  const r = evaluate({ ok: 3, failed: 7, skipped: 0, blocked: 0 }, OPTS);
  assert.strictEqual(r.code, VERDICT.UNHEALTHY);
  assert.strictEqual(r.error_rate, 0.7);
  assert.strictEqual(r.ban_signal, false);
  assert.match(r.reason, /error rate/);
});

test('error rate just below the threshold is HEALTHY', () => {
  // 6 failed of 10 = 0.60 < 0.70.
  const r = evaluate({ ok: 4, failed: 6, skipped: 0, blocked: 0 }, OPTS);
  assert.strictEqual(r.code, VERDICT.HEALTHY);
  assert.strictEqual(r.error_rate, 0.6);
});

test("skipped rows NEVER count toward the rate (paced/capped no-ops are healthy)", () => {
  // 1000 skipped (governor-blocked) + 4 ok + 1 failed = rate 1/5 = 0.20, healthy.
  // If skipped leaked into the denominator/numerator the math would be wrong.
  const r = evaluate({ ok: 4, failed: 1, skipped: 1000, blocked: 0 }, OPTS);
  assert.strictEqual(r.code, VERDICT.HEALTHY);
  assert.strictEqual(r.attempts, 5, 'attempts = ok+failed only');
  assert.strictEqual(r.error_rate, 0.2);
});

test('an empty window is HEALTHY (no attempts, no ban) — never a 3am no-op page', () => {
  const r = evaluate({ ok: 0, failed: 0, skipped: 0, blocked: 0 }, OPTS);
  assert.strictEqual(r.code, VERDICT.HEALTHY);
  assert.strictEqual(r.error_rate, null, 'rate is null with zero attempts');
  assert.strictEqual(r.ban_signal, false);
});

test('negative / garbage counts are coerced to 0 (defensive against bad reads)', () => {
  const r = evaluate({ ok: -5, failed: NaN, skipped: undefined, blocked: -1 }, OPTS);
  assert.strictEqual(r.ok, 0);
  assert.strictEqual(r.failed, 0);
  assert.strictEqual(r.skipped, 0);
  assert.strictEqual(r.blocked, 0);
  assert.strictEqual(r.code, VERDICT.HEALTHY);
});
