/**
 * index.js — Multi-Account Facebook Page Monitor Bot
 *
 * Loads all accounts from accounts.json and runs each one in parallel
 * inside its own isolated browser context. Accounts are staggered on
 * startup (configurable via config.accountStaggerMs) to avoid hitting
 * Facebook simultaneously.
 *
 * Usage: npm start
 */

'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

const config = require('./config.json');
const accounts = require('./accounts.json');
const logger = require('./logger.js');
const { generateComment, generateReply } = require('./ai.js');
const { aiAct } = config.useVision ? require('./vision.js') : { aiAct: null };

chromium.use(StealthPlugin());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDelay(minMs = config.delays.minActionMs, maxMs = config.delays.maxActionMs) {
  const ms = randInt(minMs, maxMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickRandom(arr) {
  return arr[randInt(0, arr.length - 1)];
}

function tag(name) {
  return `[${name.toUpperCase()}]`;
}

function readLastPostId(account) {
  const filePath = path.resolve(account.lastPostFile);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8').trim() || null;
}

function writeLastPostId(account, id) {
  const filePath = path.resolve(account.lastPostFile);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, id, 'utf8');
}

function sharedPostsFile(account) {
  return path.resolve(`state/${account.name}_shared_posts.json`);
}

function readSharedPosts(account) {
  const filePath = sharedPostsFile(account);
  if (!fs.existsSync(filePath)) return [];
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return []; }
}

function writeSharedPosts(account, urls) {
  const filePath = sharedPostsFile(account);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(urls, null, 2), 'utf8');
}

function postHash(postUrl) {
  return Buffer.from(postUrl).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(-12);
}

function seenCommentsFile(account, postUrl) {
  return path.resolve(`state/${account.name}_seen_comments_${postHash(postUrl)}.json`);
}

function readSeenComments(account, postUrl) {
  const filePath = seenCommentsFile(account, postUrl);
  if (!fs.existsSync(filePath)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(filePath, 'utf8'))); } catch { return new Set(); }
}

function writeSeenComments(account, postUrl, seenSet) {
  const filePath = seenCommentsFile(account, postUrl);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify([...seenSet], null, 2), 'utf8');
}

function cleanFbUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    // Remove Facebook tracking / session params
    ['__cft__', '__tn__', '__xts__', 'ref', 'refid', 'fref', 'hc_ref', 'source'].forEach((p) => u.searchParams.delete(p));
    // Also remove any bracket-suffixed cft params like __cft__[0]
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith('__cft__') || key.startsWith('__tn__')) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return url;
  }
}

function addSharedPost(account, url) {
  if (!url) return;
  const clean = cleanFbUrl(url);
  const existing = readSharedPosts(account);
  if (!existing.includes(clean)) {
    writeSharedPosts(account, [...existing, clean]);
  }
}

function extractUserIdFromProfileUrl(account) {
  if (!account.ownProfileUrl) return null;
  try {
    const url = new URL(account.ownProfileUrl);
    // profile.php?id=123456 format
    const idParam = url.searchParams.get('id');
    if (idParam) return idParam;
    // facebook.com/username format — return the last path segment
    return url.pathname.split('/').filter(Boolean).pop() || null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────

async function withRetry(fn, page, account, actionName, maxAttempts = 3, delayMs = 3000, visionGoal) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      logger.warn(account.name, actionName, `Attempt ${attempt}/${maxAttempts} failed: ${err.message}`);

      if (config.screenshotOnError && page) {
        try {
          const ts = Date.now();
          const screenshotPath = path.join(
            logger.SCREENSHOT_DIR,
            `${account.name}_${actionName}_${ts}.png`
          );
          await page.screenshot({ path: screenshotPath, fullPage: false });
          logger.warn(account.name, actionName, `Screenshot saved: ${screenshotPath}`);
        } catch {
          // ignore screenshot errors
        }
      }

      if (attempt === maxAttempts && config.useVision && visionGoal && aiAct) {
        logger.log(account.name, actionName, 'Hardcoded selectors exhausted — trying vision fallback...');
        const ok = await aiAct(page, visionGoal, account).catch((e) => {
          logger.warn(account.name, actionName, `Vision fallback threw: ${e.message}`);
          return false;
        });
        if (ok) { logger.log(account.name, actionName, 'Vision fallback succeeded.'); return true; }
        logger.warn(account.name, actionName, 'Vision fallback also failed.');
      }

      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }
  return undefined;
}

