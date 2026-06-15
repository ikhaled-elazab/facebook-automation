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
const { migrateToV2, SCHEMA_VERSION_V2 } = require('./migrations/v2_branches');

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

/**
 * Ensure the account has exactly one is_default=1 branch carrying the per-target
 * fields from the legacy JSON account, and return its id. Idempotent: reuses an
 * existing default branch (updating its per-target fields) or creates one.
 * @param {number} accountId
 * @param {object} acct legacy JSON account
 * @returns {number} default branch id
 */
function ensureDefaultBranch(accountId, acct) {
  const branchFields = {
    target_page_url: acct.targetPageUrl || '',
    own_profile_url: acct.ownProfileUrl || null,
    send_dm_to_commenters: acct.sendDmToCommenters ? 1 : 0,
    dm_as_page_url: acct.dmAsPageUrl || null,
    check_interval_minutes: acct.checkIntervalMinutes ?? 7,
  };
  const existing = db.getDefaultBranch(accountId);
  if (existing) {
    db.updateBranch(existing.id, branchFields);
    return existing.id;
  }
  return db.insertBranch({
    account_id: accountId,
    name: 'default',
    is_default: 1,
    daily_action_cap: null, // inherit account ceiling (ban-safe)
    enabled: 1,
    ...branchFields,
  });
}

function upsertAccount(acct) {
  const existing = db.getAccountByName(acct.name);

  // Phase 2: accounts holds ONLY the login envelope. The per-target fields live
  // on the default branch (see ensureDefaultBranch). daily_action_cap (account
  // ceiling) stays here.
  const fields = {
    name: acct.name,
    email: acct.email || '',
    password_enc: acct.password ? encrypt(acct.password) : null,
    session_file: acct.sessionFile || `sessions/${acct.name}.json`,
    user_agent: acct.userAgent || null,
    locale: acct.locale || 'en-US',
    timezone_id: acct.timezoneId || 'America/New_York',
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

  // Per-target fields + content go on the account's default branch (Phase 2).
  const branchId = ensureDefaultBranch(accountId, acct);
  db.setBranchComments(branchId, acct.comments || []);
  db.setBranchReplies(branchId, acct.replies || []);
  db.setBranchDmMessages(branchId, acct.dmMessages || []);
  db.setBranchGroups(branchId, acct.groups || []);

  // Return BOTH ids: callers thread the branchId into migrateState (state is
  // branch-keyed) and may use accountId for logging.
  return { accountId, branchId };
}

function migrateState(acct, ids) {
  // ids may be {accountId, branchId} (real run) or -1 (dry-run with no row).
  if (!ids || ids === -1 || ids.branchId === undefined) return;
  const branchId = ids.branchId;

  // last_post.txt
  const lastPostFile = acct.lastPostFile || `state/${acct.name}_last_post.txt`;
  if (exists(lastPostFile)) {
    const id = fs.readFileSync(path.resolve(lastPostFile), 'utf8').trim();
    if (id) {
      if (DRY_RUN) log(`  would set last_post_id="${id}"`);
      else db.setLastPostId(branchId, id);
    }
  }

  // shared_posts.json
  const sharedFile = `state/${acct.name}_shared_posts.json`;
  if (exists(sharedFile)) {
    const urls = readJson(path.resolve(sharedFile)) || [];
    if (DRY_RUN) log(`  would set ${urls.length} shared_posts`);
    else db.setSharedPosts(branchId, urls);
  }

  // dm_sent.json
  const dmFile = `state/${acct.name}_dm_sent.json`;
  if (exists(dmFile)) {
    const urls = readJson(path.resolve(dmFile)) || [];
    if (DRY_RUN) log(`  would add ${urls.length} dm_sent`);
    else urls.forEach((u) => db.addDmSent(branchId, u));
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
        commentIds.forEach((cid) => db.addSeenComment(branchId, syntheticPostKey, cid));
      }
    }
    if (files.length) {
      log(`  ${DRY_RUN ? 'would migrate' : 'migrated'} ${total} seen-comment ids from ${files.length} file(s)${DRY_RUN ? '' : ' (under legacy: keys)'}`);
    }
  }
}

/**
 * BLOCKING-2 operational pre-flight for the v1 -> v2 schema migration.
 *
 * The v2 migration rebuilds 8 tables and drops 5 columns; it MUST run with the
 * worker + control-plane stopped, and against a checkpointed (non-WAL-divergent)
 * database. This:
 *   1. asserts the operator has stopped the worker + control-plane (we cannot
 *      truly enforce process-stop from here, so we document it loudly and rely on
 *      the WAL-quiescent check below as the observable proxy);
 *   2. runs wal_checkpoint(TRUNCATE) and verifies busy == 0 — a busy != 0 means
 *      another connection holds a read/write lock (worker still running) → ABORT;
 *   3. aborts if a -wal sidecar still persists with content after the checkpoint
 *      (the WAL did not fully fold back into the main db file).
 *
 * @param {import('better-sqlite3').Database} conn open handle to the live db
 * @param {string} dbFile the resolved db file path (to probe the -wal sidecar)
 * @throws {Error} if the pre-flight fails (caller must abort the migration)
 */
