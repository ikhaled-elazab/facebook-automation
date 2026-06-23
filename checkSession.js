'use strict';

/**
 * checkSession.js — DIAGNOSTIC (throwaway). Loads an account's saved session and
 * reports whether it is actually LOGGED IN (vs. showing a login form / checkpoint).
 *   node checkSession.js sandy          # headless
 *   HEADED=1 node checkSession.js sandy # visible window
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const db = require('./db');
const { accountEnvelope } = require('./worker/loadConfig');
const { DEFAULT_USER_AGENT } = require('./core/fingerprint.js');

chromium.use(StealthPlugin());

async function main() {
  const name = process.argv[2] || 'sandy';
  const acct = db.getAccountByName(name);
  if (!acct) {
    console.error(`No account "${name}".`);
    process.exit(1);
  }
  const env = accountEnvelope(acct);
  const sessionPath = path.resolve(env.sessionFile);
  console.log(
    `session: ${sessionPath} ${fs.existsSync(sessionPath) ? `(${fs.statSync(sessionPath).size} bytes)` : '(MISSING)'}`
  );

  const opts = {
    storageState: fs.existsSync(sessionPath) ? sessionPath : undefined,
    userAgent: env.userAgent || DEFAULT_USER_AGENT,
    viewport: { width: 1366, height: 768 },
    locale: env.locale || 'en-US',
    timezoneId: env.timezoneId || 'America/New_York',
  };

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  try {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      hasLoginForm: !!document.querySelector(
        'input[name="email"], input[name="pass"], form[action*="login"]'
      ),
      hasComposer: !!document.querySelector(
        "[aria-label*=\"What's on your mind\"], [aria-label*='بم تفكر']"
      ),
      hasNav: !!document.querySelector('[aria-label="Facebook"], [aria-label="فيسبوك"]'),
      checkpointish: /checkpoint|two-factor|تسجيل الدخول|رمز|confirm|verify/i.test(
        (document.body.innerText || '').slice(0, 400)
      ),
      bodyText: (document.body.innerText || '').slice(0, 220).replace(/\s+/g, ' '),
    }));
    console.log(JSON.stringify(info, null, 2));
    const loggedIn = !info.hasLoginForm && (info.hasNav || info.hasComposer);
    console.log(loggedIn ? '\n✓ LOGGED IN' : '\n✗ NOT logged in (invalid/expired session or checkpoint)');
    fs.mkdirSync('logs', { recursive: true });
    await page.screenshot({ path: `logs/session-check-${name}.png` });
    console.log(`screenshot: logs/session-check-${name}.png`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
