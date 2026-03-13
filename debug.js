/**
 * debug.js — Takes a screenshot of what the browser sees on facebook.com/login
 * Saves it as debug-screenshot.png in the project folder.
 * Usage: node debug.js
 */

'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const accounts = require('./accounts.json');
const config = require('./config.json');

chromium.use(StealthPlugin());

async function main() {
  const account = accounts[0];

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: account.userAgent,
    viewport: { width: 1366, height: 768 },
    locale: account.locale || 'en-US',
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  console.log('Navigating to facebook.com/login...');
  await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  await page.screenshot({ path: 'debug-screenshot.png', fullPage: true });
  console.log('Screenshot saved: debug-screenshot.png');
  console.log('Current URL:', page.url());

  // Print all visible buttons
  const buttons = await page.$$eval('button, [role="button"]', (els) =>
    els.map((el) => el.innerText.trim()).filter(Boolean)
  );
  console.log('Visible buttons:', buttons);

  await browser.close();
}

main().catch(console.error);
