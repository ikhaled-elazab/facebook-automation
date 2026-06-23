'use strict';

/**
 * fb/actions/share.js — share the post to own profile and to groups.
 *
 * Ports index.js shareToOwnProfile / shareToGroups / shareDirectlyToGroup.
 * Selector logic, scroll counts, and "Share now" flow preserved VERBATIM.
 * Changes:
 *   - humanization via injected humanizer `h` (h.randInt, h.randomDelay, h.sleep, h.typeText).
 *   - captured share URLs persisted via core/state.js addSharedPost (DB-backed).
 *   - latest-post discovery via fb/scrape.js (getLatestProfilePost / getLatestPostInGroupByUser),
 *     which now take the humanizer.
 * Account fields used: .name, .groups, .ownProfileUrl (legacy camelCase preserved by loadConfig).
 */

const logger = require('../../logger.js');
const { getActivePostScope } = require('../scope.js');
const { getLatestProfilePost, getLatestPostInGroupByUser } = require('../scrape.js');
const { addSharedPost } = require('../../core/state.js');

/**
 * Share the post to the account's own profile via the "Share now" flow, then
 * capture the resulting profile-post permalink for comment monitoring.
 * @param {import('playwright').Page} page
 * @param {string} postUrl
 * @param {object} account hydrated account (uses .name, .ownProfileUrl)
 * @param {object} h humanizer ({ randInt, randomDelay, sleep })
 * @returns {Promise<string|null>} the captured shared post URL, or null
 * @throws if the Share or "Share now" controls can't be found (drives retry)
 */
async function shareToOwnProfile(page, postUrl, account, h) {
  logger.log(account.name, 'SHARE', 'Sharing to own profile...');

  // If the post dialog is already open (e.g. we just commented), skip navigation.
  let dialog = await getActivePostScope(page);

  if (!dialog) {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await h.randomDelay(3000, 6000);
    dialog = await getActivePostScope(page);
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
  await h.randomDelay(800, 1500);

  const box = await shareBtn.boundingBox();
  if (box) {
    // Human-like: move mouse to Share button then click
    const sx = box.x + box.width / 2 + h.randInt(-3, 3);
    const sy = box.y + box.height / 2 + h.randInt(-2, 2);
    await page.mouse.move(sx, sy, { steps: h.randInt(6, 15) });
    await h.randomDelay(400, 800);
    await page.mouse.click(sx, sy);
  } else {
    await shareBtn.click();
  }

  await h.sleep(3000);

  // "Share now" button — try multiple selectors & text variants. Includes the
  // Arabic label "مشاركة الآن" (verified against the live share dialog) — the
  // account's FB UI renders in Arabic, so the English-only list never matched and
  // profile-share silently failed at this step.
  let profileOption = null;
  for (const sel of [
    '[aria-label="Share now"]',
    '[aria-label="Share Now"]',
    '[aria-label="مشاركة الآن"]',
    'div[role="menuitem"]:has-text("Share now")',
    'div[role="option"]:has-text("Share now")',
    'div[role="button"]:has-text("Share now")',
    'div[role="button"]:has-text("مشاركة الآن")',
    'span:has-text("Share now")',
    'span:has-text("مشاركة الآن")',
  ]) {
    profileOption = await page.waitForSelector(sel, { timeout: 5000, state: 'visible' }).catch(() => null);
    if (profileOption) break;
  }

  if (!profileOption) {
    logger.warn(account.name, 'SHARE', '"Share now" button not found in dialog, skipping profile share.');
    await page.keyboard.press('Escape');
    throw new Error('"Share now" button not found');
  }

  await h.randomDelay(1000, 2000);
  await profileOption.click();
  await h.randomDelay(6000, 10000);
  logger.log(account.name, 'SHARE', '✓ Shared to own profile.');

  // Capture the shared post URL for comment monitoring
  const profileUrl = account.ownProfileUrl || 'https://www.facebook.com/me';
  try {
    const sharedPostUrl = await getLatestProfilePost(page, profileUrl, h);
    if (sharedPostUrl) {
      addSharedPost(account, sharedPostUrl);
      logger.log(account.name, 'SHARE', `✓ Saved profile post URL: ${sharedPostUrl}`);
      return sharedPostUrl;
    } else {
      logger.warn(account.name, 'SHARE', 'Could not find latest profile post after sharing.');
    }
  } catch (captureErr) {
    logger.warn(account.name, 'SHARE', `Could not capture profile share URL: ${captureErr.message}`);
  }
  return null;
}

/**
 * Share the post to each configured group (posts the link directly to the wall).
 * @param {import('playwright').Page} page
 * @param {string} postUrl
 * @param {object} account hydrated account (uses .name, .groups)
 * @param {object} h humanizer
 */
async function shareToGroups(page, postUrl, account, h) {
  logger.log(account.name, 'SHARE', `Sharing to ${account.groups.length} group(s)...`);

  for (const groupUrl of account.groups) {
    try {
      logger.log(account.name, 'SHARE', `→ ${groupUrl}`);
      await h.randomDelay();

      // Always post the link directly to the group wall
      await shareDirectlyToGroup(page, postUrl, groupUrl, account, h);
    } catch (err) {
      logger.logError(account.name, 'SHARE', err);
    }
  }
}

/**
 * Post the post URL directly into a group's composer, then capture the resulting
 * group-post permalink for comment monitoring.
 * @param {import('playwright').Page} page
 * @param {string} postUrl
 * @param {string} groupUrl
 * @param {object} account hydrated account (uses .name, .ownProfileUrl)
 * @param {object} h humanizer ({ randInt, randomDelay, sleep })
 */
async function shareDirectlyToGroup(page, postUrl, groupUrl, account, h) {
  try {
    logger.log(account.name, 'SHARE-FALLBACK', `Posting link to group wall: ${groupUrl}`);
    await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await h.randomDelay(3000, 6000);

    await page.evaluate(() => window.scrollBy(0, 400));
    await h.randomDelay(1000, 2000);

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
      await h.randomDelay(3000, 5000);
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
    await h.randomDelay(2000, 3000);

    const textBox = await page
      .waitForSelector(
        'div[contenteditable="true"][role="textbox"], [aria-label="Write something to the group…"]',
        { timeout: 12000 }
      )
      .catch(() => null);

    if (!textBox) {
      logger.warn(account.name, 'SHARE-FALLBACK', `Text box did not appear in: ${groupUrl}`);
      return;
    }

    // Group link is typed with a faster, fixed jitter (30–80ms) in the monolith,
    // distinct from the settings-driven typing speed — preserved verbatim.
    for (const char of postUrl) {
      await page.keyboard.type(char);
      await h.sleep(h.randInt(30, 80));
    }

    await h.randomDelay(2000, 4000);

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

    await h.randomDelay(3000, 5000);

    if (posted) {
      try {
        const groupPostUrl = await getLatestPostInGroupByUser(page, groupUrl, account, h);
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

module.exports = { shareToOwnProfile, shareToGroups, shareDirectlyToGroup };