function preflightV2Checkpoint(conn, dbFile) {
  log('Pre-flight (BLOCKING-2): worker + control-plane MUST be stopped before this runs.');
  log('  (pm2 stop fb-worker fb-control)  — proceeding to verify the DB is quiescent.');

  // wal_checkpoint(TRUNCATE) returns one row [busy, log, checkpointed]. busy=1
  // means another connection blocked the checkpoint (a live writer) → abort.
  const res = conn.pragma('wal_checkpoint(TRUNCATE)');
  const row = Array.isArray(res) && res.length ? res[0] : null;
  const busy = row ? Number(row.busy) : 1; // missing row → treat as busy (fail safe)
  log(`  wal_checkpoint(TRUNCATE) => busy=${row ? row.busy : 'n/a'} log=${row ? row.log : 'n/a'} checkpointed=${row ? row.checkpointed : 'n/a'}`);
  if (busy !== 0) {
    throw new Error(
      'BLOCKING-2: wal_checkpoint reported busy != 0 — another connection holds a lock ' +
        '(worker/control-plane still running?). Stop them and retry. Migration aborted.'
    );
  }

  // After a TRUNCATE checkpoint the -wal sidecar should be empty (0 bytes) or
  // absent. A non-empty sidecar means the WAL did not fully fold back → abort.
  const walPath = `${dbFile}-wal`;
  if (fs.existsSync(walPath)) {
    const size = fs.statSync(walPath).size;
    if (size > 0) {
      throw new Error(
        `BLOCKING-2: -wal sidecar persists with ${size} byte(s) after checkpoint ` +
          `(${walPath}). The WAL did not fold back — a live writer is suspected. Migration aborted.`
      );
    }
  }
  log('  DB is quiescent (checkpoint clean, no persistent -wal). Safe to migrate.');
}

/**
 * Run the v1 -> v2 schema migration on a RAW connection to the DB file, BEFORE
 * db.getDb() is ever opened. This ordering is critical: db.getDb() applies the v2
 * schema.sql head (which creates branch_id indexes), and those CREATE INDEX
 * statements FAIL against a v1 table whose column is still account_id — so the
 * migration must re-key the tables FIRST. Behind the BLOCKING-2 pre-flight.
 * Idempotent (the version gate inside migrateToV2 makes a v2 DB a no-op). Honors
 * --dry-run (reports only). If the DB file does not exist yet, this is a no-op
 * (a brand-new DB is created at v2 directly by db.getDb()).
 */
function migrateSchemaToV2() {
  const file = db.dbPath();
  if (!fs.existsSync(file)) {
    log('No existing DB file — a fresh DB will be created at v2 directly. No upgrade needed.');
    return;
  }

  // Open a RAW connection (NOT db.getDb(), which would apply the v2 schema head).
  const Database = require('better-sqlite3');
  const conn = new Database(file);
  try {
    conn.pragma('journal_mode = WAL');
    conn.pragma('busy_timeout = 5000');

    const current = readVersionSafe(conn);
    if (current >= SCHEMA_VERSION_V2) {
      log(`Schema already at v${current} (>= ${SCHEMA_VERSION_V2}) — skipping v2 migration.`);
      return;
    }

    if (DRY_RUN) {
      log(`Would migrate schema v${current} -> v${SCHEMA_VERSION_V2} (multi-branch). Skipped (dry-run).`);
      return;
    }

    preflightV2Checkpoint(conn, file);
    const result = migrateToV2(conn, { log: (m) => log(m) });
    if (result.migrated) {
      log(`Schema migrated v${result.fromVersion} -> v${result.toVersion}.`);
    }
  } finally {
    conn.close();
  }
}

/** Read schema_meta.version defensively (0 if absent). */
function readVersionSafe(conn) {
  try {
    const row = conn.prepare(`SELECT version FROM schema_meta WHERE id = 1`).get();
    return row ? Number(row.version) : 0;
  } catch {
    return 0;
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

  // STEP 1: bring the SCHEMA to v2 FIRST, on a RAW connection BEFORE db.getDb().
  // An existing v1 DB is re-keyed onto default branches in place (behind the
  // BLOCKING-2 pre-flight); a brand-new DB is created at v2 by db.getDb() below.
  // This MUST precede db.getDb() — getDb() applies the v2 schema head whose
  // branch_id indexes fail against v1 (account_id) tables.
  if (!DRY_RUN) migrateSchemaToV2();

  // Initialize DB (applies the v2 schema head idempotently — now all columns
  // match — and seeds singleton rows). On a brand-new DB this creates v2 directly.
  if (!DRY_RUN) db.getDb();

  const config = exists('config.json') ? readJson('config.json') : null;
  migrateSettings(config);

  // STEP 2: legacy JSON import (v0 monolith files -> DB). Only does meaningful
  // work on a FRESH DB that has no accounts yet — it imports accounts.json into
  // accounts + a default branch + branch state. On an already-populated DB it is
  // skipped (the v2 migration above already handled the existing data).
  const accounts = exists('accounts.json') ? readJson('accounts.json') : null;
  const alreadyPopulated = (() => {
    try {
      return db.listAccounts().length > 0;
    } catch {
      return false;
    }
  })();

  if (!alreadyPopulated && Array.isArray(accounts)) {
    log(`Found ${accounts.length} account(s) in accounts.json — importing into a fresh v2 DB.`);
    for (const acct of accounts) {
      const ids = upsertAccount(acct);
      migrateState(acct, ids);
    }
  } else if (!Array.isArray(accounts)) {
    log('No accounts.json (array) found — nothing to import from legacy JSON.');
  } else {
    log('Skipping legacy JSON import (DB already populated).');
  }

  if (!DRY_RUN) {
    const n = db.listAccounts().length;
    log(`Done. accounts in DB: ${n}. DB file: ${db.dbPath()}`);
    db.closeDb();
  } else {
    log('Dry run complete.');
  }
}

// Auto-run only when invoked directly (node migrate.js). When required by a test
// (the v2 round-trip drives migrateToV2 against a temp DB directly), do NOT run
// main() at import time.
if (require.main === module) {
  main();
}

module.exports = {
  main,
  migrateSchemaToV2,
  preflightV2Checkpoint,
  readVersionSafe,
};
