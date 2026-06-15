'use strict';

/**
 * fb/actions/comment.js — comment on the active post.
 *
 * Port of index.js commentOnPost. Selector logic and char-by-char typing
 * preserved. Changes:
 *   - humanization via injected humanizer `h` (h.randomDelay, h.typeText).
 *   - scope via fb/scope.js; comment text via ai.js generateComment, which
 *     falls back to account.comments when AI is disabled (loadConfig preserves
 *     .comments on the hydrated account).
 */

const logger = require('../../logger.js');
const { getActivePostScope } = require('../scope.js');
const { generateComment } = require('../../ai.js');

/**
 * Post a comment on the post (AI-generated or a random configured comment).
 * @param {import('playwright').Page} page
 * @param {string} postUrl (unused for navigation — the post is already open; kept for signature parity/logging)
 * @param {string} postText visible post text used as the AI prompt
 * @param {object} account hydrated account (uses .name, .comments)
 * @param {object} h humanizer ({ randomDelay, typeText })
 */
async function commentOnPost(page, postUrl, postText, account, h) {
  const comment = await generateComment(postText, account);
  if (!comment) {
    logger.warn(account.name, 'COMMENT', 'Generated comment is empty, skipping.');
    return;
  }
  logger.log(account.name, 'COMMENT', `Posting: "${comment}"`);

  await h.randomDelay();

  // The post is open as a dialog, or it's a standalone page. Resolve the search
  // scope to the dialog when present, else the page — both expose .$() so the
  // composer-button loop below works on either. (Previously this dereferenced
  // `dialog.$()` directly after only WARNING on a null dialog, throwing a
  // TypeError on standalone-page posts where getActivePostScope returns null.)
  const dialog = await getActivePostScope(page);
  if (!dialog) {
    logger.warn(account.name, 'COMMENT', 'Dialog not found, using page-level scope...');
  }
  const scope = dialog || page;

  // Click the "Leave a comment" button to activate the composer — scoped to active post
  for (const sel of [
    '[aria-label="Leave a comment"]',
    '[aria-label="Comment"]',
    '[aria-label="كتابة تعليق"]',
    'div[role="button"]:has([data-ad-rendering-role="comment_button"])',
  ]) {
    const btn = await scope.$(sel);
    if (btn) {
      await btn.dispatchEvent('click');
      break;
    }
  }

  await h.randomDelay(2000, 4000);

  const commentBox = await page.waitForSelector(
    '[aria-label="Write a comment…"], [aria-label="Write a public comment…"], div[contenteditable="true"][role="textbox"]',
    { timeout: 15000, state: 'visible' }
  );

  await commentBox.scrollIntoViewIfNeeded();
  await h.randomDelay(500, 1000);
  await commentBox.focus();
  await h.randomDelay(500, 1000);

  await h.typeText(page, comment);

  await h.randomDelay(1500, 3000);
  await page.keyboard.press('Enter');
  await h.randomDelay(1000, 2000);
  logger.log(account.name, 'COMMENT', '✓ Comment posted.');
}

module.exports = { commentOnPost };