// ─── Per-account bot logic ────────────────────────────────────────────────────

async function getLatestPost(page, account) {
  logger.log(account.name, 'MONITOR', `Checking: ${account.targetPageUrl}`);

  await page.goto(account.targetPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await randomDelay(4000, 7000);

  // Scroll past header/photos into the posts feed
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, 900));
    await randomDelay(1500, 2500);
  }

  const postLinks = await page.$$eval('a[href]', (anchors) =>
    anchors
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
      )
  );

  if (!postLinks.length) {
    logger.warn(account.name, 'MONITOR', 'No post links found.');
    throw new Error('No post links found');
  }

  const unique = [...new Set(postLinks)];
  const rawUrl = unique[0];

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

  // Extract visible post text from first article (capped at 600 chars)
  const postText = await page.evaluate(() => {
    const article = document.querySelector('[role="article"]');
    return article ? (article.innerText || '').slice(0, 600) : '';
  });

  // Always reconstruct as a clean permalink URL
  const profileId = new URL(account.targetPageUrl).searchParams.get('id') ||
    account.targetPageUrl.split('/').filter(Boolean).pop();
  const postUrl = `https://www.facebook.com/permalink.php?story_fbid=${postId}&id=${profileId}`;

  logger.log(account.name, 'MONITOR', `Latest post ID: ${postId} | URL: ${postUrl}`);
  return { postId, postUrl, postText };
}

