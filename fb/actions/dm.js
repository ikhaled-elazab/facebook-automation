'use strict';

/**
 * fb/actions/dm.js — DM a commenter, optionally as a page identity.
 *
 * Ports index.js switchToIdentity / sendDmToUser. The identity-switcher and
 * messenger selector logic — the highest-ban-risk, most fragile flow — is
 * preserved VERBATIM. Changes:
 *   - humanization via injected humanizer `h` (h.randInt, h.randomDelay, h.pickRandom).
 *   - the global enable gate now reads settings.enable_dm_to_commenters (the DB
 *     column, INTEGER 0/1) instead of config.enableDmToCommenters. The legacy
 *     guard was `config.enableDmToCommenters === false` (strict-false only); the
 *     DB column is always 0 or 1 so a plain truthiness gate is the correct,
 *     unambiguous opt-in. 0 (the default) disables — same effect as before.
 *   - dm-sent dedupe is DB-backed via core/state.js.
 * Account fields used: .name, .sendDmToCommenters, .dmMessages, .dmAsPageUrl,
 *   .ownProfileUrl (legacy camelCase preserved by loadConfig).
 */

const logger = require('../../logger.js');
const { cleanFbUrl, extractFbHandle, readDmSent, writeDmSent } = require('../../core/state.js');

/**
 * Switch the active Facebook identity to a page (or back to the personal
 * profile) via the top-nav Account switcher.
 * @param {import('playwright').Page} page
 * @param {object} account hydrated account (uses .name)
 * @param {string} targetUrl page/profile URL to switch to
 * @param {string} label "page" | "personal" (logging only)
 * @param {object} h humanizer ({ randomDelay })
 * @returns {Promise<boolean>} true if the switch was performed
 */
async function switchToIdentity(page, account, targetUrl, label, h) {
  logger.log(account.name, 'DM', `Switching to ${label} identity...`);

  // Navigate to FB home first to ensure the nav is in a clean state
  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await h.randomDelay(3000, 5000);

  // Open the Account / profile switcher dropdown
  let switcherBtn = null;
  for (const sel of [
    '[aria-label="Account"]',
    '[aria-label="Your profile"]',
    '[data-testid="blue_bar_profile_link"]',
  ]) {
    switcherBtn = await page.$(sel);
    if (switcherBtn) break;
  }

  if (!switcherBtn) {
    logger.warn(account.name, 'DM', `Could not find account switcher button for ${label} identity.`);
    return false;
  }

  await switcherBtn.scrollIntoViewIfNeeded();
  await h.randomDelay(500, 1000);
  await switcherBtn.click({ force: true });
  await h.randomDelay(2000, 3000);

  // The dropdown lists profiles/pages — find the one whose link matches targetUrl.
  // We extract the path/username from targetUrl to compare loosely.
  let targetHandle = null;
  try {
    const u = new URL(targetUrl);
    targetHandle = u.searchParams.get('id') || u.pathname.split('/').filter(Boolean).pop();
  } catch {
    /* ignore */
  }

  // Look for a menuitem/button whose inner link href contains the target handle
  const found = await page.evaluate((handle) => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="button"]'));
    for (const item of items) {
      const links = Array.from(item.querySelectorAll('a[href]'));
      for (const a of links) {
        if (handle && a.href.includes(handle)) {
          a.click();
          return true;
        }
      }
      // Fallback: click the item itself if its own href matches
      if (item.tagName === 'A' && handle && item.href && item.href.includes(handle)) {
        item.click();
        return true;
      }
    }
    return false;
  }, targetHandle);

  if (!found) {
    // Try pressing Escape to close the dropdown and warn
    await page.keyboard.press('Escape').catch(() => {});
    logger.warn(account.name, 'DM', `Identity "${label}" not found in switcher dropdown (handle: ${targetHandle}).`);
    return false;
  }

  await h.randomDelay(3000, 5000);
  logger.log(account.name, 'DM', `Switched to ${label} identity.`);
  return true;
}

/**
 * Send a DM to a commenter's profile, switching to the page identity first when
 * configured. No-op when disabled, not configured, already-sent, or self.
 *
 * FALSE-SUCCESS FIX (P5): this used to return nothing, and the caller
 * (fb/monitor.js) logged a 'dm' action as status:'ok' UNCONDITIONALLY — so a
 * deduped / disabled / failed DM that sent NOTHING still counted toward the
 * daily cap. We now return a discriminated result so the caller logs the correct
 * status from the agreed vocabulary:
 *   - { sent: true }                       → a message was actually sent  → 'ok'
 *   - { sent: false, reason: <no-op> }     → a legitimate no-op           → 'skipped'
 *   - { sent: false, reason: 'error', error } → an attempt that failed    → 'failed'
 * A DM that sent nothing MUST NOT count toward the cap (it logs 'skipped' or
 * 'failed', neither of which countActionsToday counts).
 *
 * @param {import('playwright').Page} page
 * @param {object} account hydrated account
 * @param {string} profileUrl commenter profile URL
 * @param {object} settings db.getSettings() row (uses enable_dm_to_commenters)
 * @param {object} h humanizer ({ randInt, randomDelay, pickRandom })
 * @returns {Promise<{ sent: boolean, reason?: string, error?: string }>}
 */
