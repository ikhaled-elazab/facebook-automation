'use strict';

/**
 * fb/scope.js — active-post scope resolver.
 *
 * getActivePostScope() locates the DOM container that holds the post we are
 * acting on: a verified post dialog if one is open, else the primary article in
 * the main content area, else the first article, else document. Returning a
 * scoped ElementHandle lets the like/comment/share code query WITHIN the active
 * post instead of matching stray buttons elsewhere on the page.
 *
 * This is a byte-for-byte port of index.js getActivePostScope — the selector
 * logic is the fragile, hard-won part of the bot and is preserved verbatim.
 * It has no config or state dependency.
 */

/**
 * Resolve the active post container as a Playwright ElementHandle.
 * @param {import('playwright').Page} page
 * @returns {Promise<import('playwright').ElementHandle|null>}
 */
async function getActivePostScope(page) {
  // Wait a moment for modal elements to possibly appear
  await page.waitForTimeout(3000);

  const handle = await page.evaluateHandle(() => {
    // Helper to verify a container actually holds post/feed elements
    const isPostContainer = (container) => {
      if (!container) return false;
      return !!(
        container.querySelector('[role="article"]') ||
        container.querySelector('[data-ad-rendering-role="like_button"]') ||
        container.querySelector('[aria-label="Like"]') ||
        container.querySelector('[aria-label="أعجبني"]')
      );
    };

    // 1. Try standard dialogs (only if they contain a post)
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    for (const dialog of dialogs) {
      if (isPostContainer(dialog)) return dialog;
    }

    // 2. Try the primary article in the main content area
    const main = document.querySelector('[role="main"]');
    if (main) {
      const mainArticle = main.querySelector('[role="article"]');
      if (mainArticle) return mainArticle;
    }

    // 3. Fallback to the first article on the page
    const fallbackArticle = document.querySelector('[role="article"]');
    if (fallbackArticle) return fallbackArticle;

    // 4. Ultimate fallback
    return document;
  });

  const isElem = await handle.evaluate((n) => n && n.nodeType === 1).catch(() => false);
  return isElem ? handle.asElement() : null;
}

module.exports = { getActivePostScope };
