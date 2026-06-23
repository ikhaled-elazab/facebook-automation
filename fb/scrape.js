'use strict';

/**
 * fb/scrape.js — post discovery on pages, profiles, and groups.
 *
 * Ports index.js getLatestPost / getLatestProfilePost / getLatestPostInGroup /
 * getLatestPostInGroupByUser. The selector and scroll logic — the fragile,
 * hard-won part — is preserved VERBATIM. The only changes are:
 *   - humanization comes from an injected humanizer `h` (h.randomDelay) bound to
 *     the account's DB settings, instead of the module-global randomDelay.
 *   - the debug screenshot path uses logger.SCREENSHOT_DIR (an absolute,
 *     pre-created path) instead of a __dirname-relative join, so it stays
 *     correct now that this code lives under fb/.
 *   - extractUserIdFromProfileUrl comes from core/state.js.
 *
 * Account fields read here are the legacy camelCase shape (targetPageUrl,
 * ownProfileUrl, name) which worker/loadConfig.js preserves on the hydrated
 * account object.
 */

const path = require('path');
const logger = require('../logger.js');
const { extractUserIdFromProfileUrl } = require('../core/state.js');

/**
 * True if `href` is a POST permalink (not a comment link). Mirrors the strict
 * filter proven in getLatestProfilePost — comment links carry comment_id= and are
 * excluded so a comment's timestamp link on some post is never mistaken for the
 * post itself.
 * @param {string} href absolute URL
 * @returns {boolean}
 */
function isPostLink(href) {
  return (
    !!href &&
    !href.includes('comment_id=') &&
    (href.includes('/posts/') ||
      href.includes('story_fbid=') ||
      href.includes('/permalink/') ||
      href.includes('permalink.php'))
  );
}

/**
 * Pure selection: given the anchor hrefs of each feed article in TOP-DOWN order,
 * return the newest post's permalink — the first post-like link in the first
 * article that has one.
 *
 * Why this exists (regression): the old code scrolled ~5400px into the feed and
 * then took the FIRST post link across the WHOLE document (`unique[0]`). Facebook
 * VIRTUALIZES (unmounts) the top of the feed as you scroll, so `unique[0]` became
 * whatever older post happened to remain mounted — non-deterministic (one page
 * returned three different "latest" ids across consecutive cycles). Selecting the
 * first article that exposes a permalink, read from the top WITHOUT scrolling past
 * it, is deterministic: it is always the topmost (newest) post.
 *
 * @param {Array<string[]>} articleHrefLists per-article anchor hrefs, feed order
 * @returns {string|null} the newest post permalink, or null if none found
 */
function chooseLatestPostHref(articleHrefLists) {
  for (const hrefs of articleHrefLists || []) {
    const found = (hrefs || []).find(isPostLink);
    if (found) return found;
  }
  return null;
}

/**
 * Find the latest post on the account's target page and return its id/url/text.
 * @param {import('playwright').Page} page
 * @param {object} account hydrated account (uses .name, .targetPageUrl)
 * @param {object} h humanizer ({ randomDelay })
 * @returns {Promise<{postId: string, postUrl: string, postText: string}>}
 * @throws if no post links are found (drives the retry wrapper)
 */
