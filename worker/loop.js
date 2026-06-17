'use strict';

/* global setInterval, clearInterval */
// setInterval/clearInterval are Node globals; declared here because the shared
// eslint config (eslint.config.js, not owned by this module) lists setTimeout
// but not the interval timers. Same convention as server/app.js.

/**
 * worker/loop.js — per-account cycle + per-account runner.
 *
 * Ports index.js checkAndAct / runAccount, now DB-driven and per-account
 * isolated. Each account gets:
 *   - its OWN browser instance (launched in runAccount), so one account's
 *     browser crash can't take down the others (fixes the shared-browser HIGH).
 *   - a humanizer + retry built from the DB settings snapshot.
 *   - a vision fallback wired only when settings.use_vision is on.
 *
 * The orchestration order (monitor → like → comment → share-profile →
 * share-groups → reply-to-comments) and the per-action vision goal strings are
 * preserved EXACTLY from the monolith.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const logger = require('../logger.js');
const db = require('../db');
const { decrypt } = require('../crypto.js');
const { DEFAULT_USER_AGENT } = require('../core/fingerprint.js');
const { generateComment } = require('../ai.js');
const { createHumanizer } = require('../core/humanize.js');
const { createRetry, sleep, RETRY_FAILED } = require('../core/retry.js');
const { createGovernor } = require('../core/governor.js');
const { readLastPostId, writeLastPostId } = require('../core/state.js');
const { getLatestPost } = require('../fb/scrape.js');
const { likePost } = require('../fb/actions/like.js');
const { commentOnPost } = require('../fb/actions/comment.js');
const { shareToOwnProfile, shareToGroups } = require('../fb/actions/share.js');
const { monitorAndReplyToComments } = require('../fb/monitor.js');

chromium.use(StealthPlugin());

// ─── Reliability infrastructure (HIGH-2 heartbeat, HIGH-3 orphan-browser leak) ─
//
// HIGH-3: the per-account-browser design means N accounts = N chromium process
// trees. PM2 stop/restart hard-kills node mid-cycle; with no handler those trees
// are orphaned, and over many control-plane start/stop cycles the VPS OOMs.
// We track every live browser at module scope so a single shutdown path (invoked
// by SIGTERM/SIGINT/uncaughtException in index.js) can close them all.
const liveBrowsers = new Set();

// HIGH-2: the control-plane treats a heartbeat older than ~90s as a dead worker,
// but a single cycle (Facebook nav + scroll) routinely exceeds 90s. So we emit a
// lightweight "process alive" heartbeat on a timer comfortably under that
// threshold, independent of cycle progress. Per-account cycle status is written
// separately at cycle boundaries (see runAccount).
const HEARTBEAT_INTERVAL_MS = 25000; // < 90s control-plane staleness threshold
const BROWSER_CLOSE_TIMEOUT_MS = 8000; // bound a hung browser.close() on shutdown

let heartbeatTimer = null;
let shuttingDown = false;

/**
 * Register a live browser so the shutdown path can close it. Idempotent.
 *
 * RACE GUARD (HIGH — register-after-sweep orphan): shutdownAllBrowsers snapshots
 * then CLEARS liveBrowsers. A browser whose launch was parked inside an await
 * when SIGTERM landed would otherwise register into the already-swept Set and be
 * orphaned on exit. Because this function is the single choke point into the Set
 * and runs synchronously (no await between the shuttingDown check and the add),
 * guarding here collapses the race window to zero for ALL callers. If we are
 * already shutting down we refuse the registration and close the browser
 * best-effort, returning false so the caller can bail instead of running cycles
 * on a browser that is being torn down.
 * @param {import('playwright').Browser} browser
 * @returns {boolean} true if registered; false if refused (shutting down)
 */
