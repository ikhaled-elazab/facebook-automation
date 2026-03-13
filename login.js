/**
 * login.js — Headless login for one or all accounts. Works on VPS (no display needed).
 *
 * Usage:
 *   node login.js                        → shows account list, prompts which to login
 *   node login.js --account account1     → login specific account by name
 *   node login.js --all                  → loop through every account sequentially
 *
 * Credentials can also be passed via env vars to skip prompts:
 *   FB_EMAIL="x@x.com" FB_PASS="secret" node login.js --account account1
 */

'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const accounts = require('./accounts.json');
const config = require('./config.json');

chromium.use(StealthPlugin());

// ─── Terminal helpers ─────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    // askHidden may be called when stdin is not a TTY (e.g. piped). Fall back gracefully.
    if (!stdin.isTTY) {
      let buf = '';
      stdin.once('data', (d) => { buf = d.toString().trim(); resolve(buf); });
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    stdin.on('data', function handler(ch) {
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '\u0003') {
        process.exit();
      } else if (ch === '\u007f') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(question + '*'.repeat(input.length));
        }
      } else {
        input += ch;
        process.stdout.write('*');
      }
    });
  });
}

// ─── Login one account ────────────────────────────────────────────────────────

async function loginAccount(account) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`[LOGIN] Account: ${account.name}`);

  // Ensure session directory exists
  const sessionDir = path.dirname(path.resolve(account.sessionFile));
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  // Priority: account.json → env vars → interactive prompt
  let email    = account.email    || process.env.FB_EMAIL || '';
  let password = account.password || process.env.FB_PASS  || '';

  if (!email)    email    = await ask(`[LOGIN:${account.name}] Facebook email / phone: `);
  if (!password) password = await askHidden(`[LOGIN:${account.name}] Password: `);

  console.log(`[LOGIN:${account.name}] Launching headless browser...`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const contextOptions = {
    userAgent: account.userAgent,
    viewport: { width: 1366, height: 768 },
    locale: account.locale || 'en-US',
    timezoneId: account.timezoneId || 'America/New_York',
  };

  if (config.useProxy && account.proxy && account.proxy.server) {
    contextOptions.proxy = {
      server:   account.proxy.server,
      username: account.proxy.username || undefined,
      password: account.proxy.password || undefined,
    };
    console.log(`[LOGIN:${account.name}] Proxy: ${account.proxy.server}`);
  } else if (config.useProxy) {
    console.warn(`[LOGIN:${account.name}] useProxy=true but no proxy configured — using VPS IP.`);
  } else {
    console.log(`[LOGIN:${account.name}] Proxy disabled (useProxy=false in config.json).`);
  }

  const context = await browser.newContext(contextOptions);

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // ── Fill login form ───────────────────────────────────────────────────────
  console.log(`[LOGIN:${account.name}] Navigating to facebook.com/login...`);
  await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Dismiss cookie / consent dialog if present (common on first visit)
  const cookieBtnSelectors = [
    'button[data-cookiebanner="accept_button"]',
    'button[data-testid="cookie-policy-manage-dialog-accept-button"]',
    '[aria-label="Allow all cookies"]',
    'button:has-text("Allow all cookies")',
    'button:has-text("Accept All")',
    'button:has-text("Only allow essential cookies")',
  ];
  for (const sel of cookieBtnSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      console.log(`[LOGIN:${account.name}] Dismissing cookie dialog...`);
      await btn.click();
      await page.waitForTimeout(2000);
      break;
    }
  }

  // Wait for email field — try multiple selectors
  const emailSelectors = ['#email', 'input[name="email"]', 'input[type="email"]'];
  let emailField = null;
  for (const sel of emailSelectors) {
    emailField = await page.waitForSelector(sel, { timeout: 10000 }).catch(() => null);
    if (emailField) break;
  }

  if (!emailField) {
    console.error(`[LOGIN:${account.name}] Could not find email input. Current URL: ${page.url()}`);
    await browser.close();
    return false;
  }

  await emailField.fill(email);
  await page.waitForTimeout(400 + Math.random() * 600);
  await page.fill('input[name="pass"], #pass', password);
  await page.waitForTimeout(400 + Math.random() * 800);

  console.log(`[LOGIN:${account.name}] Submitting...`);
  const loginBtn = await page.$('[name="login"], [aria-label="Log in"][role="button"]');
  if (loginBtn) {
    await loginBtn.click();
  } else {
    // Fallback: press Enter in password field
    console.log(`[LOGIN:${account.name}] Login button not found, using Enter key...`);
    await page.press('input[name="pass"], #pass', 'Enter');
  }
  await page.waitForURL(url => !url.href.includes('/login'), { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // ── 2FA / Checkpoint ──────────────────────────────────────────────────────
  const url = page.url();
  const needs2FA =
    url.includes('checkpoint') ||
    url.includes('two_step') ||
    url.includes('login/device-based') ||
    (await page.$('input[name="approvals_code"], #approvals_code')) !== null;

  if (needs2FA) {
    console.log(`[LOGIN:${account.name}] ⚠  2FA / Checkpoint detected.`);
    const code = await ask(`[LOGIN:${account.name}] Enter 2FA / SMS code: `);

    const codeInput = await page.$(
      'input[name="approvals_code"], #approvals_code, input[autocomplete="one-time-code"]'
    );
    if (codeInput) {
      await codeInput.fill(code);
      await page.waitForTimeout(500);
      const submitBtn = await page.$(
        'button[type="submit"], input[type="submit"], div[role="button"]:has-text("Continue")'
      );
      if (submitBtn) await submitBtn.click();
      await page.waitForTimeout(5000);

      // "Save browser?" → click Not Now
      const dontSave = await page.$('div[role="button"]:has-text("Not Now"), button:has-text("Not Now")');
      if (dontSave) { await dontSave.click(); await page.waitForTimeout(2000); }
    } else {
      console.warn(`[LOGIN:${account.name}] Could not find code input. Waiting 60s for manual action...`);
      await page.waitForTimeout(60000);
    }
  }

  // ── Verify login success ──────────────────────────────────────────────────
  const finalUrl = page.url();
  const ok =
    finalUrl.includes('facebook.com') &&
    !finalUrl.includes('/login') &&
    !finalUrl.includes('checkpoint');

  if (!ok) {
    console.error(`[LOGIN:${account.name}] ✗ Login failed. URL: ${finalUrl}`);
    const screenshotPath = `debug-login-fail-${account.name}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.error(`[LOGIN:${account.name}] Screenshot saved: ${screenshotPath}`);
    await browser.close();
    return false;
  }

  // ── Save session ──────────────────────────────────────────────────────────
  const sessionPath = path.resolve(account.sessionFile);
  await context.storageState({ path: sessionPath });
  console.log(`[LOGIN:${account.name}] ✓ Session saved → ${sessionPath}`);

  await browser.close();
  return true;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flagAll = args.includes('--all');
  const nameIdx = args.indexOf('--account');
  const targetName = nameIdx !== -1 ? args[nameIdx + 1] : null;

  let targets = [];

  if (flagAll) {
    targets = accounts;
  } else if (targetName) {
    const found = accounts.find((a) => a.name === targetName);
    if (!found) {
      console.error(`[LOGIN] No account named "${targetName}" found in accounts.json`);
      console.error(`[LOGIN] Available: ${accounts.map((a) => a.name).join(', ')}`);
      rl.close();
      process.exit(1);
    }
    targets = [found];
  } else {
    // Interactive: show list and let user pick
    console.log('\n[LOGIN] Available accounts:');
    accounts.forEach((a, i) => console.log(`  [${i + 1}] ${a.name}  (${a.sessionFile})`));
    console.log(`  [0] Login ALL accounts`);

    const choice = await ask('\n[LOGIN] Enter number: ');
    const idx = parseInt(choice, 10);

    if (idx === 0) {
      targets = accounts;
    } else if (idx >= 1 && idx <= accounts.length) {
      targets = [accounts[idx - 1]];
    } else {
      console.error('[LOGIN] Invalid choice.');
      rl.close();
      process.exit(1);
    }
  }

  for (const account of targets) {
    await loginAccount(account);
  }

  console.log('\n[LOGIN] Done. Run "npm start" to launch the bot.');
  rl.close();
}

main().catch((err) => {
  console.error('[LOGIN] Fatal:', err.message);
  rl.close();
  process.exit(1);
});
