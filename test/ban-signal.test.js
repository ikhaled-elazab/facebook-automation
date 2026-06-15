'use strict';

/**
 * test/ban-signal.test.js — unit tests for core/ban-signal.js, the mid-run
 * Facebook checkpoint/challenge detector (P5 obs #4).
 *
 * BEFORE: a checkpoint was only detected at login; mid-session it looked like
 * generic action failures. AFTER: each failed action attempt sniffs the page and,
 * on a checkpoint URL / known challenge DOM marker, logs ONE status:'blocked'
 * action_log row — the one signal that should wake the operator.
 *
 * No real browser: the page is a fake exposing url()/$(); logAction is captured.
 * Asserts: URL detection, DOM-marker detection, the de-dupe scope (once per
 * withRetry call), the best-effort safety contract (never throws), and that a
 * normal page produces no signal.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { detectBanSignal, isCheckpointUrl, probe } = require('../core/ban-signal.js');

const ACCOUNT = { id: 7, name: 'banacct' };

/** A fake page whose url() and $() are supplied by the test. */
function fakePage({ url = null, domHit = false } = {}) {
  return {
    url: () => url,
    async $(sel) {
      // Return a truthy "element" for ANY selector when domHit is set.
      return domHit ? { sel } : null;
    },
  };
}

// ── pure URL classifier ───────────────────────────────────────────────────────

test('isCheckpointUrl matches checkpoint / challenge / login / recover paths', () => {
  assert.strictEqual(isCheckpointUrl('https://www.facebook.com/checkpoint/?next=1'), true);
  assert.strictEqual(isCheckpointUrl('https://www.facebook.com/challenge/123'), true);
  assert.strictEqual(isCheckpointUrl('https://www.facebook.com/login/?ref=x'), true);
  assert.strictEqual(isCheckpointUrl('https://www.facebook.com/recover/initiate'), true);
});

test('isCheckpointUrl does NOT match a normal group/post URL (no false positive)', () => {
  assert.strictEqual(isCheckpointUrl('https://www.facebook.com/groups/123/posts/456'), false);
  assert.strictEqual(isCheckpointUrl('https://www.facebook.com/me'), false);
  assert.strictEqual(isCheckpointUrl(''), false);
  assert.strictEqual(isCheckpointUrl(null), false);
  assert.strictEqual(isCheckpointUrl(undefined), false);
});

// ── probe ─────────────────────────────────────────────────────────────────────

test('probe returns a url:<marker> reason on a checkpoint URL', async () => {
  const reason = await probe(fakePage({ url: 'https://facebook.com/checkpoint/x' }));
  assert.ok(reason && reason.startsWith('url:'), `expected a url: reason, got ${reason}`);
});

test('probe falls back to a dom:<selector> reason when the URL is clean but a marker exists', async () => {
  const reason = await probe(fakePage({ url: 'https://facebook.com/groups/1', domHit: true }));
  assert.ok(reason && reason.startsWith('dom:'), `expected a dom: reason, got ${reason}`);
});

test('probe returns null for a clean page (no url marker, no dom marker)', async () => {
  const reason = await probe(fakePage({ url: 'https://facebook.com/groups/1', domHit: false }));
  assert.strictEqual(reason, null);
});

test('probe returns null for a null page (best-effort)', async () => {
  assert.strictEqual(await probe(null), null);
});

// ── detectBanSignal: logs a single 'blocked' row, de-duped per scope ──────────

test("detectBanSignal logs ONE status:'blocked' row on a checkpoint URL", async () => {
  const logged = [];
  const detected = await detectBanSignal(
    fakePage({ url: 'https://facebook.com/checkpoint/y' }),
    ACCOUNT,
    'LIKE',
    { logAction: (e) => logged.push(e) }
  );
  assert.strictEqual(detected, true, 'a checkpoint URL is detected');
  assert.strictEqual(logged.length, 1, 'exactly one blocked row');
  assert.strictEqual(logged[0].status, 'blocked', "status is 'blocked' (the ban-signal vocab)");
  assert.strictEqual(logged[0].accountId, ACCOUNT.id, 'row is scoped to the account');
  assert.ok(/LIKE/.test(logged[0].detail), 'detail names the failing action');
});

test('detectBanSignal de-dupes within a scope: a second call with the same scope does NOT re-log', async () => {
  const logged = [];
  const scope = { logged: false };
  const page = fakePage({ url: 'https://facebook.com/checkpoint/z' });

  await detectBanSignal(page, ACCOUNT, 'LIKE', { logAction: (e) => logged.push(e), scope });
  await detectBanSignal(page, ACCOUNT, 'LIKE', { logAction: (e) => logged.push(e), scope });
  await detectBanSignal(page, ACCOUNT, 'LIKE', { logAction: (e) => logged.push(e), scope });

  assert.strictEqual(logged.length, 1, 'one blocked row across maxAttempts within the same withRetry call');
});

test('detectBanSignal returns false (no log) for a clean page', async () => {
  const logged = [];
  const detected = await detectBanSignal(
    fakePage({ url: 'https://facebook.com/groups/1' }),
    ACCOUNT,
    'COMMENT',
    { logAction: (e) => logged.push(e) }
  );
  assert.strictEqual(detected, false, 'no signal on a clean page');
  assert.strictEqual(logged.length, 0, 'no row logged for a clean page');
});

// ── safety contract: never throws ─────────────────────────────────────────────

test('detectBanSignal NEVER throws, even when page.url() throws', async () => {
  const throwingPage = {
    url: () => {
      throw new Error('page closed');
    },
    async $() {
      throw new Error('detached');
    },
  };
  // Must resolve (not reject) — it is called from inside an action's catch block.
  await assert.doesNotReject(detectBanSignal(throwingPage, ACCOUNT, 'SHARE', { logAction: () => {} }));
});

test('detectBanSignal NEVER throws when logAction itself throws', async () => {
  const page = fakePage({ url: 'https://facebook.com/checkpoint/q' });
  await assert.doesNotReject(
    detectBanSignal(page, ACCOUNT, 'SHARE', {
      logAction: () => {
        throw new Error('DB locked');
      },
    })
  );
});
