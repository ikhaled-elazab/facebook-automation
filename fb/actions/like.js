'use strict';

/**
 * fb/actions/like.js — like the active post.
 *
 * Port of index.js likePost. Selector / already-liked detection / human
 * mouse-move-and-click logic preserved VERBATIM (the fragile part). Changes:
 *   - humanization via injected humanizer `h` (h.randInt, h.randomDelay).
 *   - scope resolution via fb/scope.js getActivePostScope.
 * Account fields used: .name (legacy camelCase, preserved by loadConfig).
 */

const logger = require('../../logger.js');
const { getActivePostScope } = require('../scope.js');

/**
 * Like the post at postUrl. No-op if already liked. Throws if the Like button
 * can't be located (drives the retry/vision fallback).
 * @param {import('playwright').Page} page
 * @param {string} postUrl
 * @param {object} account hydrated account (uses .name)
 * @param {object} h humanizer ({ randInt, randomDelay })
 */
async function likePost(page, postUrl, account, h) {
  logger.log(account.name, 'LIKE', 'Navigating to post...');

  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Wait a bit just in case
  await h.randomDelay(2000, 4000);

  // Use the robust helper to find the active scope
  const dialog = await getActivePostScope(page);

  if (!dialog) {
    logger.warn(account.name, 'LIKE', 'Dialog did not open, trying page-level search...');
  } else {
    logger.log(account.name, 'LIKE', 'Dialog scope found.');
  }

  const hasLikeBtn = () =>
    (dialog || page).evaluate((node) => {
      const root = node || document;
      if (root.querySelector('[data-ad-rendering-role="like_button"]')) return true;
      return Array.from(
        root.querySelectorAll(
          '[aria-label="Like"],[aria-label="أعجبني"],[aria-label="Unlike"],[aria-label="Remove Like"],[aria-label="إلغاء الإعجاب"]'
        )
      ).some((el) => !el.closest('ul'));
    });

  for (let scrollStep = 0; scrollStep < 12; scrollStep++) {
    if (await hasLikeBtn()) break;

    // Ensure mouse is inside the dialog explicitly to trigger internal scroll
    if (dialog) {
      try {
        const inner = await dialog.$('[role="article"], [data-ad-rendering-role="story_message"], div.x1n2onr6');
        if (inner) await inner.hover({ force: true });
        else await dialog.hover({ force: true });
      } catch {
        /* hover best-effort */
      }
    } else {
      const vs = page.viewportSize();
      if (vs) await page.mouse.move(vs.width / 2, vs.height / 2);
    }

    await page.mouse.wheel(0, 250);
    await h.randomDelay(400, 700);
  }

  const scope = dialog || page;

  // Check if the post is already liked
  // The "Remove Like" button is a [role="button"] that CONTAINS a div with
  // data-ad-rendering-role="like_button".
  const isAlreadyLiked = await scope
    .evaluate((node) => {
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
      const unlikes = Array.from(
        root.querySelectorAll('[aria-label="Unlike"], [aria-label="Remove Like"], [aria-label="إلغاء الإعجاب"]')
      );
      for (const btn of unlikes) {
        // Ensure we don't accidentally grab a comment's Unlike button (usually in lists/ul)
        const inCommentList = btn.closest('ul');
        if (!inCommentList) return true;
      }
      return false;
    })
    .catch(() => false);

  if (isAlreadyLiked) {
    logger.log(account.name, 'LIKE', 'Post already liked, skipping.');
    return;
  }

  // Find the actual Like button to click
  const likeBtn = await scope
    .evaluateHandle((node) => {
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
    })
    .catch(() => null);

  const isLikeBtnValid = likeBtn && (await likeBtn.evaluate((el) => el !== null).catch(() => false));

  if (!isLikeBtnValid) {
    logger.warn(account.name, 'LIKE', 'Like button not found. Dumping DOM of scope...');
    try {
      const htmlDump = await scope.evaluate((node) => (node || document).innerHTML);
      require('fs').writeFileSync('debug_dom_scope.html', htmlDump);
    } catch {
      /* best-effort DOM dump */
    }
    throw new Error('Like button not found');
  }

  // Human-like: scroll button into view, move mouse, then click
  await likeBtn.scrollIntoViewIfNeeded();
  await h.randomDelay(500, 1000);

  const btnBox = await likeBtn.boundingBox();
  if (btnBox) {
    const bx = btnBox.x + btnBox.width / 2 + h.randInt(-3, 3);
    const by = btnBox.y + btnBox.height / 2 + h.randInt(-2, 2);
    await page.mouse.move(bx, by, { steps: h.randInt(8, 20) });
    await h.randomDelay(300, 800);
    await page.mouse.click(bx, by);
  } else {
    await likeBtn.dispatchEvent('click');
  }

  await h.randomDelay(1500, 3000);
  logger.log(account.name, 'LIKE', '✓ Post liked.');
}

module.exports = { likePost };