async function getLatestProfilePost(page, profileUrl) {
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await randomDelay(3000, 5000);

  // Reload to ensure the freshly shared post is visible at the top
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await randomDelay(3000, 5000);

  // Scroll just enough to get past the profile header/cover photo into the feed
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 600));
    await randomDelay(800, 1500);
  }

  // Find the first article in the feed (newest post) and grab its post link.
  // Exclude comment links (comment_id=) — those are timestamp links on old posts, not the shared post itself.
  const postUrl = await page.evaluate(() => {
    const articles = Array.from(document.querySelectorAll('[role="article"]'));
    for (const article of articles) {
      const links = Array.from(article.querySelectorAll('a[href]'));
      const found = links.find((a) => {
        const h = a.href;
        if (h.includes('comment_id=')) return false;
        return (
          h.includes('/posts/') ||
          h.includes('story_fbid=') ||
          h.includes('/permalink/') ||
          h.includes('permalink.php')
        );
      });
      if (found) {
        // Strip tracking params, keep only story_fbid and id
        try {
          const u = new URL(found.href);
          const clean = new URL('https://www.facebook.com/permalink.php');
          if (u.searchParams.get('story_fbid')) clean.searchParams.set('story_fbid', u.searchParams.get('story_fbid'));
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

async function getLatestPostInGroup(page, groupUrl) {
  await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await randomDelay(4000, 7000);

  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await randomDelay(1200, 2000);
  }

  const postUrl = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    
    // 1. Prioritize timestamp links: role="link" + group post pattern + outside message
    const timestampLink = anchors.find((a) => {
      const h = a.href;
      const isGroupPost = /\/groups\/[^/]+\/posts\//.test(h);
      const isRoleLink = a.getAttribute('role') === 'link';
      // Post links usually don't have too much query noise in the path itself, 
      // but they DO have tracking params which we clean later.
      return isGroupPost && isRoleLink && !h.includes('comment_id=') && !a.closest('[data-ad-rendering-role="story_message"]');
    });
    if (timestampLink) return timestampLink.href;

    // 2. Fallback: Any group post link outside message
    const groupPost = anchors.find((a) => {
      const h = a.href;
      return /\/groups\/[^/]+\/posts\//.test(h) && !h.includes('comment_id=') && !a.closest('[data-ad-rendering-role="story_message"]');
    });
    if (groupPost) return groupPost.href;

    // 3. Fallback to story_fbid or permalink links found outside the message content
    const fallback = anchors.find((a) => {
      const h = a.href;
      return (/story_fbid=/.test(h) || /\/permalink\.php/.test(h)) && 
             !h.includes('comment_id=') && 
             !a.closest('[data-ad-rendering-role="story_message"]');
    });
    return fallback ? fallback.href : null;
  });

  return postUrl || null;
}

async function getLatestPostInGroupByUser(page, groupUrl, account) {
  const userId = extractUserIdFromProfileUrl(account);
  if (!userId) {
    logger.warn(account.name, 'SHARE', 'Cannot extract user ID from ownProfileUrl — falling back to group feed.');
    return getLatestPostInGroup(page, groupUrl);
  }

  // Navigate to "My posts" page inside the group: groupUrl/user/userId
  const myPostsUrl = groupUrl.replace(/\/$/, '') + '/user/' + userId + '/';
  logger.log(account.name, 'SHARE', `Checking own posts in group: ${myPostsUrl}`);

  await page.goto(myPostsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await randomDelay(3000, 5000);

  // Wait for feed content to appear (articles or feed container)
  try {
    await page.waitForSelector('[role="article"], [role="feed"]', { timeout: 15000 });
    logger.log(account.name, 'SHARE', 'Feed content detected on user page.');
  } catch {
    logger.warn(account.name, 'SHARE', 'No feed/article elements appeared within 15s.');
  }

  // Scroll more to ensure posts load
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, 600));
    await randomDelay(1000, 1800);
  }

  // Scroll back up to see the first/latest post
  await page.evaluate(() => window.scrollTo(0, 0));
  await randomDelay(1500, 2500);

  const postUrl = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    
    // 1. Prioritize timestamp links: role="link" + group post pattern + outside message
    const timestampLink = anchors.find((a) => {
      const h = a.href;
      const isGroupPost = /\/groups\/[^/]+\/posts\//.test(h) || h.includes('multi_permalinks=');
      const isRoleLink = a.getAttribute('role') === 'link';
      return isGroupPost && isRoleLink && !h.includes('comment_id=') && !a.closest('[data-ad-rendering-role="story_message"]');
    });
    if (timestampLink) return timestampLink.href;

    // 2. Fallback: Any group post link outside message
    const groupPost = anchors.find((a) => {
      const h = a.href;
      const isGroupPost = /\/groups\/[^/]+\/posts\//.test(h) || h.includes('multi_permalinks=');
      return isGroupPost && !h.includes('comment_id=') && !a.closest('[data-ad-rendering-role="story_message"]');
    });
    if (groupPost) return groupPost.href;

    // 3. Fallback to story_fbid or permalink links found outside the message content
    const fallback = anchors.find((a) => {
      const h = a.href;
      return (/story_fbid=/.test(h) || /\/permalink\.php/.test(h)) && 
             !h.includes('comment_id=') && 
             !a.closest('[data-ad-rendering-role="story_message"]');
    });
    return fallback ? fallback.href : null;
  });

  if (postUrl) return postUrl;

  // Debug: Log all hrefs on the page to understand what's there
  const allHrefs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(h => h.includes('/groups/') || h.includes('story_fbid') || h.includes('permalink'))
      .slice(0, 15);
  });
  logger.warn(account.name, 'SHARE', `Debug — relevant links on user page: ${JSON.stringify(allHrefs)}`);

  // Take screenshot for debugging
  try {
    const ssPath = path.join(__dirname, 'logs', 'screenshots', `${account.name}_GROUP_USER_PAGE_${Date.now()}.png`);
    await page.screenshot({ path: ssPath, fullPage: false });
    logger.warn(account.name, 'SHARE', `Screenshot saved: ${ssPath}`);
  } catch {}

  logger.warn(account.name, 'SHARE', 'No posts found on user page — falling back to group feed.');
  return getLatestPostInGroup(page, groupUrl);
}

