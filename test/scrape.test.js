'use strict';

/**
 * test/scrape.test.js — unit tests for the pure post-selection logic extracted
 * from fb/scrape.js getLatestPost.
 *
 * Regression context: getLatestPost used to scroll deep into the feed and then
 * take the FIRST post link across the whole document (`unique[0]`). Facebook
 * virtualizes (unmounts) the top of the feed as you scroll, so `unique[0]` became
 * whatever older post happened to still be mounted — observed returning three
 * different "latest" ids across consecutive worker cycles for one page. The fix
 * reads the feed top-down per article and picks the first article that exposes a
 * post permalink (the newest post). `chooseLatestPostHref` is that pure decision,
 * unit-tested here without a browser; the thin DOM-gathering around it is verified
 * live (run dumpFeed.js repeatedly and confirm a STABLE id).
 *
 * The fixtures below mirror the real captured structure of the affected page:
 *   - article 0: the NEWEST post (a /posts/ permalink) PLUS a comment link (which
 *     must be ignored — comment links carry comment_id=);
 *   - article 1: a post whose permalink is NOT extractable (came back null in the
 *     real capture) — must be skipped, not block selection;
 *   - article 2: an OLDER post (a /posts/ permalink) — must NEVER be chosen over 0.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { chooseLatestPostHref } = require('../fb/scrape.js');

const NEW = 'https://www.facebook.com/aba.ADahab.Real.Estate/posts/pfbid032ma8LyNEWEST?__cft__[0]=AAA&__tn__=%2CO';
const NEW_COMMENT = 'https://www.facebook.com/aba.ADahab.Real.Estate/posts/pfbid032ma8LyNEWEST?comment_id=999';
const OLD = 'https://www.facebook.com/aba.ADahab.Real.Estate/posts/pfbid0346OLDER?__cft__[0]=BBB';

test('chooseLatestPostHref: picks the newest (first) article post, ignoring comment links', () => {
  const articleHrefLists = [
    [NEW_COMMENT, NEW], // comment link appears first within the article; must be skipped
    ['https://www.facebook.com/aba.ADahab.Real.Estate/?ref=page_internal'], // null-link article
    [OLD],
  ];
  assert.strictEqual(chooseLatestPostHref(articleHrefLists), NEW);
});

test('chooseLatestPostHref: skips a leading article with no extractable post link', () => {
  const articleHrefLists = [
    ['https://www.facebook.com/aba.ADahab.Real.Estate/'], // no post permalink
    [OLD],
  ];
  assert.strictEqual(chooseLatestPostHref(articleHrefLists), OLD);
});

test('chooseLatestPostHref: never returns an older post over the newest', () => {
  const articleHrefLists = [[NEW], [OLD]];
  const got = chooseLatestPostHref(articleHrefLists);
  assert.strictEqual(got, NEW);
  assert.notStrictEqual(got, OLD);
});

test('chooseLatestPostHref: excludes comment links entirely', () => {
  assert.strictEqual(chooseLatestPostHref([[NEW_COMMENT]]), null);
});

test('chooseLatestPostHref: returns null when no article has a post link', () => {
  assert.strictEqual(
    chooseLatestPostHref([['https://www.facebook.com/x/'], ['https://www.facebook.com/y/about']]),
    null
  );
});

test('chooseLatestPostHref: handles empty / missing inputs safely', () => {
  assert.strictEqual(chooseLatestPostHref([]), null);
  assert.strictEqual(chooseLatestPostHref([[], null, undefined]), null);
});

test('chooseLatestPostHref: recognizes story_fbid and permalink.php forms', () => {
  const storyFbid = 'https://www.facebook.com/permalink.php?story_fbid=pfbidSTORY&id=page';
  assert.strictEqual(chooseLatestPostHref([[storyFbid]]), storyFbid);
});
