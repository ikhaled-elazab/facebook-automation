'use strict';

/**
 * dumpFeed.js — DIAGNOSTIC (throwaway). Captures the target-page feed the worker
 * sees, mirroring the worker's browser context (session/UA/locale/timezone/proxy),
 * and reports, per [role="article"]: the post link it exposes + any pinned markers.
 *
 * Purpose: confirm WHY the monitor reports the wrong "latest post" (it currently
 * takes the first post link in document order, which on a Page is the PINNED post)
 * and reveal the exact "pinned" marker for this account's locale so the fix in
 * fb/scrape.js getLatestPost can skip it reliably instead of guessing.
 *
 * Run ON THE VPS (it reads the VPS DB + session file), from the repo root:
 *   node dumpFeed.js <accountName> [pageUrlOverride]
 *   e.g.  node dumpFeed.js SANDY
 *         node dumpFeed.js SANDY "https://www.facebook.com/aba.ADahab.Real.Estate/"
 *
 * Output:
 *   - JSON summary to stdout (article order, links, pinned-marker candidates)
 *   - full page HTML written to ./logs/feed-dump-<account>.html  (for a test fixture)
 *
 * Safe to delete after capture. NOTE: page.$$eval / page.evaluate below are
 * Playwright DOM APIs, NOT JavaScript eval(); the lone RegExp is built from a
 * hardcoded pattern, not external input.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const db = require('./db');
const { decrypt } = require('./crypto');
const { accountEnvelope, hydrateBranch } = require('./worker/loadConfig');
const { DEFAULT_USER_AGENT } = require('./core/fingerprint.js');

chromium.use(StealthPlugin());

async function main() {
  const name = process.argv[2];
  const urlOverride = process.argv[3];
  if (!name) {
    console.error('Usage: node dumpFeed.js <accountName> [pageUrlOverride]');
    process.exit(1);
  }

  const acctRow = db.getAccountByName(name);
  if (!acctRow) {
    console.error(
      `No account named "${name}". Available: ${db.listAccounts().map((a) => a.name).join(', ')}`
    );
    process.exit(1);
  }
  const settings = db.getSettings();
  const env = accountEnvelope(acctRow);

  // Resolve the target page URL from the account's first ENABLED branch, exactly
  // like the worker — unless overridden on the CLI.
  let pageUrl = urlOverride;
  if (!pageUrl) {
    const branches = db.listBranches({ accountId: acctRow.id, enabledOnly: true });
    const b = branches[0] && hydrateBranch(acctRow, branches[0]);
    pageUrl = b && b.targetPageUrl;
  }
  if (!pageUrl) {
    console.error('No targetPageUrl found (no enabled branch?). Pass it explicitly as arg 2.');
    process.exit(1);
  }

  // Build context options the SAME way worker/loop.js buildContextOptions does, so
  // the DOM we capture matches what the worker actually sees.
  const sessionPath = path.resolve(env.sessionFile);
  if (!fs.existsSync(sessionPath)) {
    console.error(`Session file missing: ${sessionPath} — log this account in first.`);
    process.exit(1);
  }
  const opts = {
    storageState: sessionPath,
    userAgent: env.userAgent || DEFAULT_USER_AGENT,
    viewport: { width: 1366, height: 768 },
    locale: env.locale || 'en-US',
    timezoneId: env.timezoneId || 'America/New_York',
  };
  if (settings.use_proxy && env.proxy && env.proxy.server) {
    let proxyPassword;
    try {
      proxyPassword = env.proxy.passwordEnc ? decrypt(env.proxy.passwordEnc) : undefined;
    } catch {
      proxyPassword = undefined;
    }
    opts.proxy = {
      server: env.proxy.server,
      username: env.proxy.username || undefined,
      password: proxyPassword,
    };
  }

  console.log(`[DUMP] account=${name} locale=${opts.locale} proxy=${opts.proxy ? opts.proxy.server : '(none)'}`);
  console.log(`[DUMP] page=${pageUrl}`);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(opts);
    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    // Mirror getLatestPost's scroll (6 × 900px) so the feed renders the same way.
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, 900));
      await page.waitForTimeout(2000);
    }

    // What the CURRENT code picks: first post-like anchor across the WHOLE document.
    const currentPick = await page.$$eval('a[href]', (anchors) => {
      const links = anchors
        .map((a) => a.href)
        .filter(
          (href) =>
            href.includes('/posts/') ||
            href.includes('/permalink/') ||
            href.includes('story_fbid=') ||
            href.includes('permalink.php') ||
            href.includes('/videos/') ||
            href.includes('/photos/') ||
            /set=pcb\.\d+/.test(href)
        );
      return [...new Set(links)][0] || null;
    });

    // Per-article diagnostics: DOM order, first post link, and any pinned-marker text.
    const articles = await page.evaluate((pinReSrc) => {
      const PIN = new RegExp(pinReSrc, 'i');
      const arts = Array.from(document.querySelectorAll('[role="article"]'));
      return arts.slice(0, 6).map((art, idx) => {
        const links = Array.from(art.querySelectorAll('a[href]'))
          .map((a) => a.href)
          .filter(
            (h) =>
              !h.includes('comment_id=') &&
              (h.includes('/posts/') ||
                h.includes('story_fbid=') ||
                h.includes('/permalink/') ||
                h.includes('permalink.php'))
          );
        const head = (art.innerText || '').slice(0, 1200);
        const ariaHits = Array.from(art.querySelectorAll('[aria-label]'))
          .map((e) => e.getAttribute('aria-label'))
          .filter((l) => l && PIN.test(l));
        const spanHits = Array.from(art.querySelectorAll('span,h3,h4,a,div'))
          .map((e) => (e.childElementCount === 0 ? (e.textContent || '').trim() : ''))
          .filter((t) => t && t.length < 40 && PIN.test(t));
        return {
          idx,
          firstPostLink: links[0] || null,
          pinnedByText: PIN.test(head),
          ariaHits: [...new Set(ariaHits)].slice(0, 5),
          spanHits: [...new Set(spanHits)].slice(0, 5),
          textSnippet: head.slice(0, 160).replace(/\s+/g, ' '),
        };
      });
    }, 'pinned|مثبت|تثبيت|تم التثبيت');

    const outDir = path.resolve('logs');
    fs.mkdirSync(outDir, { recursive: true });
    const htmlPath = path.join(outDir, `feed-dump-${name}.html`);
    fs.writeFileSync(htmlPath, await page.content(), 'utf8');

    console.log('\n========== DIAGNOSTIC ==========');
    console.log('CURRENT CODE would pick (unique[0]):', currentPick);
    console.log('\nArticles in DOM order:');
    console.log(JSON.stringify(articles, null, 2));
    console.log(`\nFull HTML saved to: ${htmlPath}`);
    console.log('================================');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('[DUMP] Fatal:', e.message);
  process.exit(1);
});
