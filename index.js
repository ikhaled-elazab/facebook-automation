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

function addSharedPost(account, url) {
  if (!url) return;
  const existing = readSharedPosts(account);
  if (!existing.includes(url)) {
    writeSharedPosts(account, [...existing, url]);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────

async function withRetry(fn, page, account, actionName, maxAttempts = 3, delayMs = 3000) {
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

  // Find the first article in the feed (newest post) and grab its post link
  const postUrl = await page.evaluate(() => {
    const articles = Array.from(document.querySelectorAll('[role="article"]'));
    for (const article of articles) {
      const links = Array.from(article.querySelectorAll('a[href]'));
      const found = links.find((a) =>
        a.href.includes('/posts/') ||
        a.href.includes('story_fbid=') ||
        a.href.includes('/permalink/') ||
        a.href.includes('permalink.php')
      );
      if (found) return found.href;
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
    const found = anchors.find((a) => {
      const h = a.href;
      return (
        (/\/groups\/[^/]+\/posts\//.test(h) || /story_fbid=/.test(h)) &&
        !h.includes('comment_id=')
      );
    });
    return found ? found.href : null;
  });

  return postUrl || null;
}

async function likePost(page, postUrl, account) {
  logger.log(account.name, 'LIKE', 'Navigating to post...');

  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await randomDelay(4000, 8000);

  // Skip if already liked (button would show "Unlike")
  const alreadyLiked = await page.$('[aria-label="Unlike"], [aria-label="إلغاء الإعجاب"]');
  if (alreadyLiked) {
    logger.log(account.name, 'LIKE', 'Post already liked, skipping.');
    return;
  }

  // Target the post-level Like button specifically via data-ad-rendering-role
  const selectors = [
    'div[role="button"]:has([data-ad-rendering-role="like_button"])',
    '[aria-label="Like"][role="button"]',
    '[aria-label="أعجبني"][role="button"]',
  ];

  let clicked = false;
  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.scrollIntoViewIfNeeded();
      await randomDelay(1000, 2000);
      const box = await btn.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await btn.click();
      }
      await randomDelay(1000, 2000);
      clicked = true;
      logger.log(account.name, 'LIKE', '✓ Post liked.');
      break;
    }
  }

  if (!clicked) {
    logger.warn(account.name, 'LIKE', 'Like button not found.');
    throw new Error('Like button not found');
  }
}

async function commentOnPost(page, postUrl, postText, account) {
  const comment = await generateComment(postText, account);
  if (!comment) {
    logger.warn(account.name, 'COMMENT', 'Generated comment is empty, skipping.');
    return;
  }
  logger.log(account.name, 'COMMENT', `Posting: "${comment}"`);

  await randomDelay();

  // Click the "Leave a comment" button to activate the composer
  for (const sel of [
    '[aria-label="Leave a comment"]',
    '[aria-label="Comment"]',
    '[aria-label="كتابة تعليق"]',
    'div[role="button"]:has([data-ad-rendering-role="comment_button"])',
    'div[role="button"]:has-text("Comment")',
  ]) {
    const btn = await page.$(sel);
    if (btn) { await btn.click({ force: true }); break; }
  }

  await randomDelay(2000, 4000);

  const commentBox = await page.waitForSelector(
    '[aria-label="Write a comment…"], [aria-label="Write a public comment…"], div[contenteditable="true"][role="textbox"]',
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

  let shareBtn = null;
  for (const sel of [
    '[aria-label="Send this to friends or post it on your profile."]',
    '[aria-label="Share"]',
    'div[role="button"]:has([data-ad-rendering-role="share_button"])',
    'div[role="button"]:has-text("Share")',
    '[aria-label="يمكنك إرسال هذا إلى الأصدقاء أو نشره على ملفك الشخصي."]',
  ]) {
    shareBtn = await page.$(sel);
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
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await shareBtn.click();
  }

  await sleep(2000);

  const profileOption = await page.waitForSelector(
    '[aria-label="Share now"]',
    { timeout: 10000, state: 'visible' }
  ).catch(() => null);

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

      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await randomDelay(3000, 6000);

      let shareBtn = null;
      for (const sel of [
        '[aria-label="Send this to friends or post it on your profile."]',
        '[aria-label="Share"]',
        'div[role="button"]:has([data-ad-rendering-role="share_button"])',
        'div[role="button"]:has-text("Share")',
        '[aria-label="يمكنك إرسال هذا إلى الأصدقاء أو نشره على ملفك الشخصي."]',
      ]) {
        shareBtn = await page.$(sel);
        if (shareBtn) break;
      }

      if (!shareBtn) {
        logger.warn(account.name, 'SHARE', `Share button not found, skipping group: ${groupUrl}`);
        continue;
      }

      await shareBtn.scrollIntoViewIfNeeded();
      await randomDelay(800, 1500);

      const boxG = await shareBtn.boundingBox();
      if (boxG) {
        await page.mouse.click(boxG.x + boxG.width / 2, boxG.y + boxG.height / 2);
      } else {
        await shareBtn.click();
      }

      const groupListItem = await page.waitForSelector(
        'div[role="listitem"]:has-text("Group"), div[role="listitem"]:has-text("مجموعة")',
        { timeout: 10000, state: 'visible' }
      ).catch(() => null);

      if (!groupListItem) {
        logger.warn(account.name, 'SHARE', `"Group" option not found in dialog. Using direct fallback...`);
        await page.keyboard.press('Escape');
        await randomDelay(1000, 2000);
        await shareDirectlyToGroup(page, postUrl, groupUrl, account);
        continue;
      }

      const groupOption = await groupListItem.$('div[role="button"]') || groupListItem;

      await groupOption.click();
      await randomDelay(2000, 4000);

      const groupId = groupUrl.replace(/\/$/, '').split('/').pop();
      const searchBox = await page
        .waitForSelector('input[placeholder*="group"], input[placeholder*="Group"], input[type="search"]', { timeout: 10000 })
        .catch(() => null);

      if (searchBox) {
        await searchBox.type(groupId, { delay: randInt(80, 150) });
        await randomDelay(2000, 3000);
        const suggestion = await page.$('div[role="option"], li[role="option"]');
        if (suggestion) { await suggestion.click(); await randomDelay(1500, 3000); }
      }

      let posted = false;
      for (const sel of [
        'div[aria-label="Post"]:has-text("Post")',
        'button:has-text("Post")',
        'div[role="button"]:has-text("Post")',
      ]) {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          logger.log(account.name, 'SHARE', `✓ Shared to: ${groupUrl}`);
          posted = true;
          break;
        }
      }

      await randomDelay(3000, 6000);

      if (posted) {
        try {
          const groupPostUrl = await getLatestPostInGroup(page, groupUrl);
          if (groupPostUrl) {
            addSharedPost(account, groupPostUrl);
            logger.log(account.name, 'SHARE', `Tracking group post: ${groupPostUrl}`);
          }
        } catch (captureErr) {
          logger.warn(account.name, 'SHARE', `Could not capture group share URL: ${captureErr.message}`);
        }
      }
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
        const groupPostUrl = await getLatestPostInGroup(page, groupUrl);
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

    await withRetry(() => likePost(page, postUrl, account),                page, account, 'LIKE');
    await withRetry(() => commentOnPost(page, postUrl, postText, account), page, account, 'COMMENT');
    await withRetry(() => shareToOwnProfile(page, postUrl, account),       page, account, 'SHARE');
    await withRetry(() => shareToGroups(page, postUrl, account),           page, account, 'SHARE-GROUPS');

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
