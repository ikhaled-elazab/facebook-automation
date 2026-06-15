'use strict';

/**
 * core/governor.js — the SAFETY-FIRST pacing governor (P5).
 *
 * This is the anti-ban gate. BEFORE the worker performs any Facebook action it
 * asks the governor `canAct(account)`; the governor answers with an allow/deny
 * decision and a machine-readable reason. When denied, the worker SKIPS the
 * action gracefully (logs a 'skipped' action_log row and continues the loop) —
 * the governor NEVER throws, because a throw would propagate to the supervisor
 * and turn a benign "we hit the cap" into a session restart with backoff.
 *
 * Three independent limits, checked cheapest-first:
 *   1. pacing master switch (settings.pacing_enabled) — when off, everything is
 *      allowed (the governor becomes a no-op; existing humanizer delays remain).
 *   2. active-hours window  — skip actions outside [active_hours_start,
 *      active_hours_end) in the account's LOCAL hour (timezone_id), so the bot
 *      mimics a human who is only awake during the day.
 *   3. daily caps — THREE TIERS, all enforced (most-specific first):
 *        a. per-BRANCH (branch.dailyActionCap; NULL = inherit account ceiling)
 *        b. per-ACCOUNT ceiling (branch.accountDailyActionCap; NULL = inherit global)
 *        c. GLOBAL (settings.global_daily_action_cap)
 *      0 = UNLIMITED for any tier (special-cased, NOT "cap of zero = block all").
 *      The branch cap counts that branch's actions; the account ceiling counts
 *      ALL the account's branches summed; the global counts everything.
 *
 * TIMEZONE basis: the daily-cap day window (db.countActionsToday) is the
 * SERVER-LOCAL calendar day. The active-hours window is the ACCOUNT-LOCAL hour
 * (account.timezoneId, defaulting to server-local when absent/invalid). These
 * are intentionally distinct: caps are a per-server-day budget; active-hours
 * models the human behind THAT account being awake in THEIR timezone.
 *
 * The governor is a factory closing over a settings snapshot + injectable deps
 * (a `countActionsToday` fn and a `now` clock), so it is unit-testable with NO
 * database and NO real wall clock.
 */

const db = require('../db');

/** Coerce a value to a finite integer, else fall back. Guards NULL DB cells. */
function intOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Resolve the LOCAL hour-of-day (0–23) for a given instant in an IANA timezone.
 * Uses Intl (no extra dependency). Falls back to the server-local hour when the
 * timezone is absent or unrecognized — never throws (a bad timezone must not
 * brick the whole gate).
 * @param {Date} now
 * @param {string|undefined|null} timeZone IANA tz id, e.g. "America/New_York"
 * @returns {number} hour 0–23
 */
function localHour(now, timeZone) {
  if (!timeZone) return now.getHours();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone,
    }).formatToParts(now);
    const hourPart = parts.find((p) => p.type === 'hour');
    const hour = hourPart ? Number(hourPart.value) : NaN;
    if (!Number.isFinite(hour)) return now.getHours();
    // Intl can emit "24" for midnight in hour12:false depending on engine — normalize.
    return hour % 24;
  } catch {
    return now.getHours();
  }
}

/**
 * Decide whether the current local hour is inside the active-hours window.
 * Supports a WRAPPING window (e.g. start=22, end=6 means 22:00–05:59 — overnight)
 * by treating end <= start as crossing midnight. When start === end the window is
 * the full day (always active) rather than empty — the safe, non-surprising
 * reading of "start and end are the same hour" for a 24h operator.
 * @param {number} hour current local hour 0–23
 * @param {number} start active_hours_start 0–23
 * @param {number} end active_hours_end 0–23 (exclusive upper bound)
 * @returns {boolean}
 */
function withinActiveHours(hour, start, end) {
  if (start === end) return true; // full-day window
  if (start < end) return hour >= start && hour < end; // normal same-day window
  return hour >= start || hour < end; // wrapping (overnight) window
}

/**
 * Build a governor bound to a settings snapshot.
 * @param {object} settings db.getSettings() row (snake_case). Uses
 *   pacing_enabled, global_daily_action_cap, active_hours_start, active_hours_end.
 * @param {object} [deps] injectable deps for testing.
 * @param {(accountId?: number|null) => number} [deps.countActionsToday] defaults to db.countActionsToday
 *   (per-account / global tier).
 * @param {(branchId: number) => number} [deps.countBranchActionsToday] defaults to
 *   db.countBranchActionsToday (per-branch tier).
 * @param {() => Date} [deps.now] clock, defaults to () => new Date().
 * @returns {{ canAct: (branch: object) => { allowed: boolean, reason: string, detail: string|null } }}
 */