function registerBrowser(browser) {
  if (!browser) return false;
  if (shuttingDown) {
    // Launch resolved after the sweep — don't leak it; close and refuse.
    Promise.resolve()
      .then(() => browser.close())
      .catch(() => {});
    logger.warn(null, 'SHUTDOWN', 'Browser launch resolved after shutdown began — closing it, not registering.');
    return false;
  }
  liveBrowsers.add(browser);
  return true;
}

/**
 * Unregister a browser once it has been closed in the normal path so we don't
 * double-close it (and don't leak the handle). Idempotent.
 * @param {import('playwright').Browser} browser
 */
function unregisterBrowser(browser) {
  liveBrowsers.delete(browser);
}

/**
 * Start the process-liveness heartbeat ticker. Writes an initial "running"
 * heartbeat immediately (boot) then every HEARTBEAT_INTERVAL_MS. The timer is
 * unref'd so it never keeps the event loop alive on its own. Idempotent — a
 * second call is a no-op so multiple accounts booting don't spawn N tickers.
 * @param {object} [hbDeps] injectable deps for testing
 * @param {Function} [hbDeps.heartbeat] (status, detail) => void (defaults to db.heartbeat)
 * @param {Function} [hbDeps.setInterval] (defaults to global setInterval)
 * @returns {NodeJS.Timeout|null} the timer handle (for tests), or null if already running
 */
