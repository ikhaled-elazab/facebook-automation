'use strict';

/* global setTimeout, clearTimeout */
// setTimeout/clearTimeout are Node globals; declared here because the shared
// eslint config (eslint.config.js, not owned by this module) lists setTimeout in
// some scopes but not clearTimeout. Same convention as server/app.js + worker/loop.js.

/**
 * login-flow.js — the reusable, RESUMABLE Facebook login flow + its state machine.
 *
 * This is the security-sensitive core extracted from login.js so BOTH the CLI
 * (login.js) and the control-plane server (server/login-control.js) can drive the
 * SAME login logic. Login is ACCOUNT-level (one login = one browser = one stored
 * storageState session file).
 *
 * ── STATE MACHINE ────────────────────────────────────────────────────────────
 *   idle ─▶ running ─▶ needs_2fa ─▶ (code provided) ─▶ running ─▶ ok | failed
 *                 └────────────────────────────────────────────▶ ok | failed
 *
 *   - idle      : created, not yet started.
 *   - running   : browser launched, driving the login form / verifying.
 *   - needs_2fa : a 2FA / checkpoint was detected. The flow PAUSES here when
 *                 driven by the server (it does NOT block on a terminal prompt).
 *                 It resumes when a code is provided via provide2fa().
 *   - ok        : terminal — session storageState written to disk.
 *   - failed    : terminal — login did not succeed (bad creds, checkpoint we
 *                 could not satisfy, navigation failure, etc.).
 *
 * ── SECURITY (deep-reviewer discipline) ──────────────────────────────────────
 *   - The plaintext password is decrypted by the CALLER (login.js / the server
 *     route) and passed in as `password`. It is used to fill ONE field and then
 *     allowed to go out of scope. It is NEVER logged, NEVER stored back, NEVER
 *     written to disk, and NEVER placed on the public session view.
 *   - The 2FA code is a transient secret: it fills one field and is discarded; it
 *     is NEVER logged or persisted.
 *   - The only artifact written to disk is Playwright's storageState (cookies /
 *     localStorage for the logged-in session) at the configured session_file —
 *     exactly as the original login.js did. No credential material is in it.
 *   - Browser lifecycle: the browser is closed on EVERY exit path (success,
 *     failure, throw, or abort) so a failed/aborted login never orphans a
 *     chromium process tree.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { DEFAULT_USER_AGENT } = require('./core/fingerprint.js');

chromium.use(StealthPlugin());

/** The login-session lifecycle states (frozen — the canonical status vocabulary). */
const LOGIN_STATES = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  NEEDS_2FA: 'needs_2fa',
  // The HUMAN-DRIVEN pause: a headed browser is open and the operator must clear
  // a challenge we cannot automate from a typed code — an authenticator OTP, a QR
  // scan ("log in with a code from another device"), or a push-to-approve prompt.
  // Unlike needs_2fa (which resumes on provide2fa(code)), this state resolves when
  // the browser itself reaches a logged-in state, detected by polling.
  NEEDS_MANUAL: 'needs_manual',
  OK: 'ok',
  FAILED: 'failed',
});

/** Terminal states (no further transition possible). */
const TERMINAL_STATES = Object.freeze(new Set([LOGIN_STATES.OK, LOGIN_STATES.FAILED]));

/** Bound a 2FA wait so a session never hangs forever waiting for a human code. */
const DEFAULT_2FA_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Bound a manual login the same way: a parked browser must not wait forever. */
const DEFAULT_MANUAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
/** How often the manual flow re-checks whether the human has finished logging in. */
const DEFAULT_MANUAL_POLL_MS = 1500;

// ── Selectors (preserved verbatim from the original login.js) ─────────────────