async function sendDmToUser(page, account, profileUrl, settings, h) {
  if (!settings || !settings.enable_dm_to_commenters) return { sent: false, reason: 'dm_disabled' };
  if (!account.sendDmToCommenters) return { sent: false, reason: 'account_dm_off' };
  if (!account.dmMessages || !account.dmMessages.length) return { sent: false, reason: 'no_messages' };

  // Self-DM guard
  if (account.ownProfileUrl && cleanFbUrl(profileUrl) === cleanFbUrl(account.ownProfileUrl)) {
    logger.warn(account.name, 'DM', 'Skipping DM — profile URL matches own profile.');
    return { sent: false, reason: 'self_profile' };
  }

  const dmSent = readDmSent(account);
  const cleanUrl = cleanFbUrl(profileUrl);
  if (dmSent.has(cleanUrl)) {
    logger.log(account.name, 'DM', `Already DM'd ${cleanUrl}, skipping.`);
    return { sent: false, reason: 'deduped' };
  }

  const usingPage = !!account.dmAsPageUrl;

  try {
    // ── Switch to page identity if configured ──────────────────────────────
    if (usingPage) {
      const switched = await switchToIdentity(page, account, account.dmAsPageUrl, 'page', h);
      if (!switched) {
        logger.warn(account.name, 'DM', 'Could not switch to page identity, aborting DM.');
        return { sent: false, reason: 'identity_switch_failed' };
      }
    }

    // ── Navigate to the chat thread ────────────────────────────────────────
    if (usingPage) {
      // Use direct Messenger URL when sending as page (avoids "Message" button
      // which may not appear on profiles when viewed as a page)
      const handle = extractFbHandle(cleanUrl);
      if (!handle) {
        logger.warn(account.name, 'DM', `Could not extract FB handle from ${cleanUrl}`);
        return { sent: false, reason: 'no_handle' };
      }
      const messengerUrl = `https://www.facebook.com/messages/t/${handle}`;
      logger.log(account.name, 'DM', `Opening Messenger thread: ${messengerUrl}`);
      await page.goto(messengerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await h.randomDelay(4000, 7000);
    } else {
      logger.log(account.name, 'DM', `Navigating to profile: ${cleanUrl}`);
      await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await h.randomDelay(3000, 6000);

      // Find "Message" button (personal profile flow)
      let msgBtn = null;
      for (const sel of [
        '[aria-label="Message"]',
        'div[role="button"]:has-text("Message")',
        'a[role="button"]:has-text("Message")',
      ]) {
        msgBtn = await page.$(sel);
        if (msgBtn) break;
      }

      if (!msgBtn) {
        logger.warn(account.name, 'DM', `Message button not found on ${cleanUrl}`);
        return { sent: false, reason: 'message_button_not_found' };
      }

      await msgBtn.scrollIntoViewIfNeeded();
      await h.randomDelay(800, 1500);
      await msgBtn.click({ force: true });
      await h.randomDelay(3000, 5000);
    }

    // ── Find chat input and send message ──────────────────────────────────
    let chatBox = null;
    for (const sel of [
      'div[role="combobox"][contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="Message"]',
      'div[contenteditable="true"][aria-placeholder*="Aa"]',
    ]) {
      chatBox = await page.$(sel);
      if (chatBox) break;
    }

    if (!chatBox) {
      logger.warn(account.name, 'DM', `Chat input not found after opening Messenger for ${cleanUrl}`);
      return { sent: false, reason: 'chat_input_not_found' };
    }

    await chatBox.click();
    await h.randomDelay(500, 1000);

    const message = h.pickRandom(account.dmMessages);
    await h.typeText(page, message);

    await h.randomDelay(1000, 2000);
    await page.keyboard.press('Enter');
    await h.randomDelay(2000, 3000);

    dmSent.add(cleanUrl);
    writeDmSent(account, dmSent);
    logger.log(account.name, 'DM', `✓ DM sent to: ${cleanUrl}${usingPage ? ' (as page)' : ''}`);
    // The finally (identity switch-back) runs before this value propagates.
    return { sent: true };
  } catch (err) {
    logger.warn(account.name, 'DM', `DM failed for ${cleanUrl}: ${err.message}`);
    return { sent: false, reason: 'error', error: err.message };
  } finally {
    // ── Switch back to personal identity if we switched to a page ─────────
    if (usingPage && account.ownProfileUrl) {
      await switchToIdentity(page, account, account.ownProfileUrl, 'personal', h).catch((e) =>
        logger.warn(account.name, 'DM', `Failed to switch back to personal: ${e.message}`)
      );
    }
  }
}

module.exports = { switchToIdentity, sendDmToUser };
