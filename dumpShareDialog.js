'use strict';

/**
 * dumpShareDialog.js — DIAGNOSTIC (throwaway). Reveals the real label of the
 * "Share now" control inside the share menu for a (possibly non-English) account,
 * so the Arabic variant can be added to fb/actions/share.js without guessing.
 *
 * It navigates to the newest post, clicks the Share button (same selectors the
 * real code uses), waits for the menu, then dumps every visible menuitem/button/
 * option with its role + aria-label + text — highlighting share/"now" candidates.
 *
 * Run ON THE VPS, repo root, with the account logged in:
 *   node dumpShareDialog.js sandy
 *
 * Safe to delete after capture.
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

// The Share button selectors the real code uses (fb/actions/share.js:47-51).
const SHARE_BTN_SELECTORS = [
  '[aria-label="Send this to friends or post it on your profile."]',
  '[aria-label="Share"]',
  'div[role="button"]:has([data-ad-rendering-role="share_button"])',
  'div[role="button"]:has-text("Share")',
  '[aria-label="يمكنك إرسال هذا إلى الأصدقاء أو نشره على ملفك الشخصي."]',
];

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node dumpShareDialog.js <accountName>');
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

    const { postUrl } = await getLatestPost(page, account, h);
    console.log(`\npost: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    // Find + click the Share button using MOUSE COORDINATES (same as the real code
    // fb/actions/share.js — a plain .click() did not open the menu).
    let clicked = false;
    for (const sel of SHARE_BTN_SELECTORS) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(800);
        const box = await btn.boundingBox();
        if (box) {
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          await page.mouse.move(cx, cy, { steps: 10 });
          await page.waitForTimeout(500);
          await page.mouse.click(cx, cy);
        } else {
          await btn.click().catch(() => {});
        }
        clicked = true;
        console.log(`clicked Share via: ${sel}`);
        break;
      }
    }
    if (!clicked) {
      console.error('Share button not found — cannot open the menu.');
      process.exit(1);
    }

    // Give the share dialog/menu time to fully render its contents.
    await page.waitForTimeout(6000);

    // Screenshot for visual confirmation (scp it off the VPS if you want to eyeball it).
    const path2 = require('path');
    const shotDir = path2.resolve('logs');
    require('fs').mkdirSync(shotDir, { recursive: true });
    const shot = path2.join(shotDir, `share-dialog-${name}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

    // Dump the SHARE POPUP contents. Scope to the freshly-opened [role="menu"] /
    // [role="dialog"], and read each control's FULL innerText (FB nests the label in
    // child spans, so leaf-only text reading misses "مشاركة الآن"). Use innerText.
    const popups = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const controlsOf = (root) => {
        const els = Array.from(
          root.querySelectorAll('[role="menuitem"],[role="button"],[role="option"],a[role="link"]')
        );
        const out = [];
        const seen = new Set();
        for (const el of els) {
          if (!visible(el)) continue;
          const aria = el.getAttribute('aria-label') || '';
          const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
          const label = aria || text;
          if (!label) continue;
          const key = (el.getAttribute('role') || el.tagName) + '|' + label;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ role: el.getAttribute('role') || el.tagName.toLowerCase(), aria, text });
        }
        return out;
      };
      const containers = [
        ...Array.from(document.querySelectorAll('[role="menu"]')).map((el, i) => ({ kind: 'menu', i, el })),
        ...Array.from(document.querySelectorAll('[role="dialog"]')).map((el, i) => ({ kind: 'dialog', i, el })),
      ];
      const popupList = containers.map(({ kind, i, el }) => ({
        kind,
        i,
        ariaLabel: el.getAttribute('aria-label') || '',
        controls: controlsOf(el),
      }));

      // Global safety net: ANY visible element whose own text mentions share/now,
      // regardless of role — catches a "Share now" rendered as a plain div/span.
      const NOW = /الآن|مشاركة|share now|share to|نشر/i;
      const nowHits = [];
      const seen = new Set();
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // own text only (exclude text contributed by children)
        const own = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent)
          .join('')
          .trim();
        const aria = el.getAttribute('aria-label') || '';
        const label = (own || aria).trim();
        if (!label || label.length > 50 || !NOW.test(label)) continue;
        const key = el.tagName + '|' + label;
        if (seen.has(key)) continue;
        seen.add(key);
        nowHits.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          clickableAncestorRole:
            (el.closest('[role="button"],[role="menuitem"],[role="option"],a') || {}).getAttribute?.('role') || '',
          aria,
          text: own.slice(0, 50),
        });
      }
      return { popupList, nowHits };
    });

    console.log('\n========== SHARE POPUP(S) — menus & dialogs ==========');
    console.log(JSON.stringify(popups.popupList, null, 2));
    console.log('\n========== "now / share" TEXT HITS (any element) ==========');
    console.log(JSON.stringify(popups.nowHits, null, 2));
    console.log(`\nScreenshot: ${shot}`);
    console.log('=====================================================');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('[DUMP] Fatal:', e.message);
  process.exit(1);
});