const COOKIE_BTN_SELECTORS = Object.freeze([
  'button[data-cookiebanner="accept_button"]',
  'button[data-testid="cookie-policy-manage-dialog-accept-button"]',
  '[aria-label="Allow all cookies"]',
  'button:has-text("Allow all cookies")',
  'button:has-text("Accept All")',
  'button:has-text("Only allow essential cookies")',
]);

const EMAIL_SELECTORS = Object.freeze(['#email', 'input[name="email"]', 'input[type="email"]']);
const TWOFA_INPUT_SELECTOR =
  'input[name="approvals_code"], #approvals_code, input[autocomplete="one-time-code"]';

/**
 * A deferred promise: { promise, resolve, reject } — used to PAUSE the flow at
 * needs_2fa until the server (or CLI) supplies a code.
 * @template T
 * @returns {{promise: Promise<T>, resolve: (v:T)=>void, reject: (e:Error)=>void}}
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A driveable, resumable login session. One instance == one login attempt for one
 * account. The state machine is observable via .status / .detail; the flow is
 * started with run() and (when paused at needs_2fa) resumed with provide2fa().
 *
 * The browser interactions are injectable (deps.launchBrowser) so tests exercise
 * the state machine + DB/crypto wiring WITHOUT a real browser or network to FB.
 */
class LoginSession {
  /**
   * @param {object} params
   * @param {object} params.account hydrated account ENVELOPE (camelCase): must
   *   carry { name, sessionFile, userAgent, locale, timezoneId, proxy? }.
   * @param {string} params.email the login email/phone (already resolved).
   * @param {string} params.password the DECRYPTED plaintext password (used once,
   *   then allowed to go out of scope — never logged/stored).
   * @param {object} params.settings db.getSettings() row (uses use_proxy, headless).
   * @param {object} [params.proxyPassword] decrypted proxy password (or undefined).
   * @param {object} [deps] injectable dependencies (tests + CLI vs server).
   * @param {Function} [deps.launchBrowser] async () => Browser (defaults to stealth chromium).
   * @param {Function} [deps.logger] (msg:string) => void — server passes a no-op or
   *   a redacting logger; CLI passes console.log. NEVER receives secrets.
   * @param {number} [deps.twoFaTimeoutMs] how long needs_2fa waits before failing.
   * @param {number} [deps.manualTimeoutMs] how long needs_manual waits for a human.
   * @param {number} [deps.manualPollMs] interval between manual login-state checks.
   * @param {'auto'|'manual'} [params.mode] flow shape. 'auto' (default) drives the
   *   form + typed-code 2FA. 'manual' opens a headed browser and parks at
   *   needs_manual until the operator clears the challenge (OTP / QR / push) in it.
   */
  constructor({ account, email, password, settings, proxyPassword, mode }, deps = {}) {
    this._account = account;
    this._email = email;
    this._password = password; // transient — cleared after the fill
    this._settings = settings || {};
    this._proxyPassword = proxyPassword;
    this._mode = mode === 'manual' ? 'manual' : 'auto';

    this._launchBrowser = deps.launchBrowser || null;
    this._log = typeof deps.logger === 'function' ? deps.logger : () => {};
    this._twoFaTimeoutMs = deps.twoFaTimeoutMs || DEFAULT_2FA_TIMEOUT_MS;
    this._manualTimeoutMs = deps.manualTimeoutMs || DEFAULT_MANUAL_TIMEOUT_MS;
    this._manualPollMs = deps.manualPollMs || DEFAULT_MANUAL_POLL_MS;
    // Optional remote-browser streamer for the dashboard-driven manual flow:
    // (page) => LoginStream. Injected by the server (which streams a HEADLESS
    // browser to the UI); left null for the CLI (which opens a headed window) and
    // for tests that don't exercise streaming. Kept as a dep so login-flow.js does
    // not depend on the CDP layer directly.
    this._streamFactory = typeof deps.streamFactory === 'function' ? deps.streamFactory : null;
    this._stream = null;

    this._state = LOGIN_STATES.IDLE;
    this._detail = null;
    this._startedAt = null;
    this._finishedAt = null;

    // Set while paused at needs_2fa; resolved by provide2fa(); nulled on resume.
    this._twoFaDeferred = null;
    this._twoFaTimer = null;

    this._browser = null;
    this._aborted = false;
  }

