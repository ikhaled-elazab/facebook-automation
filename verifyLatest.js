'use strict';

/**
 * verifyLatest.js — DIAGNOSTIC (throwaway). Runs the REAL (fixed) getLatestPost N
 * times against the account's target page and prints the post id each run, then
 * whether the result is STABLE. Proves the virtualization fix: the monitor should
 * now return the SAME newest-post id every run (previously it flip-flopped between
 * older posts because it scrolled past the newest before reading).
 *
 * Run ON THE VPS, from the repo root, AFTER deploying the fixed fb/scrape.js:
 *   node verifyLatest.js <accountName> [count]
 *   e.g.  node verifyLatest.js sandy 5
 *
 * Safe to delete after verifying.
 */

const path = require('path');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const db = require('./db');
const { decrypt } = require('./crypto');
const { accountEnvelope, hydrateBranch } = require('./worker/loadConfig');
const { DEFAULT_USER_AGENT } = require('./core/fingerprint.js');
const { getLatestPost } = require('./fb/scrape.js');

chromium.use(StealthPlugin());

async function main() {
  const name = process.argv[2];
  const count = parseInt(process.argv[3] || '5', 10);
  if (!name) {
    console.error('Usage: node verifyLatest.js <accountName> [count]');
    process.exit(1);
  }

  const acctRow = db.getAccountByName(name);
  if (!acctRow) {
    console.error(`No account named "${name}".`);
    process.exit(1);
  }
  const settings = db.getSettings();
  const env = accountEnvelope(acctRow);
  const branches = db.listBranches({ accountId: acctRow.id, enabledOnly: true });
  const branch = branches[0] && hydrateBranch(acctRow, branches[0]);
  if (!branch || !branch.targetPageUrl) {
    console.error('No enabled branch / targetPageUrl found.');
    process.exit(1);
  }

  const opts = {
    storageState: path.resolve(env.sessionFile),
    userAgent: env.userAgent || DEFAULT_USER_AGENT,
    viewport: { width: 1366, height: 768 },
    locale: env.locale || 'en-US',
    timezoneId: env.timezoneId || 'America/New_York',
  };
  if (settings.use_proxy && env.proxy && env.proxy.server) {
    let pw;
    try {
      pw = env.proxy.passwordEnc ? decrypt(env.proxy.passwordEnc) : undefined;
    } catch {
      pw = undefined;
    }
    opts.proxy = { server: env.proxy.server, username: env.proxy.username || undefined, password: pw };
  }

  const account = { name, targetPageUrl: branch.targetPageUrl };
  // Minimal humanizer: getLatestPost only uses h.randomDelay(min,max).
  const h = { randomDelay: (a) => new Promise((r) => setTimeout(r, a)) };

  console.log(`[VERIFY] ${name} × ${count} on ${account.targetPageUrl}\n`);

  const browser = await chromium.launch({ headless: true });
  const ids = [];
  try {
    for (let i = 0; i < count; i++) {
      const ctx = await browser.newContext(opts);
      const page = await ctx.newPage();
      try {
        const { postId } = await getLatestPost(page, account, h);
        ids.push(postId);
        console.log(`run ${i + 1}/${count}: ${postId}`);
      } catch (e) {
        ids.push('ERR:' + e.message);
        console.log(`run ${i + 1}/${count}: ERROR ${e.message}`);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  const uniq = [...new Set(ids)];
  console.log('\n========== RESULT ==========');
  console.log(uniq.length === 1 ? `✓ STABLE: ${uniq[0]}` : `✗ STILL FLAKY (${uniq.length}): ${JSON.stringify(uniq, null, 2)}`);
  console.log('============================');
}

main().catch((e) => {
  console.error('[VERIFY] Fatal:', e.message);
  process.exit(1);
});
