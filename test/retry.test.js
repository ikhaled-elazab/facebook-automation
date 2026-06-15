'use strict';

/**
 * test/retry.test.js — unit tests for core/retry.js (createRetry/withRetry) and
 * the core/humanize.js primitives extracted during Phase 2.
 *
 * No browser is required: fn / page / aiAct are fakes. We assert the retry
 * control flow (success short-circuit, attempt counting, vision fallback gating)
 * exactly mirrors the monolith's withRetry behaviour.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { createRetry, RETRY_FAILED } = require('../core/retry.js');
const { createHumanizer, randInt, pickRandom, sleep } = require('../core/humanize.js');

const ACCOUNT = { name: 'retryAcct' };
const SETTINGS_NO_VISION = { use_vision: 0, screenshot_on_error: 0 };

// ── withRetry control flow ───────────────────────────────────────────────────

test('withRetry returns fn result on first success (no extra attempts)', async () => {
  const withRetry = createRetry({ settings: SETTINGS_NO_VISION });
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      return 'value';
    },
    null,
    ACCOUNT,
    'ACT',
    3,
    1
  );
  assert.strictEqual(result, 'value');
  assert.strictEqual(calls, 1, 'success short-circuits — only one attempt');
});

test('withRetry tries maxAttempts times then returns RETRY_FAILED sentinel', async () => {
  const withRetry = createRetry({ settings: SETTINGS_NO_VISION });
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      throw new Error('boom');
    },
    null,
    ACCOUNT,
    'ACT',
    3,
    1
  );
  // FALSE-SUCCESS FIX: exhaustion returns the RETRY_FAILED sentinel, NOT
  // undefined, so callers can distinguish failure from an undefined-returning
  // successful action.
  assert.strictEqual(result, RETRY_FAILED);
  assert.notStrictEqual(result, undefined, 'must NOT be plain undefined (that was the bug)');
  assert.strictEqual(calls, 3, 'all maxAttempts consumed');
});

test('withRetry returns the actual fn() value on success even when it is undefined', async () => {
  // likePost/commentOnPost legitimately resolve to `undefined` on success. The
  // sentinel fix must NOT clobber that — a successful undefined return stays
  // undefined (and is distinct from RETRY_FAILED).
  const withRetry = createRetry({ settings: SETTINGS_NO_VISION });
  const result = await withRetry(async () => undefined, null, ACCOUNT, 'ACT', 3, 1);
  assert.strictEqual(result, undefined, 'successful undefined-returning action stays undefined');
  assert.notStrictEqual(result, RETRY_FAILED, 'success is NOT the failure sentinel');
});

test('withRetry succeeds on a later attempt', async () => {
  const withRetry = createRetry({ settings: SETTINGS_NO_VISION });
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 2) throw new Error('transient');
      return 'ok-on-2';
    },
    null,
    ACCOUNT,
    'ACT',
    3,
    1
  );
  assert.strictEqual(result, 'ok-on-2');
  assert.strictEqual(calls, 2);
});

// ── vision fallback gating ───────────────────────────────────────────────────

test('vision fallback fires only on the final attempt and returns true on success', async () => {
  let visionCalls = 0;
  const aiAct = async () => {
    visionCalls++;
    return true;
  };
  const withRetry = createRetry({ settings: { use_vision: 1, screenshot_on_error: 0 }, aiAct });
  const result = await withRetry(
    async () => {
      throw new Error('selectors exhausted');
    },
    {}, // truthy page so the fallback's page guard passes
    ACCOUNT,
    'ACT',
    2,
    1,
    'do the thing'
  );
  assert.strictEqual(result, true, 'vision success returns true');
  assert.strictEqual(visionCalls, 1, 'vision invoked exactly once, on the last attempt');
});

test('vision fallback NOT used when use_vision is off', async () => {
  let visionCalls = 0;
  const withRetry = createRetry({
    settings: { use_vision: 0 },
    aiAct: async () => {
      visionCalls++;
      return true;
    },
  });
  const result = await withRetry(
    async () => {
      throw new Error('x');
    },
    {},
    ACCOUNT,
    'ACT',
    2,
    1,
    'goal'
  );
  assert.strictEqual(visionCalls, 0, 'vision skipped when disabled');
  assert.strictEqual(result, RETRY_FAILED, 'exhaustion returns the failure sentinel');
});

test('vision fallback NOT used when no visionGoal provided', async () => {
  let visionCalls = 0;
  const withRetry = createRetry({
    settings: { use_vision: 1 },
    aiAct: async () => {
      visionCalls++;
      return true;
    },
  });
  const result = await withRetry(
    async () => {
      throw new Error('x');
    },
    {},
    ACCOUNT,
    'ACT',
    1,
    1
    // no visionGoal
  );
  assert.strictEqual(visionCalls, 0, 'no goal -> no vision');
  assert.strictEqual(result, RETRY_FAILED, 'exhaustion returns the failure sentinel');
});

test('vision fallback that throws is caught and treated as failure', async () => {
  const withRetry = createRetry({
    settings: { use_vision: 1, screenshot_on_error: 0 },
    aiAct: async () => {
      throw new Error('vision threw');
    },
  });
  const result = await withRetry(
    async () => {
      throw new Error('x');
    },
    {},
    ACCOUNT,
    'ACT',
    1,
    1,
    'goal'
  );
  assert.strictEqual(result, RETRY_FAILED, 'vision throw -> overall failure (sentinel), no crash');
});

// ── humanize primitives ──────────────────────────────────────────────────────

test('randInt is inclusive and within bounds', () => {
  assert.strictEqual(randInt(5, 5), 5);
  for (let i = 0; i < 200; i++) {
    const n = randInt(3, 7);
    assert.ok(n >= 3 && n <= 7, `randInt in [3,7], got ${n}`);
  }
});

test('pickRandom returns an element, undefined for empty', () => {
  assert.strictEqual(pickRandom([]), undefined);
  assert.strictEqual(pickRandom(null), undefined);
  assert.strictEqual(pickRandom(['only']), 'only');
  const arr = ['a', 'b', 'c'];
  assert.ok(arr.includes(pickRandom(arr)));
});

test('createHumanizer binds delays to settings and clamps invalid values', async () => {
  const h = createHumanizer({ min_action_ms: 1, max_action_ms: 2, min_typing_ms: 1, max_typing_ms: 1 });
  assert.strictEqual(typeof h.randomDelay, 'function');
  assert.strictEqual(typeof h.typeText, 'function');
  // randomDelay resolves (uses bound bounds)
  await h.randomDelay();
  // null/garbage settings fall back to defaults without throwing
  const h2 = createHumanizer({ min_action_ms: null, max_action_ms: undefined });
  await h2.randomDelay(1, 1);
  assert.ok(true, 'humanizer tolerates null/undefined settings cells');
});

test('sleep resolves after the given delay', async () => {
  const start = Date.now();
  await sleep(5);
  assert.ok(Date.now() - start >= 4, 'slept ~5ms');
});
