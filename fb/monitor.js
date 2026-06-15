'use strict';

/**
 * fb/monitor.js — monitor shared posts and reply to (and optionally DM) new
 * commenters.
 *
 * Port of index.js monitorAndReplyToComments. The comment-discovery, sort-to-
 * Newest, scroll-until-stable, per-comment like/reply, and stale-handle-after-DM
 * logic — all fragile — preserved VERBATIM. Changes:
 *   - humanization via injected humanizer `h`.
 *   - seen-comments + shared-posts state is DB-backed via core/state.js.
 *   - reply text via ai.js generateReply (falls back to account.replies).
 *   - DM via fb/actions/dm.js sendDmToUser, now forwarding settings + h.
 * Account fields used: .name, .replies, .sendDmToCommenters (legacy camelCase
 *   preserved by loadConfig).
 */

const logger = require('../logger.js');
const db = require('../db');
const { readSharedPosts, readSeenComments, markCommentSeen, cleanFbUrl } = require('../core/state.js');
const { generateReply } = require('../ai.js');
const { sendDmToUser } = require('./actions/dm.js');

/**
 * For each shared post, find new comments, like + reply to them, and optionally
 * DM the commenter. Persists seen comment ids so each is acted on once.
 *
 * P5 GOVERNOR: per-comment reply + DM are ban-risk WRITES, so they are gated by
 * the same pacing governor as the main-post actions (passed via ctx). When the
 * governor denies (cap reached / outside active hours), the reply/DM for that
 * comment is SKIPPED (a 'skipped' row is logged) but the comment is still marked
 * seen so it is not retried forever — and the scan continues. ctx is optional:
 * when absent (legacy callers / tests) the monitor behaves exactly as before.
 *
 * @param {import('playwright').Page} page
 * @param {object} account hydrated account (uses .name, .replies, .sendDmToCommenters)
 * @param {object} settings db.getSettings() row (forwarded to sendDmToUser)
 * @param {object} h humanizer ({ randInt, randomDelay, sleep, typeText })
 * @param {object} [ctx] run context ({ governor, logAction }); when present, the
 *   per-comment reply/DM writes are gated + logged through the P5 governor.
 */