  /** @returns {string} the current state-machine status. */
  get status() {
    return this._state;
  }

  /** @returns {string|null} a human-readable, SECRET-FREE detail for the status. */
  get detail() {
    return this._detail;
  }

  /**
   * @returns {object|null} the live remote-browser stream for a dashboard-driven
   * manual login (created once the headless browser is open), or null when there
   * is no stream (auto mode, CLI headed manual, or before/after the manual flow).
   * The WebSocket layer subscribes to this to relay frames + input.
   */
  get stream() {
    return this._stream;
  }

  /** @returns {boolean} true if the session has reached a terminal state. */
  get isTerminal() {
    return TERMINAL_STATES.has(this._state);
  }

  /**
   * A SECRET-FREE public view of the session, safe to return from an API.
   * Deliberately contains NO email, NO password, NO 2FA code.
   * @returns {{account_name:string, status:string, detail:string|null, started_at:number|null, finished_at:number|null}}
   */
  toPublic() {
    return {
      account_name: this._account.name,
      status: this._state,
      detail: this._detail,
      // The flow shape, so the UI can render the right surface for a paused
      // session: a code input for needs_2fa vs. a "complete it in the browser"
      // affordance (and, later, the embedded stream) for needs_manual.
      mode: this._mode,
      started_at: this._startedAt,
      finished_at: this._finishedAt,
    };
  }

  /** Internal: transition + record a secret-free detail. */
  _transition(state, detail = null) {
    this._state = state;
    this._detail = detail;
  }

  /**
   * Provide a 2FA code to a session paused at needs_2fa. Resolves the internal
   * deferred so run() resumes. Rejects (returns false) if the session is not
   * currently awaiting a code.
   * @param {string} code the 2FA / SMS code (transient — never logged/persisted).
   * @returns {boolean} true if the code was accepted into a waiting flow.
   */
  provide2fa(code) {
    if (this._state !== LOGIN_STATES.NEEDS_2FA || !this._twoFaDeferred) {
      return false;
    }
    const d = this._twoFaDeferred;
    this._twoFaDeferred = null;
    if (this._twoFaTimer) {
      clearTimeout(this._twoFaTimer);
      this._twoFaTimer = null;
    }
    d.resolve(String(code));
    return true;
  }

  /**
   * Abort a running session (e.g. control-plane shutdown). Forces a clean close
   * of the browser and moves to failed if not already terminal. Idempotent.
   * @returns {Promise<void>}
   */
  async abort() {
    this._aborted = true;
    if (this._twoFaDeferred) {
      const d = this._twoFaDeferred;
      this._twoFaDeferred = null;
      if (this._twoFaTimer) {
        clearTimeout(this._twoFaTimer);
        this._twoFaTimer = null;
      }
      d.reject(new Error('aborted'));
    }
    await this._closeBrowser();
    if (!this.isTerminal) this._transition(LOGIN_STATES.FAILED, 'Aborted.');
  }

  /** Close the browser best-effort. Idempotent — safe on every exit path. */
  async _closeBrowser() {
    // Stop the remote stream BEFORE the browser so the CDP session detaches
    // cleanly and connected dashboards see the stream end rather than a hard drop.
    if (this._stream) {
      const s = this._stream;
      this._stream = null;
      await s.stop().catch(() => {});
    }
    if (this._browser) {
      const b = this._browser;
      this._browser = null;
      await b.close().catch(() => {});
    }
  }