function startHeartbeat(hbDeps = {}) {
  if (heartbeatTimer) return null;
  const beat = hbDeps.heartbeat || ((status, detail) => db.heartbeat(status, detail));
  const setIntervalFn = hbDeps.setInterval || setInterval;

  const tick = () => {
    try {
      beat('running', `pid=${process.pid} browsers=${liveBrowsers.size}`);
    } catch (err) {
      // A heartbeat write failure must never crash the worker — log and continue.
      logger.warn(null, 'HEARTBEAT', `Heartbeat write failed: ${err.message}`);
    }
  };

  tick(); // immediate boot heartbeat so the control-plane sees us right away
  heartbeatTimer = setIntervalFn(tick, HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  return heartbeatTimer;
}

/**
 * Stop the heartbeat ticker (called from the shutdown path). Idempotent.
 */
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Close all live browsers best-effort, each bounded by a timeout so a single
 * hung close() can't block process exit forever. Stops the heartbeat first and
 * writes a final "stopped" heartbeat. Idempotent + safe to call from any signal
 * handler. Resolves once all closes have settled (or timed out).
 * @param {object} [sdDeps] injectable deps for testing
 * @param {number} [sdDeps.timeoutMs] per-browser close timeout
 * @param {Function} [sdDeps.heartbeat] (status, detail) => void (defaults to db.heartbeat)
 * @returns {Promise<void>}
 */
async function shutdownAllBrowsers(sdDeps = {}) {
  shuttingDown = true;
  stopHeartbeat();

  const timeoutMs = sdDeps.timeoutMs || BROWSER_CLOSE_TIMEOUT_MS;
  const browsers = [...liveBrowsers];
  liveBrowsers.clear();

  const closeOne = (browser) =>
    Promise.race([
      Promise.resolve()
        .then(() => browser.close())
        .catch((err) => logger.warn(null, 'SHUTDOWN', `browser.close() failed: ${err.message}`)),
      new Promise((resolve) =>
        setTimeout(() => {
          logger.warn(null, 'SHUTDOWN', `browser.close() timed out after ${timeoutMs}ms — abandoning handle.`);
          resolve();
        }, timeoutMs).unref?.()
      ),
    ]);

  if (browsers.length) {
    logger.log(null, 'SHUTDOWN', `Closing ${browsers.length} browser(s)...`);
    await Promise.all(browsers.map(closeOne));
    logger.log(null, 'SHUTDOWN', 'All browsers closed.');
  }

  const beat = sdDeps.heartbeat || ((status, detail) => db.heartbeat(status, detail));
  try {
    beat('stopped', `pid=${process.pid} shutdown`);
  } catch {
    /* DB may be closing during shutdown — best-effort */
  }
}

/**
 * Map a withRetry action label to the action_log.action_type vocabulary
 * (like | comment | share | dm | monitor). The loop names each action for
 * withRetry; this normalizes those labels to the schema's CHECK-free but
 * conventional action_type values the governor + UI feed expect.
 * @param {string} label withRetry actionName (e.g. 'LIKE', 'SHARE-GROUPS')
 * @returns {string} action_type
 */
function actionTypeFor(label) {
  switch (label) {
    case 'LIKE':
      return 'like';
    case 'COMMENT':
      return 'comment';
    case 'SHARE':
    case 'SHARE-GROUPS':
      return 'share';
    case 'DM':
      return 'dm';
    default:
      return 'monitor';
  }
}

/**
 * Run one full check-and-act cycle for an account: detect the latest post and,
 * if new, like → comment → share to profile → share to groups.
 *
 * P5 GOVERNOR: each Facebook action is wrapped by a governed() gate. BEFORE the
 * action runs, the governor's canAct() is consulted; if it denies (cap reached
 * or outside active hours) the action is SKIPPED — a 'skipped' action_log row is
 * recorded and the cycle continues to the next action (never throws). When
 * allowed, the action runs via withRetry and an 'ok'/'failed' row is logged so
 * the cap counter advances. The post-detection MONITOR read is NOT gated or
 * cap-counted (reading is not a ban-risk write action), preserving prior behavior.
 *
 * @param {import('playwright').Page} page
 * @param {object} account hydrated account
 * @param {object} ctx run context ({ h, withRetry, governor, logAction }).
 *   settings is captured inside h + withRetry; governor + logAction are the P5
 *   pacing gate and the action-log sink (both injectable for tests).
 */
async function checkAndAct(page, account, ctx) {
  const { h, withRetry, governor, logAction } = ctx;
  const record = logAction || ((entry) => db.logAction(entry));

  logger.log(account.name, 'CHECK', `─`.repeat(40));
  logger.log(account.name, 'CHECK', new Date().toLocaleString());

  /**
   * Gate + run + log a single Facebook action. Returns the action's result on
   * success, or null when skipped/failed (a failed action's RETRY_FAILED
   * sentinel is mapped to null so downstream URL logic treats it as no-URL).
   * NEVER throws (a governor denial or an attempts-exhausted failure must not
   * break the cycle).
   *
   * FALSE-SUCCESS FIX: previously this logged status:'ok' UNCONDITIONALLY after
   * `await fn()` — but withRetry returned `undefined` on attempts-exhaustion and
   * never threw, so a fully-failed action was recorded as 'ok' and (worse)
   * counted toward the daily cap. Now withRetry returns the RETRY_FAILED
   * sentinel on exhaustion; we log 'failed' for that (which countActionsToday
   * does NOT count) and 'ok' only on a real success.
   * @param {string} label withRetry action label (also drives the cap action_type)
   * @param {() => Promise<any>} fn the withRetry-wrapped action invocation
   * @param {string} targetUrl the post/target url for the log row
   * @returns {Promise<any|null>} the action's real result, or null when skipped/failed
   */
  const governed = async (label, fn, targetUrl) => {
    if (governor) {
      const decision = governor.canAct(account);
      if (!decision.allowed) {
        logger.warn(account.name, label, `Skipped by pacing governor (${decision.reason}): ${decision.detail || ''}`);
        try {
          record({
            branchId: account.id,
            actionType: actionTypeFor(label),
            targetUrl,
            status: 'skipped',
            detail: `${decision.reason}: ${decision.detail || ''}`.trim(),
          });
        } catch {
          /* logging is best-effort — never let a log write break the cycle */
        }
        return null;
      }
    }
    const result = await fn();
    const failed = result === RETRY_FAILED;
    try {
      record({
        branchId: account.id,
        actionType: actionTypeFor(label),
        targetUrl,
        status: failed ? 'failed' : 'ok',
        detail: failed ? `${label} failed all retries` : null,
      });
    } catch {
      /* best-effort */
    }
    // Map the failure sentinel to null so downstream logic (e.g. the SHARE URL
    // capture) treats a failed action as "no result" rather than a truthy value.
    return failed ? null : result;
  };

  try {
    // Post detection is a READ — not gated, not cap-counted (no ban-risk write).
    // NOTE: withRetry now returns the RETRY_FAILED sentinel (a truthy Symbol) on
    // exhaustion, so `!latest` alone would NOT catch a failed read; check the
    // sentinel explicitly so a failed MONITOR bails instead of destructuring it.
    const latest = await withRetry(() => getLatestPost(page, account, h), page, account, 'MONITOR', 3, 5000);
    if (latest === RETRY_FAILED || !latest) {
      logger.warn(account.name, 'CHECK', 'Could not retrieve post after retries.');
      return;
    }

    const { postId, postUrl, postText } = latest;
    const lastId = readLastPostId(account);

    if (lastId === postId) {
      logger.log(account.name, 'CHECK', `No new post. Last seen: ${lastId}`);
      return;
    }

    logger.log(account.name, 'CHECK', `*** NEW POST DETECTED *** (ID: ${postId})`);
    writeLastPostId(account, postId);

    // Pre-generate comment so vision goal string matches what will be typed
    const comment = await generateComment(postText, account);

    await governed(
      'LIKE',
      () =>
        withRetry(
          () => likePost(page, postUrl, account, h),
          page,
          account,
          'LIKE',
          3,
          3000,
          'Find and click the Like button on this Facebook post. If the post already shows Unlike, the post is already liked — return done immediately.'
        ),
      postUrl
    );

    await governed(
      'COMMENT',
      () =>
        withRetry(
          () => commentOnPost(page, postUrl, postText, account, h),
          page,
          account,
          'COMMENT',
          3,
          3000,
          comment
            ? `Find the comment input box and type exactly: "${comment}" — then press Enter to submit.`
            : 'Find the comment input box, type a short positive comment, then press Enter.'
        ),
      postUrl
    );

    await sleep(3000);

    const profilePostUrl = await governed(
      'SHARE',
      () =>
        withRetry(
          () => shareToOwnProfile(page, postUrl, account, h),
          page,
          account,
          'SHARE',
          3,
          3000,
          'Click the Share button on this post. When the share dialog opens, click "Share now" to share to your own profile.'
        ),
      postUrl
    );

    if (profilePostUrl) {
      logger.log(
        account.name,
        'CHECK',
        `Profile post saved (${profilePostUrl}) — proceeding to share to groups.`
      );
    } else {
      logger.warn(
        account.name,
        'CHECK',
        'Profile post URL not captured — will share original post URL to groups.'
      );
    }

    await governed(
      'SHARE-GROUPS',
      () =>
        withRetry(
          () => shareToGroups(page, postUrl, account, h),
          page,
          account,
          'SHARE-GROUPS',
          3,
          3000,
          'Click the Share button on this post. In the dialog choose to share to a Group, select the target group, then click Post.'
        ),
      postUrl
    );

    logger.log(account.name, 'CHECK', `✓ All actions done for post: ${postId}`);
  } catch (err) {
    logger.logError(account.name, 'CHECK', err);
  }
}

/**
 * Build the Playwright browser-context options for an account, decrypting the
 * proxy password (if any) at build time. Mirrors the monolith buildContextOptions
 * but reads DB settings (use_proxy) + the hydrated account proxy shape.
 * @param {object} account hydrated account
 * @param {string} sessionPath resolved storage-state path
 * @param {object} settings db.getSettings() row (uses use_proxy)
 * @returns {object} context options
 */
function buildContextOptions(account, sessionPath, settings) {
  const opts = {
    storageState: sessionPath,
    // null user_agent (nullable column; UI/migration may leave it empty) would
    // crash newContext ("expected string, got object" — typeof null). Default to
    // the SAME UA the login flow uses so the reused session's fingerprint stays
    // consistent (a UA change between login and activity is a ban signal).
    userAgent: account.userAgent || DEFAULT_USER_AGENT,
    viewport: { width: 1366, height: 768 },
    locale: account.locale || 'en-US',
    timezoneId: account.timezoneId || 'America/New_York',
  };
  if (settings.use_proxy && account.proxy && account.proxy.server) {
    let proxyPassword;
    try {
      proxyPassword = account.proxy.passwordEnc ? decrypt(account.proxy.passwordEnc) : undefined;
    } catch (e) {
      logger.warn(account.name, 'BOOT', `Proxy password decrypt failed: ${e.message} — proceeding without proxy auth.`);
      proxyPassword = undefined;
    }
    opts.proxy = {
      server: account.proxy.server,
      username: account.proxy.username || undefined,
      password: proxyPassword,
    };
    logger.log(account.name, 'BOOT', `Proxy: ${account.proxy.server}`);
  } else if (settings.use_proxy) {
    logger.warn(account.name, 'BOOT', 'use_proxy=true but no proxy configured — using VPS IP.');
  }
  return opts;
}

// Supervised-restart backoff schedule (HIGH-1). One bad account run must not be
// silent, and must not require a whole-process restart — we respawn the account
// after an exponentially-growing, capped backoff, logging each restart.
const RESTART_BACKOFF_BASE_MS = 5000; // first restart waits 5s
const RESTART_BACKOFF_MAX_MS = 5 * 60 * 1000; // cap at 5 minutes
// A session that ran healthily for at least this long before dying is treated as
// a transient death, not a flap — backoff resets to base so a long-lived account
// recovers fast instead of inheriting an up-to-5min latency. Sessions that die
// faster than this keep doubling the backoff (flapping stays capped). The
// threshold sits well above any launch-then-immediately-crash flap and well
// below a real check interval (min 1m), so it cleanly separates the two cases.
const HEALTHY_SESSION_MS = 60 * 1000; // 60s

/**
 * Pure backoff-state transition for the supervisor. Given the wait used for the
 * session that just ended and how long that session ran, decide:
 *   - if the session ran healthily (>= HEALTHY_SESSION_MS): reset to base (the
 *     death was transient, not a flap — recover fast);
 *   - otherwise (fast death = flapping): the NEXT wait is the current wait
 *     doubled, capped at RESTART_BACKOFF_MAX_MS.
 * Extracted as a pure fn so the reset/double/cap logic is unit-testable without
 * driving the supervisor through real timers.
 * @param {number} currentBackoffMs the wait used before the session that ended
 * @param {number} sessionDurationMs how long that session ran
 * @returns {number} the backoff to use before the next restart
 */
function computeNextBackoff(currentBackoffMs, sessionDurationMs) {
  if (sessionDurationMs >= HEALTHY_SESSION_MS) return RESTART_BACKOFF_BASE_MS;
  return Math.min(currentBackoffMs * 2, RESTART_BACKOFF_MAX_MS);
}

/**
 * Resolve the account's hydrated branches list, defaulting to a single-element
 * list wrapping the account itself when no branches[] is present (legacy/test
 * callers that still pass a flat account object). This keeps runAccountSession
 * working for both the Phase 2 shape ({ ..., branches: [...] }) and a bare
 * account/branch object.
 * @param {object} account hydrated account (Phase 2: carries branches[])
 * @returns {object[]} branches to monitor this cycle (never empty if account valid)
 */
function resolveBranches(account) {
  if (Array.isArray(account.branches)) return account.branches;
  // Legacy/test fallback: treat the passed object itself as the (only) branch.
  return [account];
}

/**
 * The session-loop cadence: the SMALLEST check interval among the account's
 * branches (so no branch is starved), floored at 1 minute. Each cycle runs ALL
 * branches sequentially; using the min interval means a branch that wants a
 * 5-minute cadence is never delayed by a sibling that wants 30.
 * @param {object[]} branches
 * @returns {number} interval in ms
 */
function sessionIntervalMs(branches) {
  const mins = branches
    .map((b) => Number(b.checkIntervalMinutes))
    .filter((n) => Number.isFinite(n) && n > 0);
  const minMinutes = mins.length ? Math.min(...mins) : 7;
  return Math.max(minMinutes, 1) * 60 * 1000;
}

/**
 * Run one full account session inside ONE browser instance (one login = one
 * browser). Each CYCLE iterates the account's branches SEQUENTIALLY, each branch
 * a monitoring pass on the shared logged-in identity. A throw in ONE branch is
 * caught so SIBLING branches still run (mirrors the per-cycle guard, now per
 * branch — Phase 2). A throw OUTSIDE the per-branch guard (the browser itself
 * dying) propagates to the supervisor (runAccount) which respawns with backoff.
 *
 * Each branch reads/writes its own state by branch_id (the hydrated branch's
 * `.id`) and records its own per-branch status row.
 *
 * @param {object} account hydrated account (Phase 2: carries branches[])
 * @param {string} sessionPath resolved storage-state path (per-account login)
 * @param {object} settings db.getSettings() row
 * @param {object} ctx run context ({ settings, h, withRetry, governor, logAction })
 * @param {object} deps injectable deps ({ launchBrowser })
 */
async function runAccountSession(account, sessionPath, settings, ctx, deps) {
  const { h } = ctx;
  const branches = resolveBranches(account);
  const intervalMs = sessionIntervalMs(branches);
  const intervalMinutes = Math.round(intervalMs / 60000);

  // Each account owns its browser — a crash here is isolated to this account.
  const launchBrowser =
    deps.launchBrowser ||
    (() =>
      chromium.launch({
        headless: !!settings.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
        ],
      }));

  const browser = await launchBrowser();
  // HIGH-3 + register-after-sweep race: registerBrowser refuses (and closes) the
  // browser if shutdown began while we were parked inside launchBrowser(). On
  // refusal we bail immediately — no cycles, no leak. The browser is already
  // closed by registerBrowser, so we return without entering the finally's close.
  if (!registerBrowser(browser)) {
    logger.log(account.name, 'BOOT', 'Shutdown began during browser launch — aborting session start.');
    return;
  }

  // Per-branch status writer (P5 — account_status keyed by branch_id, so one
  // branch's error is never clobbered by a sibling's running). Best-effort.
  const recordBranchStatus = (branch, status, detail) => {
    try {
      db.setBranchStatus(branch.id, status, detail);
    } catch {
      /* per-branch status is best-effort — never break the cycle on a write */
    }
  };

  // Run ONE branch's monitoring pass in its own context. NEVER throws — a branch
  // failure is logged + recorded against that branch's status row, and the caller
  // continues to the next sibling branch (Phase 2 per-branch isolation).
  const runOneBranch = async (branch) => {
    recordBranchStatus(branch, 'running', `branch=${branch.branchName || branch.name} cycle started`);
    // A fresh context per branch keeps per-branch nav/cookies isolated while
    // reusing the one logged-in storageState (sessionFile) — same identity.
    let context = null;
    try {
      // browser.newContext() MUST be inside the try: a context-creation throw
      // (memory pressure / browser crash — real failure modes) has to isolate to
      // THIS branch, not propagate out of runOneBranch and tear down the account's
      // sibling-branch loop. (v2 regression fix: the refactor hoisted this above
      // the try, silently breaking the "NEVER throws" contract this function
      // promises and the per-branch isolation the whole feature depends on.)
      context = await browser.newContext(buildContextOptions(account, sessionPath, settings));
      const page = await context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      // checkAndAct + monitor operate on the BRANCH: its `.id` keys state/content,
      // its targetPageUrl/groups/comments drive the actions, and ctx threads the
      // SAME governor so the three-tier caps are enforced per write.
      await checkAndAct(page, branch, ctx);
      await monitorAndReplyToComments(page, branch, settings, h, ctx);
      recordBranchStatus(branch, 'ok', `branch=${branch.branchName || branch.name} cycle ok`);
    } catch (err) {
      // A single branch throwing must NOT break sibling branches.
      logger.logError(account.name, 'BRANCH', err);
      recordBranchStatus(
        branch,
        'error',
        `branch=${branch.branchName || branch.name} cycle failed: ${err.message}`
      );
    } finally {
      // context is null if newContext() itself threw — guard the close.
      if (context) await context.close().catch(() => {});
    }
  };

  // One full cycle = run EVERY branch sequentially. Never rejects: each branch is
  // individually guarded, and the global liveness heartbeat is written once per
  // cycle (HIGH-2 — the control-plane's process-alive contract).
  const runCycleGuarded = async () => {
    let anyError = false;
    for (const branch of branches) {
      if (shuttingDown) break;
      await runOneBranch(branch);
      // Re-read the branch's status to learn if it errored (cheap, best-effort).
      try {
        const st = db.getBranchStatus(branch.id);
        if (st && st.status === 'error') anyError = true;
      } catch {
        /* best-effort */
      }
    }
    try {
      db.heartbeat(
        anyError ? 'error' : 'running',
        `account=${account.name} cycle done (${branches.length} branch(es))`
      );
    } catch {
      /* heartbeat is best-effort */
    }
    logger.log(account.name, 'BOOT', `Cycle done for ${branches.length} branch(es).`);
  };

  try {
    // First check immediately, then on interval. runCycleGuarded never throws, so
    // the only ways out of this loop are an explicit shutdown or a throw from
    // sleep()/browser internals — both intentional escapes to the supervisor.
    await runCycleGuarded();

    while (!shuttingDown) {
      logger.log(account.name, 'BOOT', `Sleeping ${intervalMinutes}m before next cycle...`);
      await sleep(intervalMs);
      if (shuttingDown) break;
      await runCycleGuarded();
    }
  } finally {
    // Release the browser so a respawn doesn't leak processes. Unregister first
    // so the shutdown path doesn't also try to close an already-closed handle.
    unregisterBrowser(browser);
    await browser.close().catch(() => {});
  }
}

