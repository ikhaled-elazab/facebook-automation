'use strict';

/**
 * test/governor.test.js — the SAFETY-FIRST pacing governor (core/governor.js).
 *
 * These are pure, deterministic unit tests: NO database and NO real wall clock.
 * The governor factory takes injectable deps — a `countActionsToday(accountId)`
 * fn and a `now()` clock — so every cap / active-hours / timezone branch is
 * exercised without I/O. They assert the gate's safety contract:
 *   - the (N+1)th action is SKIPPED once a per-account cap of N is reached;
 *   - 0 = UNLIMITED (never blocks), not "cap of zero blocks everything";
 *   - actions outside the active-hours window are skipped;
 *   - the global cap blocks even when the per-account count is under its cap;
 *   - a NULL per-account cap inherits the global cap;
 *   - pacing_enabled=0 makes the governor a no-op;
 *   - a bad/absent timezone falls back to server-local without throwing.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGovernor, withinActiveHours } = require('../core/governor.js');

// A temp DB so checkAndAct's db.insertAccount/readLastPostId have a real target
// (the wiring test below drives the REAL checkAndAct, not just the pure gate).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbgov-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');

// A clock pinned to a specific local hour (minutes/seconds zeroed) so active-hours
// branches are deterministic regardless of when the suite runs.
function clockAtLocalHour(hour) {
  return () => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return d;
  };
}

const IN_HOURS = { active_hours_start: 8, active_hours_end: 23 };
const ALWAYS = { active_hours_start: 0, active_hours_end: 24 };

// ── withinActiveHours (pure window arithmetic) ────────────────────────────────

test('withinActiveHours: same-day window is [start, end) — end exclusive', () => {
  assert.strictEqual(withinActiveHours(8, 8, 23), true, 'start hour is inclusive');
  assert.strictEqual(withinActiveHours(22, 8, 23), true, 'inside window');
  assert.strictEqual(withinActiveHours(23, 8, 23), false, 'end hour is exclusive');
  assert.strictEqual(withinActiveHours(7, 8, 23), false, 'before window');
});

test('withinActiveHours: wrapping (overnight) window when end <= start', () => {
  assert.strictEqual(withinActiveHours(23, 22, 6), true, 'late night inside overnight window');
  assert.strictEqual(withinActiveHours(2, 22, 6), true, 'early morning inside overnight window');
  assert.strictEqual(withinActiveHours(6, 22, 6), false, 'end hour exclusive (wrapping)');
  assert.strictEqual(withinActiveHours(12, 22, 6), false, 'midday outside overnight window');
});

test('withinActiveHours: start === end means full-day (always active), not empty', () => {
  assert.strictEqual(withinActiveHours(0, 9, 9), true);
  assert.strictEqual(withinActiveHours(15, 9, 9), true);
});

// ── Daily caps ────────────────────────────────────────────────────────────────

test('per-account cap: the (N+1)th action is SKIPPED (count >= cap blocks)', () => {
  // v2 THREE-TIER: the per-account CEILING is carried on the hydrated branch as
  // accountDailyActionCap and counted by countActionsToday(accountId). The branch
  // cap (dailyActionCap) is left unlimited (0) so the account ceiling is the
  // binding tier — exactly the v1 "per-account cap" semantics this test guards.
  const CAP = 5;
  const branch = { id: 10, accountId: 1, dailyActionCap: 0, accountDailyActionCap: CAP };

  // count == cap → the next (the N+1th) action must be denied.
  const atCap = createGovernor(
    { pacing_enabled: 1, global_daily_action_cap: 0, ...IN_HOURS },
    {
      now: clockAtLocalHour(10),
      countActionsToday: (accountId) => (accountId === 1 ? CAP : 0),
      countBranchActionsToday: () => 0,
    }
  );
  const denied = atCap.canAct(branch);
  assert.strictEqual(denied.allowed, false, 'N+1th action denied at cap');
  assert.strictEqual(denied.reason, 'account_cap');

  // count == cap-1 → still allowed (this is the Nth, last permitted action).
  const underCap = createGovernor(
    { pacing_enabled: 1, global_daily_action_cap: 0, ...IN_HOURS },
    {
      now: clockAtLocalHour(10),
      countActionsToday: (accountId) => (accountId === 1 ? CAP - 1 : 0),
      countBranchActionsToday: () => 0,
    }
  );
  assert.strictEqual(underCap.canAct(branch).allowed, true, 'Nth action allowed');
});

test('per-branch cap: the (N+1)th action is SKIPPED with reason branch_cap', () => {
  // v2 THREE-TIER guard: the per-BRANCH cap (branch.dailyActionCap) is counted by
  // countBranchActionsToday(branch.id). Here the account ceiling + global are
  // unlimited (0) so the BRANCH tier is the binding one — the headline anti-ban
  // mechanism that lets two branches on one login be paced independently.
  const CAP = 3;
  const branch = { id: 10, accountId: 1, dailyActionCap: CAP, accountDailyActionCap: 0 };

  // this branch's count == its cap → next action denied at the branch tier.
  const atCap = createGovernor(
    { pacing_enabled: 1, global_daily_action_cap: 0, ...IN_HOURS },
    {
      now: clockAtLocalHour(10),
      countActionsToday: () => 0,
      countBranchActionsToday: (branchId) => (branchId === 10 ? CAP : 0),
    }
  );
  const denied = atCap.canAct(branch);
  assert.strictEqual(denied.allowed, false, 'N+1th branch action denied at branch cap');
  assert.strictEqual(denied.reason, 'branch_cap');

  // count == cap-1 → still allowed (the Nth, last permitted branch action).
  const underCap = createGovernor(
    { pacing_enabled: 1, global_daily_action_cap: 0, ...IN_HOURS },
    {
      now: clockAtLocalHour(10),
      countActionsToday: () => 0,
      countBranchActionsToday: (branchId) => (branchId === 10 ? CAP - 1 : 0),
    }
  );
  assert.strictEqual(underCap.canAct(branch).allowed, true, 'Nth branch action allowed');
});

test('per-branch isolation: one branch at its cap does NOT block a sibling branch', () => {
  // Two branches under ONE account (shared login). branchA is at its branch cap;
  // branchB is fresh. The per-branch counter must isolate them: branchA denied,
  // branchB still allowed — independent per-branch pacing is the whole point of v2
  // (this is the cap-tier mirror of the loop.js per-branch isolation guarantee).
  const CAP = 4;
  const branchA = { id: 10, accountId: 1, dailyActionCap: CAP, accountDailyActionCap: 0 };
  const branchB = { id: 11, accountId: 1, dailyActionCap: CAP, accountDailyActionCap: 0 };
  const gov = createGovernor(
    { pacing_enabled: 1, global_daily_action_cap: 0, ...IN_HOURS },
    {
      now: clockAtLocalHour(10),
      countActionsToday: () => 0,
      // branchA has exhausted its cap; branchB has none yet.
      countBranchActionsToday: (branchId) => (branchId === 10 ? CAP : 0),
    }
  );
  const a = gov.canAct(branchA);
  const b = gov.canAct(branchB);
  assert.strictEqual(a.allowed, false, 'exhausted branch denied');
  assert.strictEqual(a.reason, 'branch_cap');
  assert.strictEqual(b.allowed, true, 'sibling branch unaffected');
});

test('cap of 0 means UNLIMITED — never blocks even with a huge count', () => {
  const g = createGovernor(
    { pacing_enabled: 1, global_daily_action_cap: 0, ...IN_HOURS },
    { now: clockAtLocalHour(10), countActionsToday: () => 100000 }
  );
  const d = g.canAct({ id: 1, dailyActionCap: 0 });
  assert.strictEqual(d.allowed, true, '0 = unlimited, not "blocks everything"');
  assert.strictEqual(d.reason, 'ok');
});

test('NULL per-account cap inherits the global cap', () => {
  const g = createGovernor(
    { pacing_enabled: 1, global_daily_action_cap: 5, ...IN_HOURS },
    {
      now: clockAtLocalHour(10),
      // account count == 5 (== inherited global cap) → denied as account_cap.
      countActionsToday: (id) => (id === 1 ? 5 : 5),
    }
  );
  const d = g.canAct({ id: 1, dailyActionCap: null });
  assert.strictEqual(d.allowed, false, 'null cap inherits the global cap value');
  assert.strictEqual(d.reason, 'account_cap');
});

test('global cap blocks even when the per-account count is under its own cap', () => {
  const g = createGovernor(
    { pacing_enabled: 1, global_daily_action_cap: 5, ...IN_HOURS },
    {
      now: clockAtLocalHour(10),
      // per-account (id=1) count 0 (well under its cap of 100); global (null) at 5.
      countActionsToday: (id) => (id === null ? 5 : 0),
    }
  );
  const d = g.canAct({ id: 1, dailyActionCap: 100 });
  assert.strictEqual(d.allowed, false, 'global ceiling enforced independently');
  assert.strictEqual(d.reason, 'global_cap');
});

// ── Active hours ────────────────────────────────────────────────────────────--

test('action OUTSIDE active hours is skipped (cheaper check than caps)', () => {
  const g = createGovernor(
    { pacing_enabled: 1, global_daily_action_cap: 0, ...IN_HOURS },
    {
      now: clockAtLocalHour(3), // 3am, window is [8,23)
      countActionsToday: () => {
        throw new Error('cap must not be queried when outside active hours');
      },
    }
  );
  const d = g.canAct({ id: 1, dailyActionCap: 0 });
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.reason, 'outside_active_hours');
});

// ── Master switch ─────────────────────────────────────────────────────────────

test('pacing_enabled=0 makes the governor a no-op (always allowed)', () => {
  const g = createGovernor(
    { pacing_enabled: 0, global_daily_action_cap: 1, ...IN_HOURS },
    {
      now: clockAtLocalHour(3), // even outside hours
      countActionsToday: () => 99999, // even over cap
    }
  );
  const d = g.canAct({ id: 1, dailyActionCap: 1 });
  assert.strictEqual(d.allowed, true);
  assert.strictEqual(d.reason, 'pacing_disabled');
});

// ── Timezone resilience ─────────────────────────────────────────────────────--

test('a bad/unknown timezone falls back to server-local and never throws', () => {
  const g = createGovernor(
    { pacing_enabled: 1, global_daily_action_cap: 0, ...ALWAYS },
    { countActionsToday: () => 0 }
  );
  // ALWAYS window means it is always within hours regardless of the resolved hour,
  // so the only thing under test is that a garbage tz does not throw.
  assert.doesNotThrow(() => g.canAct({ id: 1, timezoneId: 'Not/AReal_Zone', dailyActionCap: 0 }));
  assert.strictEqual(g.canAct({ id: 1, timezoneId: 'Not/AReal_Zone', dailyActionCap: 0 }).allowed, true);
});

test('default settings (pacing_enabled undefined) defaults pacing ON', () => {
  // A governor built from an empty settings object should NOT silently disable
  // pacing — the safety-first default is ON.
  const g = createGovernor(
    {},
    { now: clockAtLocalHour(3), countActionsToday: () => 0 }
  );
  // With no active-hours configured, start=0/end=24 → always active, so the
  // gate allows; the point is reason !== 'pacing_disabled' (pacing is engaged).
  const d = g.canAct({ id: 1 });
  assert.notStrictEqual(d.reason, 'pacing_disabled', 'empty settings must not disable pacing');
});

// ── Integration wiring: the loop SKIPS the action when the governor denies ────

test('checkAndAct: a denied governor SKIPS all write actions and logs skipped rows', async () => {
  const db = require('../db');
  const loop = require('../worker/loop.js');
  db.getDb();
  // v2: target_page_url moved to branches; an account is the login envelope only.
  // checkAndAct keys runtime STATE on the BRANCH (writeLastPostId → setLastPostId
  // writes account_state(branch_id=account.id) under a branches FK), so the hydrated
  // POJO's `.id` must be a real branch id — see the account POJO below.
  const id = db.insertAccount({ name: 'govwire', email: 'e@x.com', session_file: 's' });
  const branchId = db.insertBranch({ account_id: id, name: 'default', is_default: 1, target_page_url: 'u' });

  // A governor that always denies (cap reached) + a capturing logAction.
  const logged = [];
  const denyingGovernor = { canAct: () => ({ allowed: false, reason: 'account_cap', detail: '5/5 today' }) };

  // withRetry: returns a NEW post for the MONITOR read (so we proceed to the
  // gated writes), and counts any write-action body invocation. If the gate
  // works, NO write body should ever run.
  let writeActionBodies = 0;
  const ctx = {
    h: { randomDelay: async () => {}, sleep: async () => {} },
    withRetry: async (fn, page, account, label) => {
      if (label === 'MONITOR') return { postId: 'p1', postUrl: 'http://x/p1', postText: 'hi' };
      writeActionBodies++;
      return undefined;
    },
    governor: denyingGovernor,
    logAction: (e) => logged.push(e),
  };

  const fakePage = {
    async goto() {},
    keyboard: { async press() {} },
  };
  // v2 hydrated branch: `.id` is the branch id (state/log key), accountId the login.
  const account = { id: branchId, branchId, accountId: id, name: 'govwire', dailyActionCap: 5, accountDailyActionCap: 0, comments: ['c'], replies: ['r'], groups: [] };

  await loop.checkAndAct(fakePage, account, ctx);

  assert.strictEqual(writeActionBodies, 0, 'no write-action body ran while the governor denied');
  const skipped = logged.filter((r) => r.status === 'skipped');
  assert.strictEqual(skipped.length, 4, 'one skipped row per gated write action (like/comment/share/share-groups)');
  assert.strictEqual(logged.filter((r) => r.status === 'ok').length, 0, 'no action counted toward the cap when skipped');
  assert.strictEqual(skipped[0].detail, 'account_cap: 5/5 today', 'skip reason is recorded for observability');

  db.closeDb();
});

// ── Fix 2 (fail-closed governor): count source throws / NaN → DENY ────────────

test('canAct fails CLOSED (denies) when the count source THROWS (locked/corrupt DB)', () => {
  // An always-allow active-hours window + a non-zero cap so we reach the count
  // check; the count source throws as if the DB were locked/corrupt.
  const gov = createGovernor(
    { pacing_enabled: 1, ...ALWAYS, global_daily_action_cap: 100 },
    {
      countActionsToday: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
      now: clockAtLocalHour(12),
    }
  );
  const d = gov.canAct({ id: 1, name: 'a', dailyActionCap: 50 });
  assert.strictEqual(d.allowed, false, 'a throwing count must DENY, not allow (anti-ban fail-closed)');
  assert.strictEqual(d.reason, 'count_error', 'reason marks the fail-closed denial');
});

test('canAct fails CLOSED (denies) when the count source returns a NON-FINITE value', () => {
  for (const bad of [NaN, undefined, null]) {
    const gov = createGovernor(
      { pacing_enabled: 1, ...ALWAYS, global_daily_action_cap: 100 },
      { countActionsToday: () => bad, now: clockAtLocalHour(12) }
    );
    const d = gov.canAct({ id: 1, name: 'a', dailyActionCap: 50 });
    assert.strictEqual(d.allowed, false, `a ${String(bad)} count must DENY (treated as cap-reached)`);
    assert.strictEqual(d.reason, 'count_error', `reason is count_error for ${String(bad)}`);
  }
});

test('canAct never THROWS even when the count source throws (supervisor stays calm)', () => {
  const gov = createGovernor(
    { pacing_enabled: 1, ...ALWAYS, global_daily_action_cap: 100 },
    {
      countActionsToday: () => {
        throw new Error('boom');
      },
      now: clockAtLocalHour(12),
    }
  );
  // The contract: canAct returns a decision object, never propagates the throw.
  assert.doesNotThrow(() => gov.canAct({ id: 1, name: 'a', dailyActionCap: 50 }));
});

test('the GLOBAL cap path also fails CLOSED when the global count throws', () => {
  // Per-account cap unlimited (0) so we skip the account check and reach the
  // global check; the global count (accountId === null) throws.
  const gov = createGovernor(
    { pacing_enabled: 1, ...ALWAYS, global_daily_action_cap: 100 },
    {
      countActionsToday: (accountId) => {
        if (accountId === null || accountId === undefined) throw new Error('global count locked');
        return 0;
      },
      now: clockAtLocalHour(12),
    }
  );
  const d = gov.canAct({ id: 1, name: 'a', dailyActionCap: 0 }); // 0 = unlimited per-account
  assert.strictEqual(d.allowed, false, 'global count throwing denies (symmetric fail-closed)');
  assert.strictEqual(d.reason, 'count_error');
});

after(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});