async function getLatestPost(page, account, h) {
  logger.log(account.name, 'MONITOR', `Checking: ${account.targetPageUrl}`);

  await page.goto(account.targetPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await h.randomDelay(4000, 7000);

  // Read the newest post from the TOP of the feed. We deliberately do NOT scroll
  // deep before reading: Facebook virtualizes (unmounts) the top posts as you
  // scroll down, so the old "scroll 5400px then take unique[0]" approach returned
  // a RANDOM still-mounted (older) post. The newest post is the first article and
  // is present on load — we just wait for it to render, then read top-down.
  try {
    await page.waitForSelector('[role="article"]', { timeout: 20000 });
  } catch {
    // No articles yet — the scan below still runs (and retries with a small nudge)
    // before failing, so a slow render does not strand us.
  }
  await h.randomDelay(1500, 2500);

  // Gather per-article anchor hrefs + text in feed order, plus a flat list of all
  // anchors as a last-resort fallback. All DOM reads happen in one evaluate.
  const readFeed = () =>
    page.evaluate(() => {
      const articles = Array.from(document.querySelectorAll('[role="article"]'));
      return {
        articleHrefLists: articles.map((art) =>
          Array.from(art.querySelectorAll('a[href]')).map((a) => a.href)
        ),
        articleTexts: articles.map((art) => (art.innerText || '').slice(0, 600)),
        allHrefs: Array.from(document.querySelectorAll('a[href]')).map((a) => a.href),
      };
    });

  let feed = await readFeed();
  let rawUrl = chooseLatestPostHref(feed.articleHrefLists);

  // Some layouts hydrate posts only after a small interaction. If nothing surfaced,
  // nudge ONCE and return to the very top (still never scrolling past the newest).
  if (!rawUrl) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await h.randomDelay(2000, 3000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await h.randomDelay(1000, 2000);
    feed = await readFeed();
    rawUrl = chooseLatestPostHref(feed.articleHrefLists);
  }

  // Last resort: scan ALL anchors (the old behavior) so a structural change never
  // regresses us to a hard "no post found".
  if (!rawUrl) rawUrl = chooseLatestPostHref([feed.allHrefs]);

  if (!rawUrl) {
    logger.warn(account.name, 'MONITOR', 'No post links found.');
    throw new Error('No post links found');
  }

  // Post text from the SAME article we took the link from (best-effort, ≤600 chars).
  let postText = '';
  const aIdx = feed.articleHrefLists.findIndex((hrefs) => (hrefs || []).includes(rawUrl));
  if (aIdx >= 0) postText = feed.articleTexts[aIdx] || '';

  // Extract post ID — handle pfbid encoded IDs too, with DOM attribute fallback
  const idMatch =
    rawUrl.match(/story_fbid=([^&]+)/) ||
    rawUrl.match(/\/posts\/([^/?&]+)/) ||
    rawUrl.match(/\/permalink\/(\d+)/) ||
    rawUrl.match(/set=pcb\.(\d+)/);

  let postId = idMatch ? idMatch[1] : null;

  // DOM attribute fallback if URL regex couldn't extract an ID
  if (!postId) {
    postId = await page.evaluate((url) => {
      const articles = Array.from(document.querySelectorAll('[role="article"]'));
      for (const article of articles) {
        const storyId = article.getAttribute('data-story-id') || article.getAttribute('data-ftid');
        if (storyId) return storyId;
      }
      return url; // last resort: use full URL as ID
    }, rawUrl);
  }

  // Always reconstruct as a clean permalink URL
  const profileId =
    new URL(account.targetPageUrl).searchParams.get('id') ||
    account.targetPageUrl.split('/').filter(Boolean).pop();
  const postUrl = `https://www.facebook.com/permalink.php?story_fbid=${postId}&id=${profileId}`;

  logger.log(account.name, 'MONITOR', `Latest post ID: ${postId} | URL: ${postUrl}`);
  return { postId, postUrl, postText };
}

/**
 * Find the URL of the latest post on a profile feed (used after a profile share
 * to capture the shared post's permalink for comment monitoring).
 * @param {import('playwright').Page} page
 * @param {string} profileUrl
 * @param {object} h humanizer ({ randomDelay })
 * @returns {Promise<string|null>}
 */
async function getLatestProfilePost(page, profileUrl, h) {
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await h.randomDelay(3000, 5000);

  // Reload to ensure the freshly shared post is visible at the top
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await h.randomDelay(3000, 5000);

  // Scroll just enough to get past the profile header/cover photo into the feed
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 600));
    await h.randomDelay(800, 1500);
  }

  // Find the first article in the feed (newest post) and grab its post link.
  // Exclude comment links (comment_id=) — those are timestamp links on old posts, not the shared post itself.
  const postUrl = await page.evaluate(() => {
    const articles = Array.from(document.querySelectorAll('[role="article"]'));
    for (const article of articles) {
      const links = Array.from(article.querySelectorAll('a[href]'));
      const found = links.find((a) => {
        const h2 = a.href;
        if (h2.includes('comment_id=')) return false;
        return (
          h2.includes('/posts/') ||
          h2.includes('story_fbid=') ||
          h2.includes('/permalink/') ||
          h2.includes('permalink.php')
        );
      });
      if (found) {
        // Strip tracking params, keep only story_fbid and id
        try {
          const u = new URL(found.href);
          const clean = new URL('https://www.facebook.com/permalink.php');
          if (u.searchParams.get('story_fbid'))
            clean.searchParams.set('story_fbid', u.searchParams.get('story_fbid'));
          if (u.searchParams.get('id')) clean.searchParams.set('id', u.searchParams.get('id'));
          return clean.toString();
        } catch {
          return found.href;
        }
      }
    }
    return null;
  });

  return postUrl || null;
}