  /**
   * Wait for a 2FA code. When `interactiveAsk` is provided (CLI), it is used to
   * BLOCK on a terminal prompt. When absent (server), the flow PAUSES: it parks
   * on an internal deferred that provide2fa() resolves, bounded by a timeout so a
   * session never hangs forever.
   * @param {(question:string)=>Promise<string>} [interactiveAsk]
   * @returns {Promise<string>} the entered code
   */
  async _waitForTwoFaCode(interactiveAsk) {
    if (typeof interactiveAsk === 'function') {
      // CLI fallback: block on the terminal prompt.
      return interactiveAsk(`[LOGIN:${this._account.name}] Enter 2FA / SMS code: `);
    }
    // Server-driven: pause until provide2fa() resolves, bounded by a timeout.
    this._twoFaDeferred = deferred();
    this._twoFaTimer = setTimeout(() => {
      if (this._twoFaDeferred) {
        const d = this._twoFaDeferred;
        this._twoFaDeferred = null;
        d.reject(new Error('2FA code not provided in time'));
      }
    }, this._twoFaTimeoutMs);
    if (this._twoFaTimer && typeof this._twoFaTimer.unref === 'function') {
      this._twoFaTimer.unref();
    }
    return this._twoFaDeferred.promise;
  }

  /**
   * Run the full login flow to a terminal state. NEVER throws — every failure
   * path transitions to `failed` and closes the browser. Returns the final state.
   *
   * @param {object} [opts]
   * @param {(question:string)=>Promise<string>} [opts.interactiveAsk] CLI 2FA prompt.
   *   When omitted, the flow PAUSES at needs_2fa for server-driven resumption.
   * @returns {Promise<'ok'|'failed'>}
   */
  async run(opts = {}) {
    if (this._state !== LOGIN_STATES.IDLE) {
      throw new Error(`LoginSession.run() may only be called from idle (was ${this._state}).`);
    }
    if (!this._launchBrowser) {
      throw new Error('LoginSession requires deps.launchBrowser to be provided.');
    }

    this._startedAt = Date.now();
    this._transition(LOGIN_STATES.RUNNING, 'Launching browser.');

    try {
      // Ensure the session directory exists (preserve original behavior).
      const sessionPath = path.resolve(this._account.sessionFile);
      const sessionDir = path.dirname(sessionPath);
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

      this._browser = await this._launchBrowser();
      if (this._aborted) {
        await this._closeBrowser();
        this._transition(LOGIN_STATES.FAILED, 'Aborted before login started.');
        return this._finish();
      }

      const context = await this._browser.newContext(this._buildContextOptions());
      const page = await context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      if (this._mode === 'manual') {
        // Human-driven path: the (headed) browser is open at the login page; park
        // at needs_manual and wait for the operator to clear whatever challenge FB
        // shows (typed OTP, QR scan, or push-approve). We do NOT fill the password
        // here — the human owns the whole credential step.
        const done = await this._runManual(page, context);
        if (!done) {
          // Aborted or timed out without ever reaching a logged-in state. abort()
          // may already have moved us to a terminal state; only set one if not.
          if (!this.isTerminal) {
            this._transition(
              LOGIN_STATES.FAILED,
              this._aborted ? 'Aborted.' : 'Manual login not completed in time.'
            );
          }
          return this._finish();
        }
      } else {
        await this._fillLoginForm(page);
        if (this._state === LOGIN_STATES.FAILED) return this._finish();

        const needs2fa = await this._detectTwoFa(page);
        if (needs2fa) {
          this._transition(LOGIN_STATES.NEEDS_2FA, '2FA / checkpoint detected.');
          this._log(`[LOGIN:${this._account.name}] 2FA / checkpoint detected.`);
          let code;
          try {
            code = await this._waitForTwoFaCode(opts.interactiveAsk);
          } catch (err) {
            // Timeout, abort, or no-input — fail closed.
            this._transition(LOGIN_STATES.FAILED, `2FA not completed: ${err.message}`);
            return this._finish();
          }
          // Resume.
          this._transition(LOGIN_STATES.RUNNING, 'Submitting 2FA code.');
          await this._submitTwoFa(page, code);
          code = null; // discard the transient secret promptly
        }

        const ok = await this._verifySuccess(page);
        if (!ok) {
          await this._captureFailureScreenshot(page);
          this._transition(LOGIN_STATES.FAILED, 'Login did not reach a logged-in state.');
          return this._finish();
        }
      }

      // Persist the session storageState (the only on-disk artifact) — shared by
      // both the automated and the manual paths.
      await context.storageState({ path: sessionPath });
      this._log(`[LOGIN:${this._account.name}] Session saved.`);
      this._transition(LOGIN_STATES.OK, 'Session saved.');
      return this._finish();
    } catch (err) {
      // Any unexpected throw is mapped to failed with a SECRET-FREE message.
      this._transition(LOGIN_STATES.FAILED, `Login error: ${err.message}`);
      return this._finish();
    } finally {
      // Defense in depth: browser closed on EVERY exit path (no orphaned chromium).
      this._password = null; // ensure the plaintext password is released
      await this._closeBrowser();
    }
  }