async function likePost(page, postUrl, account) {
  logger.log(account.name, 'LIKE', 'Navigating to post...');

  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await randomDelay(4000, 8000);

  // Wait for the dialog/modal to open
  const dialogSelectors = [
    '[role="dialog"]',
    'div[class] > div[class] > div[class]:has(> div[aria-label="Close"])',
  ];

  let dialog = null;
  for (const sel of dialogSelectors) {
    dialog = await page.waitForSelector(sel, { timeout: 5000, state: 'visible' }).catch(() => null);
    if (dialog) {
      logger.log(account.name, 'LIKE', `Dialog found with selector: ${sel}`);
      break;
    }
  }

  if (!dialog) {
    logger.warn(account.name, 'LIKE', 'Dialog did not open, trying page-level search...');
  }

  // JS-scroll the inner scrollable container of the dialog.
  // mouse.wheel doesn't reach inner scrollable divs — must use scrollTop directly.
  await page.evaluate(() => {
    // Find the deepest scrollable element inside the dialog
    const dlg = document.querySelector('[role="dialog"]')
      || document.querySelector('[aria-label="Close"]')?.closest('div[class]');
    if (!dlg) { window.scrollBy(0, 2000); return; }

    // Walk all descendants and scroll any that have overflow
    let scrolled = false;
    const all = Array.from(dlg.querySelectorAll('*')).reverse(); // innermost first
    for (const el of all) {
      if (el.scrollHeight > el.clientHeight + 10) {
        el.scrollTop = el.scrollHeight; // scroll all the way down
        scrolled = true;
        break; // only the first/deepest scrollable
      }
    }
    if (!scrolled) dlg.scrollTop = dlg.scrollHeight;
  });
  await randomDelay(1500, 2500);

  const scope = dialog || page;

  // Check if the post is already liked
  // The user provided the exact HTML snippet: the "Remove Like" button is a [role="button"] 
  // that CONTAINS a div with data-ad-rendering-role="like_button".
  const isAlreadyLiked = await scope.evaluate((node) => {
    const root = node || document;
    
    // 1. Primary approach: Find the main post like button structure
    const marker = root.querySelector('[data-ad-rendering-role="like_button"]');
    if (marker) {
      const btn = marker.closest('[role="button"]');
      if (btn) {
        const label = (btn.getAttribute('aria-label') || '').trim();
        // If the main action button says "Remove Like" or "Unlike", it's already liked.
        if (label === 'Unlike' || label === 'Remove Like' || label === 'إلغاء الإعجاب') {
          return true;
        }
      }
    }
    
    // 2. Fallback: looking for Unlike strings
    const unlikes = Array.from(root.querySelectorAll('[aria-label="Unlike"], [aria-label="Remove Like"], [aria-label="إلغاء الإعجاب"]'));
    for (const btn of unlikes) {
      // Ensure we don't accidentally grab a comment's Unlike button (which are usually in lists/ul)
      const inCommentList = btn.closest('ul');
      if (!inCommentList) return true;
    }
    return false;
  }).catch(() => false);

  if (isAlreadyLiked) {
    logger.log(account.name, 'LIKE', 'Post already liked, skipping.');
    return;
  }

  // Find the actually Like button to click
  let likeBtn = await scope.evaluateHandle((node) => {
    const root = node || document;
    
    // 1. Primary approach: locate via data-ad-rendering-role marker and find its closest button
    const marker = root.querySelector('[data-ad-rendering-role="like_button"]');
    if (marker) {
      const btn = marker.closest('[role="button"]');
      if (btn) return btn;
    }

    // 2. Fallback: search by exact aria-label, ignoring reaction counts and lists
    const likes = Array.from(root.querySelectorAll('[aria-label="Like"], [aria-label="أعجبني"]'));
    for (const btn of likes) {
      const label = (btn.getAttribute('aria-label') || '').trim();
      if (/^Like$|^أعجبني$/.test(label)) {
        if (!btn.closest('ul')) {
          return btn;
        }
      }
    }
    return null;
  }).catch(() => null);

  const isLikeBtnValid = likeBtn && (await likeBtn.evaluate(el => el !== null).catch(() => false));

  if (!isLikeBtnValid) {
    logger.warn(account.name, 'LIKE', 'Like button not found.');
    throw new Error('Like button not found');
  }

  // Human-like: scroll button into view, move mouse, then click
  await likeBtn.scrollIntoViewIfNeeded();
  await randomDelay(500, 1000);

  const btnBox = await likeBtn.boundingBox();
  if (btnBox) {
    const bx = btnBox.x + btnBox.width / 2 + randInt(-3, 3);
    const by = btnBox.y + btnBox.height / 2 + randInt(-2, 2);
    await page.mouse.move(bx, by, { steps: randInt(8, 20) });
    await randomDelay(300, 800);
    await page.mouse.click(bx, by);
  } else {
    await likeBtn.dispatchEvent('click');
  }

  await randomDelay(1500, 3000);
  logger.log(account.name, 'LIKE', '✓ Post liked.');
}