/**
 * Supervise an account indefinitely: run a session, and if it ever exits
 * abnormally (the browser died, launch failed, etc.) restart it after an
 * exponentially-growing, capped backoff — logging each restart. One account
 * dying must NOT require a full process restart and must NOT be silent (HIGH-1).
 *
 * On a CLEAN session exit (shutdown requested) the supervisor stops without
 * restarting. The heartbeat ticker is booted here (idempotent across accounts).
 *
 * @param {object} account hydrated account
 * @param {object} settings db.getSettings() row
 * @param {object} [deps] injectable deps for testing
 * @param {Function} [deps.launchBrowser] async () => Browser (defaults to chromium stealth launch)
 * @param {Function} [deps.aiAct] vision fallback (defaults to lazy-require of vision.js when use_vision)
 * @param {boolean} [deps.once] if true, run a single session and return (test hook)
 */
async function runAccount(account, settings, deps = {}) {
  const sessionPath = path.resolve(account.sessionFile);

  if (!fs.existsSync(sessionPath)) {
    logger.error(account.name, 'BOOT', `Session file not found: ${sessionPath}`);
    logger.error(account.name, 'BOOT', `Run: node login.js --account ${account.name}`);
    return;
  }

  const intervalMinutes = account.checkIntervalMinutes || 7;
  logger.log(account.name, 'BOOT', `Starting. Check interval: ${intervalMinutes}m`);

  // Boot the process-liveness heartbeat (idempotent — only the first account
  // starts the shared ticker). Skipped in test mode where deps inject control.
  if (!deps.skipHeartbeat) startHeartbeat();

  // Build per-account run context from the settings snapshot.
  const h = createHumanizer(settings);
  // Vision fallback is wired only when the DB setting is on (mirrors the
  // monolith's import-time `config.useVision ? require('./vision') : null`).
  let aiAct = deps.aiAct;
  if (aiAct === undefined) {
    aiAct = settings.use_vision ? require('../vision.js').aiAct : null;
  }
  const withRetry = createRetry({ settings, aiAct });
  // P5 safety-first pacing governor — gates every write action against the
  // active-hours window + per-account/global daily caps (injectable for tests).
  const governor = deps.governor || createGovernor(settings);
  const logAction = deps.logAction || ((entry) => db.logAction(entry));
  const ctx = { settings, h, withRetry, governor, logAction };

  let backoffMs = RESTART_BACKOFF_BASE_MS;

  // Supervisor loop: a session normally runs forever; if it exits abnormally we
  // restart it with backoff. A clean exit (shutdown) stops the supervisor.
  while (true) {
    const sessionStart = Date.now();
    try {
      await runAccountSession(account, sessionPath, settings, ctx, deps);
      // Clean return: either shutdown was requested, or deps.once (test) — stop.
      if (shuttingDown || deps.once) {
        logger.log(account.name, 'BOOT', 'Account session ended cleanly — supervisor stopping.');
        return;
      }
      // A session returning without shutdown is itself abnormal (the loop should
      // run forever). Treat it as a restart candidate rather than silently dying.
      logger.warn(account.name, 'SUPERVISOR', 'Session returned unexpectedly — restarting.');
    } catch (err) {
      logger.logError(account.name, 'SUPERVISOR', err);
      if (shuttingDown || deps.once) return;
    }

    // MEDIUM — backoff reset: a session that ran healthily before dying is a
    // transient death, not a flap, so the wait before THIS restart drops back to
    // base (fast recovery). A fast-dying (flapping) session doubles toward the
    // cap instead. computeNextBackoff is the pure decision for both cases; we
    // apply it to backoffMs BEFORE the sleep so a healthy death recovers in base
    // time rather than inheriting the previously-grown (up-to-5min) backoff.
    const sessionDurationMs = Date.now() - sessionStart;
    const wasGrown = backoffMs !== RESTART_BACKOFF_BASE_MS;
    backoffMs = computeNextBackoff(backoffMs, sessionDurationMs);
    if (sessionDurationMs >= HEALTHY_SESSION_MS && wasGrown) {
      logger.log(
        account.name,
        'SUPERVISOR',
        `Session ran healthily for ${Math.round(sessionDurationMs / 1000)}s — backoff reset to base.`
      );
    }

    logger.warn(
      account.name,
      'SUPERVISOR',
      `Restarting account in ${Math.round(backoffMs / 1000)}s (backoff)...`
    );
    await sleep(backoffMs);
    if (shuttingDown) return;
  }
}

/**
 * Reset module-private reliability state. TEST-ONLY: shutdownAllBrowsers sets
 * the module `shuttingDown` flag (so the supervisor stops respawning); a test
 * that exercises shutdown must clear it so a subsequent test starts from a clean
 * "not shutting down" state. Never call this from production code.
 */
function __resetForTest() {
  shuttingDown = false;
  stopHeartbeat();
  liveBrowsers.clear();
}

module.exports = {
  checkAndAct,
  runAccount,
  runAccountSession,
  buildContextOptions,
  // branch helpers (pure, unit-testable)
  resolveBranches,
  sessionIntervalMs,
  // reliability surface (wired by index.js signal handlers)
  registerBrowser,
  unregisterBrowser,
  shutdownAllBrowsers,
  startHeartbeat,
  stopHeartbeat,
  // supervisor backoff (pure, unit-testable)
  computeNextBackoff,
  // test-visible constants
  HEARTBEAT_INTERVAL_MS,
  BROWSER_CLOSE_TIMEOUT_MS,
  RESTART_BACKOFF_BASE_MS,
  RESTART_BACKOFF_MAX_MS,
  HEALTHY_SESSION_MS,
  // test-only
  __resetForTest,
};
