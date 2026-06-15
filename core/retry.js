'use strict';

/**
 * core/retry.js — the action retry wrapper + vision fallback hook.
 *
 * Port of index.js withRetry(). In the monolith withRetry read three globals:
 *   - config.screenshotOnError  → whether to screenshot on each failed attempt
 *   - config.useVision          → whether the last attempt may fall back to AI
 *   - aiAct (module-level)       → the vision action loop (or null)
 *
 * Those are now injected via a factory so retry has no global config coupling
 * and is unit-testable. The worker builds one retry per account from the DB
 * settings snapshot, passing a real aiAct only when settings.use_vision is on
 * (mirroring the monolith's import-time conditional, evaluated at worker start).
 *
 * Behaviour is preserved EXACTLY:
 *   - maxAttempts tries; on each failure: warn-log, optional screenshot.
 *   - On the FINAL attempt, if vision is enabled + a visionGoal + aiAct exist,
 *     try the vision fallback; success returns true.
 *   - Sleep delayMs between attempts (not after the last).
 *   - Returns the fn() result on success, or the RETRY_FAILED sentinel if all
 *     attempts (and the optional vision fallback) fail.
 *
 * FAILURE SIGNAL (P5 false-success fix): withRetry's original contract returned
 * `undefined` on attempts-exhaustion. But several actions (likePost,
 * commentOnPost) legitimately return `undefined` ON SUCCESS, so callers could
 * NOT distinguish "succeeded, no return value" from "failed all retries" — and
 * the worker logged every governed action as status:'ok' unconditionally. We
 * disambiguate with a dedicated Symbol sentinel, RETRY_FAILED: success returns
 * fn()'s real value (which may be `undefined`); exhaustion returns RETRY_FAILED.
 * A Symbol is collision-proof — no wrapped action can ever produce it — so a
 * `result === RETRY_FAILED` check is unambiguous where `result !== undefined`
 * would have INVERTED the bug for undefined-returning actions.
 */

const path = require('path');
const logger = require('../logger.js');
const { sleep } = require('./humanize.js');
const { detectBanSignal } = require('./ban-signal.js');

/**
 * Sentinel returned by withRetry when all attempts (and the vision fallback, if
 * any) are exhausted. Distinct, by identity, from any value a wrapped action can
 * return — including `undefined`, which is a legitimate success value for some
 * actions. Callers MUST compare with `=== RETRY_FAILED` (never `!== undefined`).
 * @type {symbol}
 */
const RETRY_FAILED = Symbol('retry-failed');

/**
 * Build a withRetry bound to a settings snapshot and (optionally) a vision fn.
 * @param {object} deps
 * @param {object} deps.settings db.getSettings() row (uses screenshot_on_error, use_vision)
 * @param {(page: any, goal: string, account: any) => Promise<boolean>} [deps.aiAct]
 *        vision fallback; pass undefined/null to disable (e.g. when use_vision is off)
 * @returns {(fn: Function, page: any, account: any, actionName: string,
 *            maxAttempts?: number, delayMs?: number, visionGoal?: string) => Promise<any>}
 */
function createRetry({ settings, aiAct } = {}) {
  const s = settings || {};
  const screenshotOnError = !!s.screenshot_on_error;
  const useVision = !!s.use_vision;

  return async function withRetry(
    fn,
    page,
    account,
    actionName,
    maxAttempts = 3,
    delayMs = 3000,
    visionGoal
  ) {
    // Per-call ban-signal de-dupe token: a single withRetry call can fail every
    // attempt against the SAME checkpoint, but we want at most ONE 'blocked' row
    // per call, not one per attempt. Threading this scope across attempts keeps
    // detection idempotent within the call.
    const banScope = { logged: false };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        logger.warn(account.name, actionName, `Attempt ${attempt}/${maxAttempts} failed: ${err.message}`);

        // MEDIUM (obs #4) — mid-run ban/checkpoint detection. A Facebook
        // checkpoint/challenge surfaced mid-session otherwise looks like a
        // generic action failure. Sniff the page (url + known challenge
        // selectors) on each failed attempt and, on a match, emit a 'blocked'
        // action_log row — the one signal that should wake the operator. This is
        // strictly best-effort: it never throws and never alters the retry flow
        // (we still consume the remaining attempts). banScope de-dupes so the
        // same checkpoint logs once per withRetry call, not once per attempt.
        await detectBanSignal(page, account, actionName, { scope: banScope }).catch(() => {});

        if (screenshotOnError && page) {
          try {
            const ts = Date.now();
            const screenshotPath = path.join(logger.SCREENSHOT_DIR, `${account.name}_${actionName}_${ts}.png`);
            await page.screenshot({ path: screenshotPath, fullPage: false });
            logger.warn(account.name, actionName, `Screenshot saved: ${screenshotPath}`);
          } catch {
            // ignore screenshot errors
          }
        }

        if (attempt === maxAttempts && useVision && visionGoal && aiAct) {
          logger.log(account.name, actionName, 'Hardcoded selectors exhausted — trying vision fallback...');
          const ok = await aiAct(page, visionGoal, account).catch((e) => {
            logger.warn(account.name, actionName, `Vision fallback threw: ${e.message}`);
            return false;
          });
          if (ok) {
            logger.log(account.name, actionName, 'Vision fallback succeeded.');
            return true;
          }
          logger.warn(account.name, actionName, 'Vision fallback also failed.');
        }

        if (attempt < maxAttempts) {
          await sleep(delayMs);
        }
      }
    }
    // All attempts (and the vision fallback, if any) exhausted — signal failure
    // with the dedicated sentinel so callers can log status:'failed' rather than
    // mistaking it for a successful undefined-returning action.
    return RETRY_FAILED;
  };
}

module.exports = { createRetry, sleep, RETRY_FAILED };