async function commentOnPost(page, postUrl, postText, account) {
  const comment = await generateComment(postText, account);
  if (!comment) {
    logger.warn(account.name, 'COMMENT', 'Generated comment is empty, skipping.');
    return;
  }
  logger.log(account.name, 'COMMENT', `Posting: "${comment}"`);

  await randomDelay();

  // The post is open as a dialog — scope all selectors inside it
  const dialog = await page.waitForSelector('[role="dialog"]', { timeout: 15000, state: 'visible' }).catch(() => null);
  if (!dialog) {
    logger.warn(account.name, 'COMMENT', 'Dialog not found, cannot comment.');
    throw new Error('Post dialog not found for commenting');
  }

  // Click the "Leave a comment" button to activate the composer — scoped to dialog
  for (const sel of [
    '[aria-label="Leave a comment"]',
    '[aria-label="Comment"]',
    '[aria-label="كتابة تعليق"]',
    'div[role="button"]:has([data-ad-rendering-role="comment_button"])',
  ]) {
    const btn = await dialog.$(sel);
    if (btn) { await btn.dispatchEvent('click'); break; }
  }

  await randomDelay(2000, 4000);

  const commentBox = await page.waitForSelector(
    '[role="dialog"] [aria-label="Write a comment…"], [role="dialog"] [aria-label="Write a public comment…"], [role="dialog"] div[contenteditable="true"][role="textbox"]',
    { timeout: 15000, state: 'visible' }
  );

  await commentBox.scrollIntoViewIfNeeded();
  await randomDelay(500, 1000);
  await commentBox.focus();
  await randomDelay(500, 1000);

  for (const char of comment) {
    await page.keyboard.type(char);
    await sleep(randInt(config.delays.minTypingMs, config.delays.maxTypingMs));
  }

  await randomDelay(1500, 3000);
  await page.keyboard.press('Enter');
  await randomDelay(1000, 2000);
  logger.log(account.name, 'COMMENT', '✓ Comment posted.');
}

async function shareToOwnProfile(page, postUrl, account) {
  logger.log(account.name, 'SHARE', 'Sharing to own profile...');

  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await randomDelay(3000, 6000);

  // Wait for the dialog/modal to open
  const dialogSelectors = [
    '[role="dialog"]',
    'div[class] > div[class] > div[class]:has(> div[aria-label="Close"])',
  ];

  let dialog = null;
  for (const sel of dialogSelectors) {
    dialog = await page.waitForSelector(sel, { timeout: 5000, state: 'visible' }).catch(() => null);
    if (dialog) break;
  }

  const scope = dialog || page;

  let shareBtn = null;
  for (const sel of [
    '[aria-label="Send this to friends or post it on your profile."]',
    '[aria-label="Share"]',
    'div[role="button"]:has([data-ad-rendering-role="share_button"])',
    'div[role="button"]:has-text("Share")',
    '[aria-label="يمكنك إرسال هذا إلى الأصدقاء أو نشره على ملفك الشخصي."]',
  ]) {
    shareBtn = await scope.$(sel);
    if (shareBtn) break;
  }

  if (!shareBtn) {
    logger.warn(account.name, 'SHARE', 'Share button not found, skipping profile share.');
    throw new Error('Share button not found');
  }

  await shareBtn.scrollIntoViewIfNeeded();
  await randomDelay(800, 1500);

  const box = await shareBtn.boundingBox();
  if (box) {
    // Human-like: move mouse to Share button then click
    const sx = box.x + box.width / 2 + randInt(-3, 3);
    const sy = box.y + box.height / 2 + randInt(-2, 2);
    await page.mouse.move(sx, sy, { steps: randInt(6, 15) });
    await randomDelay(400, 800);
    await page.mouse.click(sx, sy);
  } else {
    await shareBtn.click();
  }

  await sleep(3000);

  // "Share now" button — try multiple selectors & text variants
  let profileOption = null;
  for (const sel of [
    '[aria-label="Share now"]',
    '[aria-label="Share Now"]',
    'div[role="menuitem"]:has-text("Share now")',
    'div[role="option"]:has-text("Share now")',
    'div[role="button"]:has-text("Share now")',
    'span:has-text("Share now")',
  ]) {
    profileOption = await page.waitForSelector(sel, { timeout: 5000, state: 'visible' }).catch(() => null);
    if (profileOption) break;
  }

  if (!profileOption) {
    logger.warn(account.name, 'SHARE', '"Share now" button not found in dialog, skipping profile share.');
    await page.keyboard.press('Escape');
    throw new Error('"Share now" button not found');
  }

  await randomDelay(1000, 2000);
  await profileOption.click();
  await randomDelay(6000, 10000);
  logger.log(account.name, 'SHARE', '✓ Shared to own profile.');

  // Capture the shared post URL for comment monitoring
  if (account.ownProfileUrl) {
    try {
      const sharedPostUrl = await getLatestProfilePost(page, account.ownProfileUrl);
      if (sharedPostUrl) {
        addSharedPost(account, sharedPostUrl);
        logger.log(account.name, 'SHARE', `Tracking profile post: ${sharedPostUrl}`);
      }
    } catch (captureErr) {
      logger.warn(account.name, 'SHARE', `Could not capture profile share URL: ${captureErr.message}`);
    }
  }
}

