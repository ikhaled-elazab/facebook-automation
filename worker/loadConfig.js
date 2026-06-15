'use strict';

/**
 * worker/loadConfig.js — DB → domain config adapter (Anti-Corruption Layer).
 *
 * Phase 2 (multi-branch): the fragile fb/ selector code was written against the
 * accounts.json camelCase shape (targetPageUrl, ownProfileUrl, groups, …) keyed
 * by a single numeric `.id`. In Phase 2 a BRANCH is the monitoring unit, so this
 * module hydrates each (account, branch) pair into the EXACT camelCase shape the
 * fb/ code already expects — but with `.id` = the BRANCH id (the key core/state.js
 * uses for state/content), and the account-envelope fields (credentials, session,
 * proxy, fingerprint) merged in so login.js / fb/ keep working unchanged.
 *
 * THE `.id` MEANING-SHIFT (grep-verified across the codebase):
 *   - LOGIN / SESSION paths read account.name + account.sessionFile only —
 *     they are per-ACCOUNT (one login = one browser). hydrateBranch carries
 *     `accountId` + `accountName` for these.
 *   - STATE / CONTENT / GOVERNOR / LOGGING paths read `.id` — these become the
 *     BRANCH id. core/state.js keys account_state/seen_comments/dm_sent by `.id`;
 *     core/governor.js reads `.id` + `.dailyActionCap`; the action_log writers
 *     read `.id`. All of these now resolve to the branch.
 *
 * The password is intentionally NOT decrypted here. It is decrypted only at login
 * time by the caller. The worker uses pre-existing storage state (session_file)
 * and never needs the plaintext password to run a cycle.
 *
 * Settings are returned as the raw db.getSettings() row (snake_case).
 */

const db = require('../db');

/**
 * The shared account ENVELOPE (credentials, session, proxy, fingerprint) merged
 * into every branch of an account. Computed once per account, not per branch.
 * @param {object} acctRow a row from db.listAccounts() / db.getAccountById()
 * @returns {object} camelCase account-envelope fields
 */
function accountEnvelope(acctRow) {
  return {
    // identity of the LOGIN (used by login.js / fb/ for browser + session)
    accountId: acctRow.id,
    accountName: acctRow.name,
    // `name` is preserved as the ACCOUNT name so existing fb/ logger calls
    // (logger.log(account.name, ...)) still print the FB-login identity. The
    // branch's own name is exposed separately as `branchName`.
    name: acctRow.name,
    email: acctRow.email,
    // credentials at rest — decrypt only at login time, never here
    passwordEnc: acctRow.password_enc,
    proxyPasswordEnc: acctRow.proxy_password_enc,
    // session file — per-account (one login = one storage state)
    sessionFile: acctRow.session_file,
    // browser fingerprint — per-account
    userAgent: acctRow.user_agent,
    locale: acctRow.locale,
    timezoneId: acctRow.timezone_id,
    // proxy — shaped like the old account.proxy object the worker reads
    proxy: acctRow.proxy_server
      ? {
          server: acctRow.proxy_server,
          username: acctRow.proxy_username || undefined,
          // plaintext proxy password is resolved at context-build time (worker/loop.js)
          passwordEnc: acctRow.proxy_password_enc || undefined,
        }
      : null,
    // per-account pacing CEILING (the governor's account tier reads this)
    accountDailyActionCap: acctRow.daily_action_cap,
    accountEnabled: !!acctRow.enabled,
  };
}

/**
 * Hydrate one (account, branch) pair into the camelCase domain object the fb/
 * selector code + core/state.js + core/governor.js expect. The returned object's
 * `.id` is the BRANCH id (state/content/governor/logging key). The account
 * envelope is merged in for login/session/proxy/fingerprint.
 *
 * @param {object} acctRow account row (the login envelope)
 * @param {object} branchRow branch row (the monitoring unit)
 * @returns {object} hydrated branch — exact camelCase shape, `.id` = branch id
 */
function hydrateBranch(acctRow, branchRow) {
  const env = accountEnvelope(acctRow);
  return {
    ...env,
    // ── DB key: `.id` is the BRANCH id (state/content/governor/logging) ──
    id: branchRow.id,
    branchId: branchRow.id,
    branchName: branchRow.name,
    isDefault: !!branchRow.is_default,
    // ── Branch-owned targets (camelCase parity with the old accounts.json) ──
    targetPageUrl: branchRow.target_page_url,
    ownProfileUrl: branchRow.own_profile_url,
    // DM-as-page identity (per-branch opt-in)
    sendDmToCommenters: !!branchRow.send_dm_to_commenters,
    dmAsPageUrl: branchRow.dm_as_page_url,
    checkIntervalMinutes: branchRow.check_interval_minutes,
    // ── Pacing: `.dailyActionCap` is the BRANCH cap (NULL = inherit account
    //    ceiling). The governor's three-tier logic reads dailyActionCap (branch)
    //    then accountDailyActionCap (ceiling) then settings.global. ──
    dailyActionCap: branchRow.daily_action_cap,
    enabled: !!branchRow.enabled,
    // ── Branch content collections ──
    comments: db.getBranchComments(branchRow.id),
    replies: db.getBranchReplies(branchRow.id),
    dmMessages: db.getBranchDmMessages(branchRow.id),
    groups: db.getBranchGroups(branchRow.id),
  };
}

/**
 * Load all enabled accounts, each with a hydrated `branches[]` (only enabled
 * branches), plus the global settings row. An account with no enabled branches
 * is still returned (with an empty branches[]) so the worker can log it and skip,
 * rather than silently dropping the login.
 *
 * @returns {{ accounts: object[], settings: object }} each account carries:
 *   { accountId, accountName, sessionFile, ...envelope, branches: hydratedBranch[] }
 */
function loadWorkerConfig() {
  const settings = db.getSettings();
  const acctRows = db.listAccounts({ enabledOnly: true });
  const accounts = acctRows.map((acctRow) => {
    const branchRows = db.listBranches({ accountId: acctRow.id, enabledOnly: true });
    const branches = branchRows.map((b) => hydrateBranch(acctRow, b));
    return {
      ...accountEnvelope(acctRow),
      branches,
    };
  });
  return { accounts, settings };
}

module.exports = { loadWorkerConfig, hydrateBranch, accountEnvelope };