/**
 * Find the latest post URL in a group feed.
 * @param {import('playwright').Page} page
 * @param {string} groupUrl
 * @param {object} h humanizer ({ randomDelay })
 * @returns {Promise<string|null>}
 */
async function getLatestPostInGroup(page, groupUrl, h) {
  await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await h.randomDelay(4000, 7000);

  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await h.randomDelay(1200, 2000);
  }

  const postUrl = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));

    // 1. Prioritize timestamp links: role="link" + group post pattern + outside message
    const timestampLink = anchors.find((a) => {
      const href = a.href;
      const isGroupPost = /\/groups\/[^/]+\/posts\//.test(href);
      const isRoleLink = a.getAttribute('role') === 'link';
      // Post links usually don't have too much query noise in the path itself,
      // but they DO have tracking params which we clean later.
      return (
        isGroupPost &&
        isRoleLink &&
        !href.includes('comment_id=') &&
        !a.closest('[data-ad-rendering-role="story_message"]')
      );
    });
    if (timestampLink) return timestampLink.href;

    // 2. Fallback: Any group post link outside message
    const groupPost = anchors.find((a) => {
      const href = a.href;
      return (
        /\/groups\/[^/]+\/posts\//.test(href) &&
        !href.includes('comment_id=') &&
        !a.closest('[data-ad-rendering-role="story_message"]')
      );
    });
    if (groupPost) return groupPost.href;

    // 3. Fallback to story_fbid or permalink links found outside the message content
    const fallback = anchors.find((a) => {
      const href = a.href;
      return (
        (/story_fbid=/.test(href) || /\/permalink\.php/.test(href)) &&
        !href.includes('comment_id=') &&
        !a.closest('[data-ad-rendering-role="story_message"]')
      );
    });
    return fallback ? fallback.href : null;
  });

  return postUrl || null;
}

/**
 * Find the account's OWN latest post inside a group (its "My posts" view),
 * resolving the permalink by clicking the timestamp when needed. Falls back to
 * the group feed if the user id can't be derived or nothing is found.
 * @param {import('playwright').Page} page
 * @param {string} groupUrl
 * @param {object} account hydrated account (uses .name, .ownProfileUrl)
 * @param {object} h humanizer ({ randomDelay })
 * @returns {Promise<string|null>}
 */