function createGovernor(settings, deps = {}) {
  const s = settings || {};
  const pacingEnabled = s.pacing_enabled === undefined ? true : !!s.pacing_enabled;
  const globalCap = intOr(s.global_daily_action_cap, 0); // 0 = unlimited
  const activeStart = intOr(s.active_hours_start, 0);
  const activeEnd = intOr(s.active_hours_end, 24);
  const countActionsToday = deps.countActionsToday || ((accountId) => db.countActionsToday(accountId));
  const countBranchActionsToday =
    deps.countBranchActionsToday || ((branchId) => db.countBranchActionsToday(branchId));
  const now = deps.now || (() => new Date());

  /**
   * Safely read today's action count for the given scope, FAILING CLOSED.
   *
   * This is the anti-ban safety invariant: if the count source throws (locked /
   * corrupt DB) or returns a non-finite value (NaN/undefined/null), we must NOT
   * let the action through. A bare `count >= cap` with a NaN count evaluates to
   * `false` → ALLOWED — the single most dangerous default for a ban guard. So on
   * ANY ambiguity we return a sentinel that the caller treats as "cap reached"
   * (deny). canAct stays never-throwing because this helper never rethrows.
   * @param {() => number} counter zero-arg thunk returning today's count for the
   *   scope being checked (branch / account / global). Wrapping the count call in
   *   a thunk lets the SAME fail-closed guard protect all three cap tiers.
   * @returns {{ ok: boolean, count: number }} ok=false → fail-closed (deny)
   */
  function safeCount(counter) {
    let raw;
    try {
      raw = counter();
    } catch {
      // Count source threw (e.g. SQLITE_BUSY / corruption) — fail CLOSED.
      return { ok: false, count: NaN };
    }
    // Reject null/undefined BEFORE coercion: Number(null) === 0 (finite!) would
    // sneak a null count through as "0 actions → allow". The spec is explicit
    // that null/undefined are ambiguous and must fail closed, so guard them here.
    if (raw === null || raw === undefined) {
      return { ok: false, count: NaN };
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      // Non-finite count (NaN, or a non-numeric value) — ambiguous → fail CLOSED.
      return { ok: false, count: NaN };
    }
    return { ok: true, count: n };
  }

  /**
   * Three-tier daily-cap hierarchy. Most-specific tier first; a NULL/undefined cap
   * at a tier means "inherit the next-broader tier's cap". 0 = unlimited at any
   * tier (skip it). Each enforced tier is fail-closed via safeCount.
   *
   * @param {object} branch hydrated branch (uses .id, .accountId, .dailyActionCap,
   *   .accountDailyActionCap, .name, .timezoneId)
   * @returns {{ allowed: boolean, reason: string, detail: string|null }}
   *   reason ∈ { 'ok', 'pacing_disabled', 'outside_active_hours', 'branch_cap',
   *              'account_cap', 'global_cap', 'count_error' }
   */
  function canAct(branch) {
    // 1. Master switch off → governor is a no-op (humanizer delays still apply).
    if (!pacingEnabled) {
      return { allowed: true, reason: 'pacing_disabled', detail: null };
    }

    // 2. Active-hours window (account-local hour; timezone is per-account, carried
    //    on the hydrated branch as timezoneId).
    const hour = localHour(now(), branch && branch.timezoneId);
    if (!withinActiveHours(hour, activeStart, activeEnd)) {
      return {
        allowed: false,
        reason: 'outside_active_hours',
        detail: `local hour ${hour} outside [${activeStart},${activeEnd})`,
      };
    }

    // Resolve the three cap tiers. NULL/undefined inherits the next-broader tier.
    const acctCeilingRaw = branch ? branch.accountDailyActionCap : null;
    const acctCeiling =
      acctCeilingRaw === null || acctCeilingRaw === undefined
        ? globalCap
        : intOr(acctCeilingRaw, globalCap);
    const branchCapRaw = branch ? branch.dailyActionCap : null;
    const branchCap =
      branchCapRaw === null || branchCapRaw === undefined ? acctCeiling : intOr(branchCapRaw, acctCeiling);

    // 3. Per-BRANCH cap (counts THIS branch's actions; 0 = unlimited).
    if (branchCap > 0) {
      const { ok, count } = safeCount(() => countBranchActionsToday(branch ? branch.id : null));
      if (!ok) {
        return {
          allowed: false,
          reason: 'count_error',
          detail: 'branch daily count unavailable — failing closed (deny)',
        };
      }
      if (count >= branchCap) {
        return { allowed: false, reason: 'branch_cap', detail: `branch ${count}/${branchCap} today` };
      }
    }

    // 4. Per-ACCOUNT ceiling (sums ALL the account's branches; 0 = unlimited).
    if (acctCeiling > 0) {
      const accountId = branch ? branch.accountId : null;
      const { ok, count } = safeCount(() => countActionsToday(accountId));
      if (!ok) {
        return {
          allowed: false,
          reason: 'count_error',
          detail: 'account daily count unavailable — failing closed (deny)',
        };
      }
      if (count >= acctCeiling) {
        return { allowed: false, reason: 'account_cap', detail: `account ${count}/${acctCeiling} today` };
      }
    }

    // 5. GLOBAL daily cap (0 = unlimited).
    if (globalCap > 0) {
      const { ok, count: globalCount } = safeCount(() => countActionsToday(null));
      if (!ok) {
        return {
          allowed: false,
          reason: 'count_error',
          detail: 'global daily count unavailable — failing closed (deny)',
        };
      }
      if (globalCount >= globalCap) {
        return {
          allowed: false,
          reason: 'global_cap',
          detail: `global ${globalCount}/${globalCap} today`,
        };
      }
    }

    return { allowed: true, reason: 'ok', detail: null };
  }

  return { canAct };
}

module.exports = { createGovernor, withinActiveHours, localHour };