async function shareToGroups(page, postUrl, account) {
  logger.log(account.name, 'SHARE', `Sharing to ${account.groups.length} group(s)...`);

  for (const groupUrl of account.groups) {
    try {
      logger.log(account.name, 'SHARE', `→ ${groupUrl}`);
      await randomDelay();

      // Always post the link directly to the group wall
      await shareDirectlyToGroup(page, postUrl, groupUrl, account);
    } catch (err) {
      logger.logError(account.name, 'SHARE', err);
    }
  }
}

async function shareDirectlyToGroup(page, postUrl, groupUrl, account) {
  try {
    logger.log(account.name, 'SHARE-FALLBACK', `Posting link to group wall: ${groupUrl}`);
    await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(3000, 6000);

    await page.evaluate(() => window.scrollBy(0, 400));
    await randomDelay(1000, 2000);

    let composer = null;
    for (const sel of [
      '[aria-label="Write something to the group…"]',
      '[placeholder="Write something to the group…"]',
      'div[role="button"]:has-text("Write something")',
      'div[role="button"]:has-text("What\'s on your mind")',
      '[data-pagelet="GroupComposer"] [role="button"]',
      '[aria-label*="group"] [role="button"]',
      '[aria-label*="Group"] [role="button"]',
      'div[contenteditable="true"][role="textbox"]',
    ]) {
      composer = await page.$(sel);
      if (composer) break;
    }

    if (!composer) {
      await randomDelay(3000, 5000);
      await page.evaluate(() => window.scrollBy(0, 300));
      for (const sel of [
        '[aria-label="Write something to the group…"]',
        'div[role="button"]:has-text("Write something")',
        'div[contenteditable="true"][role="textbox"]',
      ]) {
        composer = await page.$(sel);
        if (composer) break;
      }
    }

    if (!composer) {
      logger.warn(account.name, 'SHARE-FALLBACK', `Composer not found in: ${groupUrl}`);
      return;
    }

    await composer.click();
    await randomDelay(2000, 3000);

    const textBox = await page.waitForSelector(
      'div[contenteditable="true"][role="textbox"], [aria-label="Write something to the group…"]',
      { timeout: 12000 }
    ).catch(() => null);

    if (!textBox) {
      logger.warn(account.name, 'SHARE-FALLBACK', `Text box did not appear in: ${groupUrl}`);
      return;
    }

    for (const char of postUrl) {
      await page.keyboard.type(char);
      await sleep(randInt(30, 80));
    }

    await randomDelay(2000, 4000);

    let posted = false;
    for (const sel of ['div[aria-label="Post"]:has-text("Post")', 'button:has-text("Post")']) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        logger.log(account.name, 'SHARE-FALLBACK', `✓ Posted link to: ${groupUrl}`);
        posted = true;
        break;
      }
    }

    await randomDelay(3000, 5000);

    if (posted) {
      try {
        const groupPostUrl = await getLatestPostInGroupByUser(page, groupUrl, account);
        if (groupPostUrl) {
          addSharedPost(account, groupPostUrl);
          logger.log(account.name, 'SHARE-FALLBACK', `Tracking group post: ${groupPostUrl}`);
        }
      } catch (captureErr) {
        logger.warn(account.name, 'SHARE-FALLBACK', `Could not capture group share URL: ${captureErr.message}`);
      }
    }
  } catch (err) {
    logger.logError(account.name, 'SHARE-FALLBACK', err);
  }
}

// ─── Comment monitoring ───────────────────────────────────────────────────────