async function getLatestPostInGroupByUser(page, groupUrl, account, h) {
  const userId = extractUserIdFromProfileUrl(account);
  if (!userId) {
    logger.warn(account.name, 'SHARE', 'Cannot extract user ID from ownProfileUrl — falling back to group feed.');
    return getLatestPostInGroup(page, groupUrl, h);
  }

  // Navigate to "My posts" page inside the group: groupUrl/user/userId
  const myPostsUrl = groupUrl.replace(/\/$/, '') + '/user/' + userId + '/';
  logger.log(account.name, 'SHARE', `Checking own posts in group: ${myPostsUrl}`);

  await page.goto(myPostsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await h.randomDelay(3000, 5000);

  // Wait for feed content to appear (articles or feed container)
  try {
    await page.waitForSelector('[role="article"], [role="feed"]', { timeout: 15000 });
    logger.log(account.name, 'SHARE', 'Feed content detected on user page.');
  } catch {
    logger.warn(account.name, 'SHARE', 'No feed/article elements appeared within 15s.');
  }

  // Scan for /groups/.../posts/... links, checking after each scroll step.
  // Also look for the timestamp link to click if no direct post links appear.
  const scanForPostLinks = () =>
    page.evaluate(() => {
      // 1. Direct post permalink links anywhere on page (outside post body)
      const postLink = Array.from(document.querySelectorAll('a[href]')).find((a) => {
        const href = a.href;
        return (
          /\/groups\/[^/]+\/posts\/[^/?#]+/.test(href) &&
          !href.includes('comment_id=') &&
          !a.closest('[data-ad-rendering-role="story_message"]')
        );
      });
      if (postLink) return { type: 'url', value: postLink.href };

      // 2. Timestamp link to click (relative href with __cft__, outside post body/profile)
      const dateLink = Array.from(document.querySelectorAll('a[role="link"]')).find((a) => {
        const href = a.getAttribute('href') || '';
        return (
          href.startsWith('?') &&
          href.includes('__cft__') &&
          !a.closest('[data-ad-rendering-role="story_message"]') &&
          !a.closest('[data-ad-rendering-role="profile_name"]')
        );
      });
      if (dateLink) return { type: 'dateLink', value: dateLink.href };

      return null;
    });

  let dateLinkHref = null;
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollBy(0, 600));
    await h.randomDelay(1000, 1800);

    const found = await scanForPostLinks();
    if (!found) continue;
    if (found.type === 'url') return found.value.split('?')[0];
    if (found.type === 'dateLink') {
      dateLinkHref = found.value;
      break;
    }
  }

  // Click the timestamp — Facebook's SPA router updates the URL to the post permalink
  if (dateLinkHref) {
    logger.log(account.name, 'SHARE', 'Clicking post date to resolve permalink...');
    try {
      // Remove target="_blank" so the click navigates the current tab
      await page.evaluate((href) => {
        const link = Array.from(document.querySelectorAll('a[role="link"]')).find((a) => a.href === href);
        if (link) link.removeAttribute('target');
      }, dateLinkHref);

      const dateEl = await page.evaluateHandle(
        (href) => Array.from(document.querySelectorAll('a[role="link"]')).find((a) => a.href === href),
        dateLinkHref
      );

      await Promise.all([
        page.waitForURL((url) => /\/groups\/[^/]+\/posts\//.test(url), { timeout: 12000 }).catch(() => {}),
        dateEl.click(),
      ]);

      await h.randomDelay(1500, 2500);

      // After SPA navigation, scan for /posts/ links on the resulting page
      const urlNow = page.url();
      if (/\/groups\/[^/]+\/posts\//.test(urlNow)) {
        return urlNow.split('?')[0];
      }

      // Page URL didn't change to /posts/ — scan DOM for post links on this page
      const postLinkOnPage = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a[href]')).find(
          (a) => /\/groups\/[^/]+\/posts\/[^/?#]+/.test(a.href) && !a.href.includes('comment_id=')
        );
        return a?.href ?? null;
      });
      if (postLinkOnPage) return postLinkOnPage.split('?')[0];
    } catch (e) {
      logger.warn(account.name, 'SHARE', `Date click failed: ${e.message}`);
    }
  }

  // Debug: Log all hrefs on the page to understand what's there
  const allHrefs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.href)
      .filter((h2) => h2.includes('/groups/') || h2.includes('story_fbid') || h2.includes('permalink'))
      .slice(0, 15);
  });
  logger.warn(account.name, 'SHARE', `Debug — relevant links on user page: ${JSON.stringify(allHrefs)}`);

  // Take screenshot for debugging
  try {
    const ssPath = path.join(logger.SCREENSHOT_DIR, `${account.name}_GROUP_USER_PAGE_${Date.now()}.png`);
    await page.screenshot({ path: ssPath, fullPage: false });
    logger.warn(account.name, 'SHARE', `Screenshot saved: ${ssPath}`);
  } catch {
    /* ignore screenshot errors */
  }

  logger.warn(account.name, 'SHARE', 'No posts found on user page — falling back to group feed.');
  return getLatestPostInGroup(page, groupUrl, h);
}

module.exports = {
  getLatestPost,
  getLatestProfilePost,
  getLatestPostInGroup,
  getLatestPostInGroupByUser,
  // Exported for unit testing the deterministic newest-post selection.
  chooseLatestPostHref,
  isPostLink,
};
