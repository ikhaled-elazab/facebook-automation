'use strict';

/**
 * migrate.js — One-time, idempotent, lossless migration of the legacy
 * JSON/file state into SQLite.
 *
 * Reads (if present):
 *   - config.json            → settings (id=1)
 *   - accounts.json          → accounts + child tables (comments/replies/dm/groups)
 *   - <account>.password     → encrypted into accounts.password_enc
 *   - account.proxy.password → encrypted into accounts.proxy_password_enc
 *   - state/<name>_last_post.txt              → account_state.last_post_id
 *   - state/<name>_shared_posts.json          → account_state.shared_posts
 *   - state/<name>_seen_comments_<hash>.json  → seen_comments rows
 *   - state/<name>_dm_sent.json               → dm_sent rows
 *
 * Idempotent: re-running upserts settings and account rows by unique name,
 * replaces child collections, and uses INSERT ... ON CONFLICT DO NOTHING for
 * state rows. Running twice yields the same DB.
 *
 * Usage:
 *   node migrate.js            # migrate using ./config.json + ./accounts.json
 *   node migrate.js --dry-run  # report what WOULD migrate, write nothing
 *
 * NOTE: requires APP_ENCRYPTION_KEY in .env (passwords are encrypted at rest).
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { encrypt } = require('./crypto');

const DRY_RUN = process.argv.includes('--dry-run');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function exists(p) {
  return fs.existsSync(path.resolve(p));
}

function log(...args) {
  console.log('[MIGRATE]', ...args);
}

// Mirror index.js postHash so we can locate seen_comments files if we ever need
// to (not strictly required since we glob the state dir, but kept for parity).
function migrateSettings(config) {
  if (!config) {
    log('No config.json found — leaving settings at defaults.');
    return;
  }
  const d = config.delays || {};
  const patch = {
    headless: config.headless ? 1 : 0,
    use_proxy: config.useProxy ? 1 : 0,
    use_ai: config.useAI ? 1 : 0,
    use_vision: config.useVision ? 1 : 0,
    vision_model: config.visionModel || 'gpt-4o-mini',
    vision_max_steps: config.visionMaxSteps || 8,
    log_dir: config.logDir || 'logs',
    screenshot_on_error: config.screenshotOnError ? 1 : 0,
    enable_dm_to_commenters: config.enableDmToCommenters ? 1 : 0,
    min_action_ms: d.minActionMs ?? 2000,
    max_action_ms: d.maxActionMs ?? 5000,
    min_typing_ms: d.minTypingMs ?? 220,
    max_typing_ms: d.maxTypingMs ?? 500,
    account_stagger_ms: config.accountStaggerMs ?? 45000,
  };
  if (DRY_RUN) {
    log('Would update settings:', JSON.stringify(patch));
    return;
  }
  db.updateSettings(patch);
  log('Settings migrated from config.json.');
}

function upsertAccount(acct) {
  const existing = db.getAccountByName(acct.name);

  const fields = {
    name: acct.name,
    email: acct.email || '',
    password_enc: acct.password ? encrypt(acct.password) : null,
    session_file: acct.sessionFile || `sessions/${acct.name}.json`,
    target_page_url: acct.targetPageUrl || '',
    own_profile_url: acct.ownProfileUrl || null,
    send_dm_to_commenters: acct.sendDmToCommenters ? 1 : 0,
    dm_as_page_url: acct.dmAsPageUrl || null,
    user_agent: acct.userAgent || null,
    locale: acct.locale || 'en-US',
    timezone_id: acct.timezoneId || 'America/New_York',
    check_interval_minutes: acct.checkIntervalMinutes ?? 7,
    proxy_server: acct.proxy?.server || null,
    proxy_username: acct.proxy?.username || null,
    proxy_password_enc: acct.proxy?.password ? encrypt(acct.proxy.password) : null,
  };

  if (DRY_RUN) {
    log(`Would ${existing ? 'update' : 'insert'} account "${acct.name}" (password ${acct.password ? 'ENCRYPTED' : 'none'})`);
    log(`  comments=${(acct.comments || []).length} replies=${(acct.replies || []).length} dm=${(acct.dmMessages || []).length} groups=${(acct.groups || []).length}`);
    return existing ? existing.id : -1;
  }

  let accountId;
  if (existing) {
    const cols = Object.keys(fields);
    const assignments = cols.map((c) => `${c} = @${c}`).join(', ');
    db.getDb()
      .prepare(`UPDATE accounts SET ${assignments}, updated_at = datetime('now') WHERE id = @id`)
      .run({ ...fields, id: existing.id });
    accountId = existing.id;
    log(`Updated account "${acct.name}" (id=${accountId}).`);
  } else {
    accountId = db.insertAccount(fields);
    log(`Inserted account "${acct.name}" (id=${accountId}).`);
  }

  db.setAccountComments(accountId, acct.comments || []);
  db.setAccountReplies(accountId, acct.replies || []);
  db.setAccountDmMessages(accountId, acct.dmMessages || []);
  db.setAccountGroups(accountId, acct.groups || []);

  return accountId;
}

function migrateState(acct, accountId) {
  if (accountId < 0) return; // dry-run with no existing row

  // last_post.txt
  const lastPostFile = acct.lastPostFile || `state/${acct.name}_last_post.txt`;
  if (exists(lastPostFile)) {
    const id = fs.readFileSync(path.resolve(lastPostFile), 'utf8').trim();
    if (id) {
      if (DRY_RUN) log(`  would set last_post_id="${id}"`);
      else db.setLastPostId(accountId, id);
    }
  }

  // shared_posts.json
  const sharedFile = `state/${acct.name}_shared_posts.json`;
  if (exists(sharedFile)) {
    const urls = readJson(path.resolve(sharedFile)) || [];
    if (DRY_RUN) log(`  would set ${urls.length} shared_posts`);
    else db.setSharedPosts(accountId, urls);
  }

  // dm_sent.json
  const dmFile = `state/${acct.name}_dm_sent.json`;
  if (exists(dmFile)) {
    const urls = readJson(path.resolve(dmFile)) || [];
    if (DRY_RUN) log(`  would add ${urls.length} dm_sent`);
    else urls.forEach((u) => db.addDmSent(accountId, u));
  }

  // seen_comments_<hash>.json — glob the state dir for this account's files
  const stateDir = path.resolve('state');
  if (exists('state')) {
    const prefix = `${acct.name}_seen_comments_`;
    const files = fs.readdirSync(stateDir).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
    let total = 0;
    for (const f of files) {
      const commentIds = readJson(path.join(stateDir, f)) || [];
      // We don't know the original post_url (it was hashed into the filename).
      // Preserve losslessly under a synthetic key derived from the file so the
      // data is retained; the worker re-keys by real post_url going forward.
      const syntheticPostKey = `legacy:${f.slice(prefix.length, -'.json'.length)}`;
      total += commentIds.length;
      if (!DRY_RUN) {
        commentIds.forEach((cid) => db.addSeenComment(accountId, syntheticPostKey, cid));
      }
    }
    if (files.length) {
      log(`  ${DRY_RUN ? 'would migrate' : 'migrated'} ${total} seen-comment ids from ${files.length} file(s)${DRY_RUN ? '' : ' (under legacy: keys)'}`);
    }
  }
}

function main() {
  log(DRY_RUN ? 'DRY RUN — no writes will be made.' : 'Starting migration...');

  if (!DRY_RUN && !require('./crypto').isKeyConfigured()) {
    console.error(
      '[MIGRATE] APP_ENCRYPTION_KEY is missing/invalid. Add a 64-hex key to .env first.\n' +
        '          Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
    process.exit(1);
  }

  // Initialize DB (applies schema, seeds singletons).
  if (!DRY_RUN) db.getDb();

  const config = exists('config.json') ? readJson('config.json') : null;
  migrateSettings(config);

  const accounts = exists('accounts.json') ? readJson('accounts.json') : null;
  if (!accounts || !Array.isArray(accounts)) {
    log('No accounts.json (array) found — nothing to migrate for accounts.');
  } else {
    log(`Found ${accounts.length} account(s) in accounts.json.`);
    for (const acct of accounts) {
      const accountId = upsertAccount(acct);
      migrateState(acct, accountId);
    }
  }

  if (!DRY_RUN) {
    const n = db.listAccounts().length;
    log(`Done. accounts in DB: ${n}. DB file: ${db.dbPath()}`);
    db.closeDb();
  } else {
    log('Dry run complete.');
  }
}

main();
