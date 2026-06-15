'use strict';

/**
 * core/ban-signal.js — mid-run Facebook checkpoint / challenge / login-redirect
 * detection (P5 obs #4).
 *
 * BEFORE: a Facebook checkpoint was only detected at login (login.js). Once the
 * worker was running, a mid-session challenge (account flagged, suspicious-login
 * interstitial, forced re-login) just looked like a string of generic action
 * failures — retries exhausting against a page that will never succeed. The
 * operator had no filterable, page-able signal that the account is in trouble.
 *
 * AFTER: on each failed action attempt, the retry wrapper calls detectBanSignal
 * with the live page. We sniff the page URL for the canonical FB challenge paths
 * and probe for a small set of known challenge DOM markers; on a match we write
 * ONE action_log row with status 'blocked' (the agreed status vocabulary's ban
 * signal). 'blocked' rows do NOT count toward the daily cap (countActionsToday
 * filters status='ok'); they exist purely so the dashboard / alerting can page
 * the operator on the one event that needs a human.
 *
 * SAFETY CONTRACT: detectBanSignal is best-effort and NEVER throws. It is called
 * from inside a catch block that is already handling an action failure — a throw
 * here would mask the real error or break the retry flow. Every internal
 * operation (page.url(), page.$, db.logAction) is individually guarded. A null /
 * absent page is a no-op (tests, headless edge cases).
 *
 * DE-DUPE: a single withRetry call can fail up to maxAttempts times against the
 * same checkpoint. We don't want maxAttempts identical 'blocked' rows per call,
 * so detection state is keyed by a per-call token. The retry wrapper passes a
 * fresh token per call; within that token only the first match logs.
 */

const logger = require('../logger.js');
const db = require('../db');

/**
 * URL substrings that indicate a Facebook checkpoint / challenge / forced
 * re-login. Matched case-insensitively against the current page URL. These are
 * the canonical FB interstitial paths surfaced when an account is flagged.
 * @type {string[]}
 */
const CHECKPOINT_URL_MARKERS = ['/checkpoint', 'checkpoint/', '/challenge', 'challenge/', '/login', '/recover'];

/**
 * DOM selectors that indicate a challenge interstitial when present on a page
 * whose URL did not already match. Kept intentionally small + conservative to
 * avoid false positives on normal pages. Best-effort — a selector miss is fine.
 * @type {string[]}
 */
const CHECKPOINT_DOM_MARKERS = [
  'form[action*="checkpoint"]',
  'form[action*="challenge"]',
  '[data-testid="checkpoint"]',
  'input[name="approvals_code"]',
];

/**
 * Classify a page URL: does it look like a checkpoint/challenge/login-redirect?
 * Pure + synchronous so it is trivially unit-testable. A non-string / empty url
 * is "not a ban signal" (false). Login-redirect is included because a mid-run
 * bounce back to /login is the soft form of the same problem (session invalid).
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
function isCheckpointUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  return CHECKPOINT_URL_MARKERS.some((m) => lower.includes(m));
}

/**
 * Probe the page for a checkpoint signal. Checks the URL first (cheap, no DOM),
 * then a few conservative DOM markers. Returns the matched reason string for the
 * log detail, or null when no signal is found. NEVER throws — a page that throws
 * on url()/$() is treated as "no signal" (we are already in a failure path).
 * @param {import('playwright').Page|null|undefined} page
 * @returns {Promise<string|null>} a short reason (e.g. "url:/checkpoint") or null
 */
async function probe(page) {
  if (!page) return null;

  // 1. URL sniff (cheap, synchronous-ish — page.url() is sync in Playwright).
  let url = null;
  try {
    url = typeof page.url === 'function' ? page.url() : null;
  } catch {
    url = null;
  }
  if (isCheckpointUrl(url)) {
    const marker = CHECKPOINT_URL_MARKERS.find((m) => url.toLowerCase().includes(m));
    return `url:${marker}`;
  }

  // 2. DOM marker probe (only if the URL was inconclusive). Guard each query.
  if (typeof page.$ === 'function') {
    for (const sel of CHECKPOINT_DOM_MARKERS) {
      let el = null;
      try {
        el = await page.$(sel);
      } catch {
        el = null;
      }
      if (el) return `dom:${sel}`;
    }
  }

  return null;
}

/**
 * Detect a mid-run ban/checkpoint signal and, on the FIRST match within a
 * detection scope, log a single status:'blocked' action_log row. Best-effort:
 * never throws, never alters the caller's control flow.
 *
 * @param {import('playwright').Page|null|undefined} page the live page
 * @param {object} account hydrated branch (Phase 2: `.id` is the branch id, used
 *   as the action_log branch scope; `.name` is the account login name for logs)
 * @param {string} actionName the action that was failing (for the log detail)
 * @param {object} [deps] injectable deps for testing
 * @param {Function} [deps.logAction] (entry) => void (defaults to db.logAction)
 * @param {{ logged: boolean }} [deps.scope] per-call de-dupe token; when omitted
 *   a fresh internal scope is used (each call may log once).
 * @returns {Promise<boolean>} true if a ban signal was detected this call (even
 *   if a duplicate suppressed the log); false if no signal.
 */
async function detectBanSignal(page, account, actionName, deps = {}) {
  try {
    const reason = await probe(page);
    if (!reason) return false;

    const scope = deps.scope || { logged: false };
    if (scope.logged) return true; // already logged within this scope — signal still true

    const logAction = deps.logAction || ((entry) => db.logAction(entry));
    let url = null;
    try {
      url = typeof page.url === 'function' ? page.url() : null;
    } catch {
      url = null;
    }

    try {
      logAction({
        branchId: account && account.id !== undefined ? account.id : null,
        actionType: 'monitor',
        targetUrl: url,
        status: 'blocked',
        detail: `ban/checkpoint detected during ${actionName} (${reason})`,
      });
      scope.logged = true;
      logger.error(
        account && account.name,
        'BAN-SIGNAL',
        `Facebook checkpoint/challenge detected during ${actionName} (${reason}) — operator action needed.`
      );
    } catch {
      /* logging is best-effort — a failed log write must not break the action loop */
    }

    return true;
  } catch {
    // Absolute backstop: detection must never throw into the caller's catch.
    return false;
  }
}

module.exports = { detectBanSignal, isCheckpointUrl, probe, CHECKPOINT_URL_MARKERS, CHECKPOINT_DOM_MARKERS };