async function monitorAndReplyToComments(page, account, settings, h, ctx = {}) {
  const governor = ctx.governor || null;
  const logAction = ctx.logAction || ((entry) => db.logAction(entry));
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
      await h.randomDelay(4000, 7000);

      // Scroll down to load comments, then expand and scroll more.
      // Repeat until no new comment articles appear (lazy-load stabilised).
      const countComments = () =>
        page.evaluate(() => document.querySelectorAll('[role="article"][aria-label*="Comment by"]').length);

      // Initial scroll to get past the post header into the comments section
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => window.scrollBy(0, 700));
        await h.randomDelay(900, 1600);
      }

      // Switch comment sort order to "Newest" so new comments appear first.
      // 1. Click the sort dropdown (shows "Most relevant" by default)
      const sortBtn = await page.$('[role="button"][aria-haspopup="menu"]:has-text("Most relevant")');
      if (sortBtn) {
        await sortBtn.scrollIntoViewIfNeeded();
        await h.randomDelay(600, 1200);
        await sortBtn.click();
        await h.randomDelay(1000, 2000);
        // 2. Click "Newest" from the dropdown
        const newestItem = await page
          .waitForSelector('[role="menuitem"]:has-text("Newest")', { timeout: 5000, state: 'visible' })
          .catch(() => null);
        if (newestItem) {
          await newestItem.click({ force: true });
          await h.randomDelay(2000, 3500);
          logger.log(account.name, 'COMMENTS', 'Switched comment sort to Newest.');
        } else {
          await page.keyboard.press('Escape');
        }
      }

      // Click "View more comments" / "See more comments" if available
      for (const sel of [
        'div[role="button"]:has-text("View more comments")',
        'span:has-text("View more comments")',
        'div[role="button"]:has-text("See more comments")',
        'span:has-text("See more comments")',
      ]) {
        const more = await page.$(sel);
        if (more) {
          await more.click();
          await h.randomDelay(2000, 3000);
          break;
        }
      }

      // Scroll-until-stable: keep scrolling as long as new comments keep appearing
      let prevCount = 0;
      let stableRounds = 0;
      for (let round = 0; round < 12 && stableRounds < 2; round++) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await h.randomDelay(900, 1500);
        const cur = await countComments();
        if (cur === prevCount) {
          stableRounds++;
        } else {
          stableRounds = 0;
          prevCount = cur;
        }
      }

      // Wait for at least one comment article to appear
      await page
        .waitForSelector('[role="article"][aria-label*="Comment by"]', { timeout: 5000 })
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
          try {
            commentId = new URL(href, 'https://www.facebook.com').searchParams.get('comment_id');
          } catch {
            continue;
          }
          if (!commentId) continue;

          if (seenComments.has(commentId)) continue;

          logger.log(account.name, 'COMMENTS', `New comment ID: ${commentId}`);
          newCount++;

          // Extract commenter name from article label for accurate reply box targeting
          const articleLabel = (await article.getAttribute('aria-label')) || '';
          const nameMatch = articleLabel.match(/^Comment by (.+?) \d/);
          const commenterName = nameMatch ? nameMatch[1].trim() : null;

          // Extract commenter profile URL from the comment article
          let commenterProfileUrl = null;
          try {
            commenterProfileUrl = await article.evaluate((el) => {
              const links = Array.from(el.querySelectorAll('a[href*="facebook.com"]'));
              for (const a of links) {
                const href = a.href || '';
                // Skip comment permalinks, page links, and group home/post links
                if (href.includes('comment_id=')) continue;
                if (href.includes('/pages/')) continue;

                // In group contexts, user links often look like /groups/id/user/profile_id/
                if (href.includes('/user/')) return href;

                // Regular profile link with ID
                if (href.includes('profile.php?id=')) return href;

                // Direct profile link: facebook.com/username (no extra path segments)
                try {
                  const urlObj = new URL(href);
                  const pathParts = urlObj.pathname.split('/').filter(Boolean);
                  // If it's just facebook.com/username, pathParts.length is 1
                  if (
                    pathParts.length === 1 &&
                    !['groups', 'pages', 'events', 'marketplace', 'groups_home'].includes(pathParts[0])
                  ) {
                    return href;
                  }
                } catch {
                  /* skip unparseable link */
                }
              }
              return null;
            });
            if (commenterProfileUrl) {
              commenterProfileUrl = cleanFbUrl(commenterProfileUrl);
              logger.log(
                account.name,
                'COMMENTS',
                `Found profile URL for ${commenterName || 'commenter'}: ${commenterProfileUrl}`
              );
            } else {
              logger.warn(
                account.name,
                'COMMENTS',
                `Could not find profile URL for ${commenterName || 'commenter'}. Checked all links in article.`
              );
            }
          } catch (err) {
            logger.warn(account.name, 'COMMENTS', `Error extracting profile URL: ${err.message}`);
          }

          // Like the comment
          try {
            const likeBtn = await article.$('[aria-label="Like"]');
            if (likeBtn) {
              await likeBtn.scrollIntoViewIfNeeded();
              await h.randomDelay(800, 1500);
              await likeBtn.click({ force: true });
              await h.randomDelay(1000, 2000);
              logger.log(account.name, 'COMMENTS', `✓ Liked comment ${commentId}`);
            }
          } catch (likeErr) {
            logger.warn(account.name, 'COMMENTS', `Could not like comment ${commentId}: ${likeErr.message}`);
          }

          // P5 GOVERNOR: replying + DMing a commenter are ban-risk writes. Gate
          // them once per comment. When denied (cap reached / outside active
          // hours) we SKIP both the reply and the DM, log a 'skipped' row, but
          // still mark the comment seen below so it is not retried forever.
          let engagementAllowed = true;
          if (governor) {
            const decision = governor.canAct(account);
            engagementAllowed = decision.allowed;
            if (!engagementAllowed) {
              logger.warn(
                account.name,
                'COMMENTS',
                `Reply/DM for comment ${commentId} skipped by pacing governor (${decision.reason}).`
              );
              try {
                logAction({
                  accountId: account.id,
                  actionType: 'comment',
                  targetUrl: postUrl,
                  status: 'skipped',
                  detail: `${decision.reason}: ${decision.detail || ''}`.trim(),
                });
              } catch {
                /* logging is best-effort */
              }
            }
          }

          // Reply to the comment.
          //
          // FALSE-SUCCESS FIX (P5): log EXACTLY ONE action_log row per attempted
          // reply, with the correct status — 'ok' only when the reply actually
          // submitted, 'failed' when the reply box wasn't found or the reply
          // threw. Previously only the success path logged (always 'ok'), so a
          // failed reply was invisible to the error-rate probe and never counted
          // as a failure. We track replyAttempted/replyLogged so we never double-
          // log and never log when there was nothing to reply to (no Reply btn /
          // governor-denied → no row from here; the denial already logged 'skipped').
          let replyAttempted = false;
          let replyLogged = false;
          const logReply = (status, detail) => {
            if (replyLogged) return;
            replyLogged = true;
            try {
              logAction({ accountId: account.id, actionType: 'comment', targetUrl: postUrl, status, detail });
            } catch {
              /* best-effort — never break the scan on a log write */
            }
          };
          try {
            const replyBtn = engagementAllowed ? await article.$('[role="button"]:has-text("Reply")') : null;
            if (replyBtn) {
              replyAttempted = true;
              await replyBtn.scrollIntoViewIfNeeded();
              await h.randomDelay(800, 1500);
              await replyBtn.click({ force: true });
              await h.randomDelay(1500, 3000);

              // Target the specific reply box for this comment using the commenter's name.
              // Facebook sets aria-placeholder="Reply to [Name]…" on the reply input that
              // belongs to the comment we just clicked — this avoids typing into a wrong box.
              let replyBox = null;
              if (commenterName) {
                replyBox = await page
                  .waitForSelector(
                    `div[contenteditable="true"][role="textbox"][aria-placeholder="Reply to ${commenterName}…"]`,
                    { timeout: 8000, state: 'visible' }
                  )
                  .catch(() => null);
              }
              if (!replyBox) {
                // Fallback: any newly-visible reply textbox (not the main comment box)
                replyBox = await page
                  .waitForSelector('div[contenteditable="true"][role="textbox"][aria-placeholder^="Reply to"]', {
                    timeout: 6000,
                    state: 'visible',
                  })
                  .catch(() => null);
              }

              if (replyBox) {
                await replyBox.scrollIntoViewIfNeeded();
                await replyBox.click();
                await h.randomDelay(500, 1000);

                // Extract comment text for AI reply generation
                const commentText = (await article.evaluate((el) => el.innerText || '')).slice(0, 300);
                const reply = await generateReply(commentText, account);

                await h.typeText(page, reply);

                await h.randomDelay(1500, 3000);
                await page.keyboard.press('Enter');
                await h.randomDelay(2000, 3000);
                logger.log(account.name, 'COMMENTS', `✓ Replied to comment ${commentId}: "${reply}"`);
                // Count the reply toward the daily cap (the governor reads 'ok' rows).
                logReply('ok', null);
              } else {
                logger.warn(
                  account.name,
                  'COMMENTS',
                  `Reply box not found for comment ${commentId} (commenter: ${commenterName})`
                );
                // We clicked Reply but never found a box to type into — a real
                // failure, not a no-op. Log 'failed' (does NOT count toward cap).
                logReply('failed', 'reply box not found');
              }
            }
          } catch (replyErr) {
            logger.warn(account.name, 'COMMENTS', `Could not reply to comment ${commentId}: ${replyErr.message}`);
            // Only log a failure row if we actually began a reply (clicked Reply).
            // A failure before that (e.g. article.$ threw) is a scan glitch, not a
            // failed reply action.
            if (replyAttempted) logReply('failed', `reply error: ${replyErr.message}`);
          }

          // Send DM to commenter (navigates away and back). Gated by the same
          // per-comment governor decision as the reply (engagementAllowed).
          if (engagementAllowed && commenterProfileUrl && account.sendDmToCommenters) {
            // FALSE-SUCCESS FIX (P5): sendDmToUser now returns a discriminated
            // result so we log the CORRECT status — 'ok' only on a real send,
            // 'skipped' on a legitimate no-op (deduped / disabled / self), and
            // 'failed' on an error. A DM that sent NOTHING must NOT count toward
            // the cap (countActionsToday counts only 'ok'). A throw (rejected
            // promise) is treated as a failure, not a silent success.
            const dmResult = await sendDmToUser(page, account, commenterProfileUrl, settings, h).catch((e) => {
              logger.warn(account.name, 'DM', `DM failed: ${e.message}`);
              return { sent: false, reason: 'error', error: e.message };
            });
            const dmStatus = dmResult && dmResult.sent ? 'ok' : dmResult && dmResult.reason === 'error' ? 'failed' : 'skipped';
            try {
              logAction({
                accountId: account.id,
                actionType: 'dm',
                targetUrl: commenterProfileUrl,
                status: dmStatus,
                detail: dmStatus === 'ok' ? null : dmResult && (dmResult.error || dmResult.reason) ? `dm ${dmResult.reason}${dmResult.error ? `: ${dmResult.error}` : ''}` : null,
              });
            } catch {
              /* best-effort — never break the scan on a log write */
            }
            await h.randomDelay(3000, 6000);
            // Navigate back — sendDmToUser left us on the commenter's profile
            await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            await h.randomDelay(3000, 5000);
            // Remaining article handles are stale; the outer articleErr catch handles this gracefully
          }

          // MEDIUM-1: mark this comment seen IMMEDIATELY after acting on it
          // (durable + idempotent), not batched at the end of the post loop. If
          // the cycle is interrupted mid-loop, already-actioned commenters stay
          // suppressed next cycle instead of being re-liked/re-replied/re-DM'd.
          seenComments.add(commentId); // keep the in-memory set hot for this pass
          markCommentSeen(account, postUrl, commentId); // persist now, not later
        } catch (articleErr) {
          logger.warn(account.name, 'COMMENTS', `Error processing comment article: ${articleErr.message}`);
        }
      }

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

module.exports = { monitorAndReplyToComments };
