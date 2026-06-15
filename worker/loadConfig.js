'use strict';

/**
 * worker/loadConfig.js — DB → domain config adapter (Anti-Corruption Layer).
 *
 * The fragile fb/ selector code was written against the accounts.json /
 * config.json camelCase shape (account.targetPageUrl, account.ownProfileUrl,
 * account.groups, …). The DB returns snake_case rows. Rather than rewrite every
 * field access in the selector code (high regression risk), this module hydrates
 * each DB account row + its child collections into the EXACT camelCase shape the
 * fb/ code already expects — while ALSO preserving the numeric DB `.id` that
 * core/state.js keys runtime state by.
 *
 * The password is intentionally NOT decrypted here. It is decrypted only at
 * login time by the caller (login.js / a future session refresh), via
 * crypto.decrypt(account.password_enc). The worker uses pre-existing storage
 * state (session_file) and never needs the plaintext password to run a cycle.
 *
 * Settings are returned as the raw db.getSettings() row (snake_case): the
 * humanizer, retry, and dm gate all read snake_case settings columns directly.
 */

const db = require('../db');

/**
 * Hydrate one DB account row into the camelCase domain account, resolving its
 * child collections (comments/replies/dmMessages/groups) from their tables.
 * @param {object} row a row from db.listAccounts() / db.getAccountById()
 * @returns {object} hydrated account (camelCase + numeric .id + encrypted creds)
 */
function hydrateAccount(row) {
  return {
    // identity / DB key (used by core/state.js)
    id: row.id,
    name: row.name,
    email: row.email,
    // credentials at rest — decrypt only at login time, never here
    passwordEnc: row.password_enc,
    proxyPasswordEnc: row.proxy_password_enc,
    // session + targets (camelCase parity with the old accounts.json)
    sessionFile: row.session_file,
    targetPageUrl: row.target_page_url,
    ownProfileUrl: row.own_profile_url,
    // DM-as-page identity
    sendDmToCommenters: !!row.send_dm_to_commenters,
    dmAsPageUrl: row.dm_as_page_url,
    // browser fingerprint
    userAgent: row.user_agent,
    locale: row.locale,
    timezoneId: row.timezone_id,
    checkIntervalMinutes: row.check_interval_minutes,
    // proxy — shaped like the old account.proxy object the worker reads
    proxy: row.proxy_server
      ? {
          server: row.proxy_server,
          username: row.proxy_username || undefined,
          // plaintext proxy password is resolved at context-build time (see worker/loop.js)
          passwordEnc: row.proxy_password_enc || undefined,
        }
      : null,
    // pacing
    dailyActionCap: row.daily_action_cap,
    enabled: !!row.enabled,
    // child collections
    comments: db.getAccountComments(row.id),
    replies: db.getAccountReplies(row.id),
    dmMessages: db.getAccountDmMessages(row.id),
    groups: db.getAccountGroups(row.id),
  };
}

/**
 * Load all enabled accounts (hydrated) plus the global settings row.
 * @returns {{ accounts: object[], settings: object }}
 */
function loadWorkerConfig() {
  const settings = db.getSettings();
  const rows = db.listAccounts({ enabledOnly: true });
  const accounts = rows.map(hydrateAccount);
  return { accounts, settings };
}

module.exports = { loadWorkerConfig, hydrateAccount };
