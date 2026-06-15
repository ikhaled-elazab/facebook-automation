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
 *   3. daily caps — per-account (account.dailyActionCap) AND global
 *      (settings.global_daily_action_cap). 0 = UNLIMITED for either (special-cased,
 *      NOT "cap of zero = block everything"). The per-account cap, when NULL,
 *      inherits the global cap.
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
 * @param {(accountId?: number|null) => number} [deps.countActionsToday] defaults to db.countActionsToday.
 * @param {() => Date} [deps.now] clock, defaults to () => new Date().
 * @returns {{ canAct: (account: object) => { allowed: boolean, reason: string, detail: string|null } }}
 */
function createGovernor(settings, deps = {}) {
  const s = settings || {};
  const pacingEnabled = s.pacing_enabled === undefined ? true : !!s.pacing_enabled;
  const globalCap = intOr(s.global_daily_action_cap, 0); // 0 = unlimited
  const activeStart = intOr(s.active_hours_start, 0);
  const activeEnd = intOr(s.active_hours_end, 24);
  const countActionsToday = deps.countActionsToday || ((accountId) => db.countActionsToday(accountId));
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
   * @param {number|null} accountId scope (null = global)
   * @returns {{ ok: boolean, count: number }} ok=false → fail-closed (deny)
   */
  function safeCount(accountId) {
    let raw;
    try {
      raw = countActionsToday(accountId);
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
   * @param {object} account hydrated account (uses .id, .name, .dailyActionCap, .timezoneId)
   * @returns {{ allowed: boolean, reason: string, detail: string|null }}
   *   reason ∈ { 'ok', 'pacing_disabled', 'outside_active_hours', 'account_cap',
   *              'global_cap', 'count_error' }
   */
  function canAct(account) {
    // 1. Master switch off → governor is a no-op (humanizer delays still apply).
    if (!pacingEnabled) {
      return { allowed: true, reason: 'pacing_disabled', detail: null };
    }

    // 2. Active-hours window (account-local hour).
    const hour = localHour(now(), account && account.timezoneId);
    if (!withinActiveHours(hour, activeStart, activeEnd)) {
      return {
        allowed: false,
        reason: 'outside_active_hours',
        detail: `local hour ${hour} outside [${activeStart},${activeEnd})`,
      };
    }

    // 3. Per-account daily cap (NULL/undefined inherits the global cap; 0 = unlimited).
    const acctCapRaw = account ? account.dailyActionCap : null;
    const acctCap =
      acctCapRaw === null || acctCapRaw === undefined ? globalCap : intOr(acctCapRaw, globalCap);
    if (acctCap > 0) {
      const { ok, count: acctCount } = safeCount(account ? account.id : null);
      if (!ok) {
        // Count unavailable/ambiguous — fail CLOSED (deny) rather than allow.
        return {
          allowed: false,
          reason: 'count_error',
          detail: 'account daily count unavailable — failing closed (deny)',
        };
      }
      if (acctCount >= acctCap) {
        return {
          allowed: false,
          reason: 'account_cap',
          detail: `account ${acctCount}/${acctCap} today`,
        };
      }
    }

    // 4. Global daily cap (0 = unlimited).
    if (globalCap > 0) {
      const { ok, count: globalCount } = safeCount(null);
      if (!ok) {
        // Count unavailable/ambiguous — fail CLOSED (deny) rather than allow.
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