  /** Stamp finishedAt and return the terminal state. */
  _finish() {
    this._finishedAt = Date.now();
    return this._state;
  }

  /**
   * Drive the MANUAL (human-in-the-loop) flow on an already-open page. Navigates
   * to the login page, dismisses the cookie banner, optionally pre-fills the email
   * (a convenience — never the password), then parks at needs_manual and waits for
   * the operator to finish logging in directly in the browser.
   *
   * Transport-agnostic: this method does NOT care HOW the human sees the browser.
   * On the VPS a HEADLESS browser is streamed to the dashboard via CDP screencast
   * (deps.streamFactory); in the CLI / a desktop build it is a native headed window
   * (no streamFactory). Either way the state machine is identical and the only
   * artifact is the captured storageState.
   *
   * @param {import('playwright').Page} page
   * @param {import('playwright').BrowserContext} context
   * @returns {Promise<boolean>} true if a logged-in state was reached (→ caller
   *   persists storageState); false on timeout/abort (→ caller fails closed).
   */
  async _runManual(page, context) {
    const name = this._account.name;
    this._log(`[LOGIN:${name}] Manual login: opening facebook.com/login...`);
    await page
      .goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch(() => {});

    // Bring the remote-browser stream up as soon as the page is open, so the
    // operator sees (and can drive) the login form itself — not just the later
    // challenge. Best-effort: a stream that fails to start must not fail the login
    // (the flow still works for a co-located headed window).
    if (this._streamFactory) {
      try {
        this._stream = this._streamFactory(page);
        await this._stream.start();
      } catch (err) {
        this._log(`[LOGIN:${name}] Remote stream failed to start: ${err.message}`);
        this._stream = null;
      }
    }

    // Best-effort cookie-consent dismissal (same selectors as the automated path).
    for (const sel of COOKIE_BTN_SELECTORS) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(500).catch(() => {});
        break;
      }
    }

    // Convenience only: pre-fill the email so the operator goes straight to the
    // challenge. Skipped silently if absent or the field is not present (e.g. a
    // QR-first login surface). The password is intentionally NOT pre-filled.
    if (this._email) {
      for (const sel of EMAIL_SELECTORS) {
        const field = await page.$(sel).catch(() => null);
        if (field) {
          await field.fill(this._email).catch(() => {});
          break;
        }
      }
    }

    this._transition(
      LOGIN_STATES.NEEDS_MANUAL,
      'Waiting for you to complete login in the opened browser (OTP / QR / approve).'
    );
    this._log(`[LOGIN:${name}] Parked at needs_manual — awaiting human completion.`);
    return this._waitForManualLogin(page, context);
  }

  /**
   * Poll until the human has logged in, the session is aborted, the page closes,
   * or the manual timeout elapses. Bounded + non-blocking: each tick yields via
   * page.waitForTimeout so this never busy-spins.
   * @param {import('playwright').Page} page
   * @param {import('playwright').BrowserContext} context
   * @returns {Promise<boolean>}
   */
  async _waitForManualLogin(page, context) {
    const deadline = Date.now() + this._manualTimeoutMs;
    for (;;) {
      if (this._aborted) return false;
      if (await this._manualLoginComplete(page, context)) return true;
      if (Date.now() >= deadline) return false;
      await page.waitForTimeout(this._manualPollMs).catch(() => {});
      if (typeof page.isClosed === 'function' && page.isClosed()) return false;
    }
  }

  /**
   * Decide whether the manual login has reached a logged-in state. The STRONGEST
   * signal is the presence of Facebook's `c_user` session cookie; we prefer it and
   * fall back to the URL heuristic (_verifySuccess) only when cookie inspection is
   * unavailable. Never throws — a probe failure is treated as "not yet".
   * @param {import('playwright').Page} page
   * @param {import('playwright').BrowserContext} context
   * @returns {Promise<boolean>}
   */
  async _manualLoginComplete(page, context) {
    if (context && typeof context.cookies === 'function') {
      try {
        const cookies = await context.cookies('https://www.facebook.com');
        if (Array.isArray(cookies) && cookies.some((c) => c && c.name === 'c_user' && c.value)) {
          return true;
        }
        // Cookie present-but-not-yet-set: keep waiting (don't fall through to the
        // weaker URL check, which could false-positive on an interstitial).
        return false;
      } catch {
        /* cookie inspection unavailable — fall back to the URL heuristic below */
      }
    }
    return this._verifySuccess(page).catch(() => false);
  }

  /**
   * Build Playwright context options for this account, decrypting nothing here —
   * the proxy password is passed in already-decrypted (or undefined).
   * @returns {object}
   */
  _buildContextOptions() {
    const a = this._account;
    const opts = {
      // Default a missing UA to the shared constant (NOT undefined → Playwright's
      // headless default, which contains "HeadlessChrome" and is a bot tell). The
      // worker reuses this session with the same default, so the fingerprint is
      // consistent between login and activity.
      userAgent: a.userAgent || DEFAULT_USER_AGENT,
      viewport: { width: 1366, height: 768 },
      locale: a.locale || 'en-US',
      timezoneId: a.timezoneId || 'America/New_York',
    };
    if (this._settings.use_proxy && a.proxy && a.proxy.server) {
      opts.proxy = {
        server: a.proxy.server,
        username: a.proxy.username || undefined,
        password: this._proxyPassword || undefined,
      };
      this._log(`[LOGIN:${a.name}] Proxy: ${a.proxy.server}`);
    } else if (this._settings.use_proxy) {
      this._log(`[LOGIN:${a.name}] use_proxy=true but no proxy configured — using host IP.`);
    }
    return opts;
  }

  /**
   * Navigate to the login page, dismiss cookie consent, fill credentials, submit.
   * Transitions to failed (and returns) if the email field never appears.
   * @param {import('playwright').Page} page
   */
  async _fillLoginForm(page) {
    const name = this._account.name;
    this._log(`[LOGIN:${name}] Navigating to facebook.com/login...`);
    await page.goto('https://www.facebook.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    for (const sel of COOKIE_BTN_SELECTORS) {
      const btn = await page.$(sel);
      if (btn) {
        this._log(`[LOGIN:${name}] Dismissing cookie dialog...`);
        await btn.click();
        await page.waitForTimeout(2000);
        break;
      }
    }

    let emailField = null;
    for (const sel of EMAIL_SELECTORS) {
      emailField = await page.waitForSelector(sel, { timeout: 10000 }).catch(() => null);
      if (emailField) break;
    }
    if (!emailField) {
      this._transition(LOGIN_STATES.FAILED, 'Could not find the email input on the login page.');
      return;
    }

    await emailField.fill(this._email);
    await page.waitForTimeout(400 + Math.random() * 600);
    // Fill the password (the ONLY use of the plaintext password). Never logged.
    await page.fill('input[name="pass"], #pass', this._password);
    await page.waitForTimeout(400 + Math.random() * 800);

    this._log(`[LOGIN:${name}] Submitting credentials...`);
    const loginBtn = await page.$('[name="login"], [aria-label="Log in"][role="button"]');
    if (loginBtn) {
      await loginBtn.click();
    } else {
      await page.press('input[name="pass"], #pass', 'Enter');
    }
    await page
      .waitForURL((url) => !url.href.includes('/login'), { timeout: 30000 })
      .catch(() => {});
    await page.waitForTimeout(2000);
  }

  /**
   * Detect a 2FA / checkpoint after credential submit.
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>}
   */
  async _detectTwoFa(page) {
    const url = page.url();
    return (
      url.includes('checkpoint') ||
      url.includes('two_step') ||
      url.includes('login/device-based') ||
      (await page.$('input[name="approvals_code"], #approvals_code')) !== null
    );
  }

  /**
   * Fill + submit the 2FA code, then dismiss the "Save browser?" prompt.
   * @param {import('playwright').Page} page
   * @param {string} code
   */
  async _submitTwoFa(page, code) {
    const codeInput = await page.$(TWOFA_INPUT_SELECTOR);
    if (!codeInput) {
      // Could not find the code field — give the page a moment, then verify will
      // decide success/failure. (We do not block 60s like the monolith did.)
      this._log(`[LOGIN:${this._account.name}] 2FA code input not found — continuing to verify.`);
      await page.waitForTimeout(2000);
      return;
    }
    await codeInput.fill(code);
    await page.waitForTimeout(500);
    const submitBtn = await page.$(
      'button[type="submit"], input[type="submit"], div[role="button"]:has-text("Continue")'
    );
    if (submitBtn) await submitBtn.click();
    await page.waitForTimeout(5000);

    const dontSave = await page.$(
      'div[role="button"]:has-text("Not Now"), button:has-text("Not Now")'
    );
    if (dontSave) {
      await dontSave.click();
      await page.waitForTimeout(2000);
    }
  }

  /**
   * Verify the final URL indicates a logged-in state.
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>}
   */
  async _verifySuccess(page) {
    const finalUrl = page.url();
    return (
      finalUrl.includes('facebook.com') &&
      !finalUrl.includes('/login') &&
      !finalUrl.includes('checkpoint')
    );
  }

  /**
   * Best-effort failure screenshot (gated on settings.screenshot_on_error). Never
   * throws. The screenshot contains the logged-out page only — no secrets.
   * @param {import('playwright').Page} page
   */
  async _captureFailureScreenshot(page) {
    if (!this._settings.screenshot_on_error) return;
    try {
      const dir = this._settings.log_dir || 'logs';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `login-fail-${this._account.name}-${Date.now()}.png`);
      await page.screenshot({ path: file, fullPage: true });
      this._log(`[LOGIN:${this._account.name}] Failure screenshot saved.`);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * The default stealth-chromium launcher (headless honoring the DB setting). Tests
 * inject their own launchBrowser; production code uses this.
 * @param {object} settings db.getSettings() row (uses headless)
 * @returns {Promise<import('playwright').Browser>}
 */
function defaultLaunchBrowser(settings) {
  return chromium.launch({
    headless: settings && settings.headless !== undefined ? !!settings.headless : true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

module.exports = {
  LoginSession,
  LOGIN_STATES,
  TERMINAL_STATES,
  defaultLaunchBrowser,
  DEFAULT_2FA_TIMEOUT_MS,
  DEFAULT_MANUAL_TIMEOUT_MS,
  DEFAULT_MANUAL_POLL_MS,
};
