/**
 * proxyCheck.js — Verify that every account's proxy is working correctly.
 *
 * For each account it:
 *   1. Opens a browser context through that account's proxy
 *   2. Hits an IP-echo API to confirm the exit IP
 *   3. Checks that no two accounts share the same exit IP
 *
 * Usage:
 *   node proxyCheck.js                   → check all accounts
 *   node proxyCheck.js --account account1 → check one account
 */

'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const accounts = require('./accounts.json');
const config = require('./config.json');

chromium.use(StealthPlugin());

const IP_CHECK_URL = 'https://api.ipify.org?format=json';

async function checkAccountProxy(browser, account) {
  const label = `[${account.name}]`;

  if (!account.proxy || !account.proxy.server) {
    console.warn(`${label} ⚠  No proxy configured. Skipping.`);
    return { name: account.name, ip: null, ok: false, reason: 'no proxy' };
  }

  console.log(`${label} Testing proxy: ${account.proxy.server}`);

  let context;
  try {
    context = await browser.newContext({
      proxy: {
        server:   account.proxy.server,
        username: account.proxy.username || undefined,
        password: account.proxy.password || undefined,
      },
      userAgent: account.userAgent,
    });

    const page = await context.newPage();

    // Set a tight timeout so a dead proxy fails fast
    const response = await page.goto(IP_CHECK_URL, { timeout: 20000, waitUntil: 'domcontentloaded' });

    if (!response || !response.ok()) {
      console.error(`${label} ✗ HTTP error from IP check: ${response?.status()}`);
      await context.close();
      return { name: account.name, ip: null, ok: false, reason: 'http error' };
    }

    const body = await response.text();
    const { ip } = JSON.parse(body);

    console.log(`${label} ✓ Exit IP: ${ip}`);
    await context.close();
    return { name: account.name, ip, ok: true };
  } catch (err) {
    console.error(`${label} ✗ Proxy failed: ${err.message}`);
    if (context) await context.close().catch(() => {});
    return { name: account.name, ip: null, ok: false, reason: err.message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const nameIdx = args.indexOf('--account');
  const targetName = nameIdx !== -1 ? args[nameIdx + 1] : null;

  const targets = targetName
    ? accounts.filter((a) => a.name === targetName)
    : accounts;

  if (!targets.length) {
    console.error(`No matching accounts found.`);
    process.exit(1);
  }

  console.log(`\nChecking proxies for ${targets.length} account(s)...\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];
  for (const account of targets) {
    const result = await checkAccountProxy(browser, account);
    results.push(result);
  }

  await browser.close();

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log('PROXY CHECK SUMMARY');
  console.log('─'.repeat(50));

  const successResults = results.filter((r) => r.ok);
  const failResults    = results.filter((r) => !r.ok);

  for (const r of results) {
    const status = r.ok ? '✓' : '✗';
    const ip = r.ip || r.reason || 'N/A';
    console.log(`  ${status}  ${r.name.padEnd(20)} ${ip}`);
  }

  // ── IP conflict check ─────────────────────────────────────────────────────
  const ipMap = {};
  for (const r of successResults) {
    if (!ipMap[r.ip]) ipMap[r.ip] = [];
    ipMap[r.ip].push(r.name);
  }

  const conflicts = Object.entries(ipMap).filter(([, names]) => names.length > 1);
  if (conflicts.length) {
    console.log('\n⚠  IP CONFLICTS DETECTED (accounts sharing the same exit IP):');
    for (const [ip, names] of conflicts) {
      console.log(`   ${ip} → ${names.join(', ')}`);
    }
    console.log('   Fix: assign a unique proxy to each account.\n');
  } else if (successResults.length > 1) {
    console.log('\n✓  All proxies use unique IPs. No conflicts.\n');
  }

  console.log(`\nResult: ${successResults.length}/${results.length} proxies OK`);

  if (failResults.length > 0) {
    console.log(`Failed: ${failResults.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