async function monitorAndReplyToComments(page, account) {
  const sharedPosts = readSharedPosts(account);
  if (!sharedPosts.length) return;

  const replies = account.replies;
  if (!replies || !replies.length) {
    logger.warn(account.name, 'COMMENTS', 'No replies configured, skipping comment monitor.');
    return;
  }

  logger.log(account.name, 'COMMENTS', `Monitoring ${sharedPosts.length} shared post(s) for new comments...`);

  for (const postUrl of sharedPosts) {
    try {
      logger.log(account.name, 'COMMENTS', `Checking: ${postUrl}`);
      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await randomDelay(4000, 7000);

      // First scroll pass to load comments
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.scrollBy(0, 700));
        await randomDelay(1000, 2000);
      }

      // Click "View more comments" if available
      for (const sel of [
        'div[role="button"]:has-text("View more comments")',
        'span:has-text("View more comments")',
      ]) {
        const more = await page.$(sel);
        if (more) { await more.click(); await randomDelay(2000, 3000); break; }
      }

      // Second scroll pass after expanding comments
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, 700));
        await randomDelay(1000, 2000);
      }

      // Wait for at least one comment article to appear
      await page.waitForSelector('[role="article"][aria-label*="Comment by"]', { timeout: 5000 })
        .catch(() => logger.warn(account.name, 'COMMENTS', 'No comment articles appeared within timeout.'));

      const seenComments = readSeenComments(account, postUrl);
      let newCount = 0;

      const commentArticles = await page.$$('[role="article"][aria-label*="Comment by"]');

      if (!commentArticles.length) {
        logger.warn(account.name, 'COMMENTS', 'Zero comment articles found — possible selector drift.');
      } else {
        logger.log(account.name, 'COMMENTS', `Found ${commentArticles.length} comment(s) on post.`);
      }

      for (const article of commentArticles) {
        try {
          // Extract comment ID from timestamp link
          const timestampLink = await article.$('a[href*="comment_id="]');
          if (!timestampLink) continue;

          const href = await timestampLink.getAttribute('href');
          let commentId = null;
          try { commentId = new URL(href, 'https://www.facebook.com').searchParams.get('comment_id'); } catch { continue; }
          if (!commentId) continue;

          if (seenComments.has(commentId)) continue;

          logger.log(account.name, 'COMMENTS', `New comment ID: ${commentId}`);
          newCount++;

          // Like the comment
          try {
            const likeBtn = await article.$('[aria-label="Like"]');
            if (likeBtn) {
              await likeBtn.scrollIntoViewIfNeeded();
              await randomDelay(800, 1500);
              await likeBtn.click({ force: true });
              await randomDelay(1000, 2000);
              logger.log(account.name, 'COMMENTS', `✓ Liked comment ${commentId}`);
            }
          } catch (likeErr) {
            logger.warn(account.name, 'COMMENTS', `Could not like comment ${commentId}: ${likeErr.message}`);
          }

          // Reply to the comment
          try {
            const replyBtn = await article.$('[role="button"]:has-text("Reply")');
            if (replyBtn) {
              await replyBtn.scrollIntoViewIfNeeded();
              await randomDelay(800, 1500);
              await replyBtn.click({ force: true });
              await randomDelay(2000, 3500);

              const replyBox = await page.waitForSelector(
                'div[contenteditable="true"][role="textbox"]',
                { timeout: 10000, state: 'visible' }
              ).catch(() => null);

              if (replyBox) {
                await replyBox.scrollIntoViewIfNeeded();
                await replyBox.focus();
                await randomDelay(500, 1000);

                // Extract comment text for AI reply generation
                const commentText = (await article.evaluate((el) => el.innerText || '')).slice(0, 300);
                const reply = await generateReply(commentText, account);

                for (const char of reply) {
                  await page.keyboard.type(char);
                  await sleep(randInt(config.delays.minTypingMs, config.delays.maxTypingMs));
                }

                await randomDelay(1500, 3000);
                await page.keyboard.press('Enter');
                await randomDelay(2000, 3000);
                logger.log(account.name, 'COMMENTS', `✓ Replied to comment ${commentId}: "${reply}"`);
              }
            }
          } catch (replyErr) {
            logger.warn(account.name, 'COMMENTS', `Could not reply to comment ${commentId}: ${replyErr.message}`);
          }

          seenComments.add(commentId);
        } catch (articleErr) {
          logger.warn(account.name, 'COMMENTS', `Error processing comment article: ${articleErr.message}`);
        }
      }

      writeSeenComments(account, postUrl, seenComments);
      if (newCount > 0) {
        logger.log(account.name, 'COMMENTS', `✓ Acted on ${newCount} new comment(s) for post.`);
      } else {
        logger.log(account.name, 'COMMENTS', 'No new comments on this post.');
      }
    } catch (err) {
      logger.logError(account.name, 'COMMENTS', err);
    }
  }
}

// ─── Per-account check cycle ──────────────────────────────────────────────────

