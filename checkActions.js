'use strict';

/**
 * checkActions.js — DIAGNOSTIC (throwaway). Proves the post-URL-format fix.
 *
 * Navigates to the SAME post via two URL forms and reports, for each, whether the
 * post and its Like / Comment / Share controls are present:
 *   - NEW: the canonical /posts/<pfbid> URL (what the fixed getLatestPost returns)
 *   - OLD: the reconstructed permalink.php?story_fbid=<pfbid>&id=<vanity> URL
 *          (what the buggy code navigated to — expected to fail to load the post)
 *
 * Run ON THE VPS, repo root, AFTER deploying the fixed fb/scrape.js:
 *   node checkActions.js sandy
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

// Control selectors lifted from fb/actions/{like,comment,share}.js (locale-aware).
const PROBE = {
  like: [
    '[data-ad-rendering-role="like_button"]',
    '[aria-label="Like"]',
    '[aria-label="أعجبني"]',
    '[aria-label="Unlike"]',
    '[aria-label="إلغاء الإعجاب"]',
  ],
  comment: [
    '[aria-label="Write a comment…"]',
    '[aria-label="Write a public comment…"]',
    '[aria-label="كتابة تعليق"]',
    '[aria-label="Leave a comment"]',
    'div[contenteditable="true"][role="textbox"]',
  ],
  share: [
    '[aria-label="Send this to friends or post it on your profile."]',
    '[aria-label="Share"]',
    '[aria-label="يمكنك إرسال هذا إلى الأصدقاء أو نشره على ملفك الشخصي."]',
  ],
};

async function probe(page, url, h) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
    throw new Error('goto failed: ' + e.message);
  });
  await h.randomDelay(3000, 5000);
  return page.evaluate((PROBE) => {
    const present = (sels) => sels.some((s) => document.querySelector(s));
    return {
      finalUrl: location.href,
      title: document.title,
      articles: document.querySelectorAll('[role="article"]').length,
      like: present(PROBE.like),
      comment: present(PROBE.comment),
      share: present(PROBE.share),
    };
  }, PROBE);
}

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node checkActions.js <accountName>');
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
    console.error('No enabled branch / targetPageUrl.');
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
  const h = { randomDelay: (a) => new Promise((r) => setTimeout(r, a)) };

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();

    // Resolve the current newest post (canonical URL via the fixed getLatestPost).
    const { postId, postUrl: NEW } = await getLatestPost(page, account, h);
    const vanity =
      new URL(account.targetPageUrl).searchParams.get('id') ||
      account.targetPageUrl.split('/').filter(Boolean).pop();
    const OLD = `https://www.facebook.com/permalink.php?story_fbid=${postId}&id=${vanity}`;

    console.log(`\npostId: ${postId}`);
    console.log(`NEW (canonical): ${NEW}`);
    console.log(`OLD (rebuilt)  : ${OLD}\n`);

    const newRes = await probe(page, NEW, h).catch((e) => ({ error: e.message }));
    console.log('NEW →', JSON.stringify(newRes));
    const oldRes = await probe(page, OLD, h).catch((e) => ({ error: e.message }));
    console.log('OLD →', JSON.stringify(oldRes));

    console.log('\n========== VERDICT ==========');
    const newOk = newRes && (newRes.like || newRes.comment || newRes.share);
    const oldOk = oldRes && (oldRes.like || oldRes.comment || oldRes.share);
    if (newOk && !oldOk) console.log('✓ URL FORMAT was the bug: controls present on NEW, absent on OLD.');
    else if (newOk && oldOk) console.log('~ Both load controls — URL may not be the sole factor.');
    else if (!newOk) console.log('✗ Controls NOT found even on NEW — selector drift too; capture the post DOM next.');
    console.log('=============================');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('[CHECK] Fatal:', e.message);
  process.exit(1);
});