async function checkAndAct(page, account) {
  logger.log(account.name, 'CHECK', `─`.repeat(40));
  logger.log(account.name, 'CHECK', new Date().toLocaleString());

  try {
    const latest = await withRetry(() => getLatestPost(page, account), page, account, 'MONITOR', 3, 5000);
    if (!latest) { logger.warn(account.name, 'CHECK', 'Could not retrieve post after retries.'); return; }

    const { postId, postUrl, postText } = latest;
    const lastId = readLastPostId(account);

    if (lastId === postId) {
      logger.log(account.name, 'CHECK', `No new post. Last seen: ${lastId}`);
      return;
    }

    logger.log(account.name, 'CHECK', `*** NEW POST DETECTED *** (ID: ${postId})`);
    writeLastPostId(account, postId);

    // Pre-generate comment so vision goal string matches what will be typed
    const comment = await generateComment(postText, account);

    await withRetry(() => likePost(page, postUrl, account), page, account, 'LIKE', 3, 3000,
      'Find and click the Like button on this Facebook post. If the post already shows Unlike, the post is already liked — return done immediately.');

    await withRetry(() => commentOnPost(page, postUrl, postText, account), page, account, 'COMMENT', 3, 3000,
      comment
        ? `Find the comment input box and type exactly: "${comment}" — then press Enter to submit.`
        : 'Find the comment input box, type a short positive comment, then press Enter.');

    await sleep(3000);

    await withRetry(() => shareToOwnProfile(page, postUrl, account), page, account, 'SHARE', 3, 3000,
      'Click the Share button on this post. When the share dialog opens, click "Share now" to share to your own profile.');

    await withRetry(() => shareToGroups(page, postUrl, account), page, account, 'SHARE-GROUPS', 3, 3000,
      'Click the Share button on this post. In the dialog choose to share to a Group, select the target group, then click Post.');

    logger.log(account.name, 'CHECK', `✓ All actions done for post: ${postId}`);
  } catch (err) {
    logger.logError(account.name, 'CHECK', err);
  }
}

// ─── Per-account runner (runs indefinitely) ───────────────────────────────────

async function runAccount(browser, account) {
  const sessionPath = path.resolve(account.sessionFile);

  if (!fs.existsSync(sessionPath)) {
    logger.error(account.name, 'BOOT', `Session file not found: ${sessionPath}`);
    logger.error(account.name, 'BOOT', `Run: node login.js --account ${account.name}`);
    return;
  }

  logger.log(account.name, 'BOOT', `Starting with session: ${sessionPath}`);

  const contextOptions = {
    storageState: sessionPath,
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
    logger.log(account.name, 'BOOT', `Proxy: ${account.proxy.server}`);
  } else if (config.useProxy) {
    logger.warn(account.name, 'BOOT', 'useProxy=true but no proxy configured for this account — using VPS IP.');
  } else {
    logger.log(account.name, 'BOOT', 'Proxy disabled (useProxy=false in config.json).');
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const intervalMs = (account.checkIntervalMinutes || 7) * 60 * 1000;

  logger.log(account.name, 'BOOT', `Session started. Check interval: ${account.checkIntervalMinutes || 7}m`);

  try {
    // First check immediately, then on interval
    await checkAndAct(page, account);
    await monitorAndReplyToComments(page, account);

    // Use a loop with sleep instead of setInterval so checks never overlap
    while (true) {
      await sleep(intervalMs);
      await checkAndAct(page, account);
      await monitorAndReplyToComments(page, account);
    }
  } finally {
    logger.log(account.name, 'BOOT', 'Session loop ended.');
    await context.close().catch(() => {});
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!accounts.length) {
    logger.log(null, 'BOOT', 'No accounts found in accounts.json');
    process.exit(1);
  }

  logger.log(null, 'BOOT', `Loaded ${accounts.length} account(s): ${accounts.map((a) => a.name).join(', ')}`);
  logger.log(null, 'BOOT', `Stagger between accounts: ${config.accountStaggerMs / 1000}s`);

  const browser = await chromium.launch({
    headless: config.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  // Launch each account with a staggered delay so they don't all start at once
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];

    if (i > 0) {
      const stagger = config.accountStaggerMs;
      logger.log(null, 'BOOT', `Waiting ${stagger / 1000}s before starting ${account.name}...`);
      await sleep(stagger);
    }

    // runAccount loops forever — don't await it, just fire and continue
    runAccount(browser, account).catch((err) => {
      logger.logError(account.name, 'BOOT', err);
    });
  }

  logger.log(null, 'BOOT', 'All accounts launched. Bot is running.');
}

main().catch((err) => {
  logger.logError(null, 'FATAL', err);
  process.exit(1);
});
