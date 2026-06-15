'use strict';

/**
 * db.js — SQLite data-access layer (better-sqlite3).
 *
 * Single source of truth for DB access. Opens (and lazily initializes) the
 * database file, applies the schema idempotently, ensures singleton rows
 * (settings id=1, worker_state id=1), and exposes a small typed API used by
 * the worker, the migration script, and (later) the control-plane API.
 *
 * Path resolution:
 *   - DB_PATH env var if set, else ./db/fb-bot.db
 *
 * Concurrency: WAL mode (set in schema.sql) lets the control plane read while
 * the worker writes. better-sqlite3 is synchronous, which is fine for both
 * processes on a single VPS.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 1;

let _db = null;

function dbPath() {
  return process.env.DB_PATH || path.join(__dirname, 'db', 'fb-bot.db');
}

/**
 * Open (or return the cached) database connection, applying schema + seeds.
 * @returns {import('better-sqlite3').Database}
 */
function getDb() {
  if (_db) return _db;

  const file = dbPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // WAL permits a single writer at a time. Without a busy_timeout the worker and
  // control-plane processes get an immediate SQLITE_BUSY on concurrent writes;
  // 5s lets the second writer wait out the first. synchronous=NORMAL is the
  // recommended durability/throughput balance for WAL. Both are per-connection
  // pragmas (like foreign_keys), so they must be re-applied here on every open.
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  const schemaSql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  // Seed singleton rows if absent.
  db.prepare(
    `INSERT INTO schema_meta (id, version) VALUES (1, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(SCHEMA_VERSION);

  db.prepare(`INSERT INTO settings (id) VALUES (1) ON CONFLICT(id) DO NOTHING`).run();
  db.prepare(
    `INSERT INTO worker_state (id, desired_state, status) VALUES (1, 'stopped', 'stopped')
     ON CONFLICT(id) DO NOTHING`
  ).run();

  _db = db;
  return _db;
}

/** Close the connection (mainly for tests). */
function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ── Settings ────────────────────────────────────────────────────────────────

function getSettings() {
  return getDb().prepare(`SELECT * FROM settings WHERE id = 1`).get();
}

function updateSettings(patch) {
  const current = getSettings();
  const merged = { ...current, ...patch, id: 1, updated_at: new Date().toISOString() };
  const cols = Object.keys(merged).filter((k) => k !== 'id');
  const assignments = cols.map((c) => `${c} = @${c}`).join(', ');
  getDb().prepare(`UPDATE settings SET ${assignments} WHERE id = 1`).run(merged);
  return getSettings();
}

// ── Accounts ──────────────────────────────────────────────────────────────--

function getAccountByName(name) {
  return getDb().prepare(`SELECT * FROM accounts WHERE name = ?`).get(name);
}

function getAccountById(id) {
  return getDb().prepare(`SELECT * FROM accounts WHERE id = ?`).get(id);
}

function listAccounts({ enabledOnly = false } = {}) {
  const sql = enabledOnly
    ? `SELECT * FROM accounts WHERE enabled = 1 ORDER BY id`
    : `SELECT * FROM accounts ORDER BY id`;
  return getDb().prepare(sql).all();
}

/**
 * Insert an account row. `fields` keys map to columns directly.
 * Returns the new account id.
 */
function insertAccount(fields) {
  const cols = Object.keys(fields);
  const placeholders = cols.map((c) => `@${c}`).join(', ');
  const info = getDb()
    .prepare(`INSERT INTO accounts (${cols.join(', ')}) VALUES (${placeholders})`)
    .run(fields);
  return info.lastInsertRowid;
}

/**
 * Columns the control plane is permitted to UPDATE on accounts. This is an
 * INDEPENDENT, second guard beyond the zod schema (defense in depth): even if a
 * caller hands updateAccount() a key, it never reaches the dynamic SET clause
 * unless it is on this frozen allowlist. `password_enc` / `proxy_password_enc`
 * ARE allowed because the route encrypts plaintext into them; `id`/`created_at`
 * are never updatable.
 */
const ACCOUNT_UPDATE_COLUMNS = Object.freeze([
  'name',
  'email',
  'password_enc',
  'session_file',
  'target_page_url',
  'own_profile_url',
  'send_dm_to_commenters',
  'dm_as_page_url',
  'user_agent',
  'locale',
  'timezone_id',
  'check_interval_minutes',
  'proxy_server',
  'proxy_username',
  'proxy_password_enc',
  'daily_action_cap',
  'enabled',
]);

const ACCOUNT_UPDATE_SET = new Set(ACCOUNT_UPDATE_COLUMNS);

/**
 * Update writable columns on an account. Always bumps updated_at.
 *
 * SECURITY: the SET clause is built ONLY from keys present in the frozen
 * ACCOUNT_UPDATE_COLUMNS allowlist — NOT from arbitrary caller keys — and every
 * value binds as a named parameter. A key outside the allowlist is a programming
 * error and throws (it must never silently reach the dynamic SQL builder).
 * @param {number} accountId
 * @param {Record<string, unknown>} columns  already-validated column->value map
 * @returns {boolean} true if a row was updated
 * @throws {Error} if any column is outside the allowlist (programming error)
 */
function updateAccount(accountId, columns) {
  const keys = Object.keys(columns).filter((k) => ACCOUNT_UPDATE_SET.has(k));
  // Reject any key the caller tried to set that is NOT in the allowlist.
  const rejected = Object.keys(columns).filter((k) => !ACCOUNT_UPDATE_SET.has(k));
  if (rejected.length > 0) {
    throw new Error(`updateAccount: disallowed column(s): ${rejected.join(', ')}`);
  }
  if (keys.length === 0) return false;

  const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
  const params = {};
  for (const k of keys) params[k] = columns[k];
  params.id = accountId;

  const info = getDb()
    .prepare(
      `UPDATE accounts SET ${assignments}, updated_at = datetime('now') WHERE id = @id`
    )
    .run(params);
  return info.changes > 0;
}

/**
 * Delete an account by id. Child collections + state rows cascade via the
 * ON DELETE CASCADE foreign keys defined in schema.sql.
 * @param {number} accountId
 * @returns {boolean} true if a row was deleted
 */
function deleteAccount(accountId) {
  const info = getDb().prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  return info.changes > 0;
}

// ── Account child collections (comments/replies/dm_messages/groups) ──────────

function replaceChildText(table, accountId, items) {
  const db = getDb();
  db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId);
  const ins = db.prepare(
    `INSERT INTO ${table} (account_id, text, position) VALUES (?, ?, ?)`
  );
  const tx = db.transaction((rows) => {
    rows.forEach((text, i) => ins.run(accountId, text, i));
  });
  tx(items || []);
}

function setAccountComments(accountId, items) {
  replaceChildText('account_comments', accountId, items);
}
function setAccountReplies(accountId, items) {
  replaceChildText('account_replies', accountId, items);
}
function setAccountDmMessages(accountId, items) {
  replaceChildText('account_dm_messages', accountId, items);
}
function setAccountGroups(accountId, urls) {
  const db = getDb();
  db.prepare(`DELETE FROM account_groups WHERE account_id = ?`).run(accountId);
  const ins = db.prepare(
    `INSERT INTO account_groups (account_id, url, position) VALUES (?, ?, ?)`
  );
  const tx = db.transaction((rows) => {
    rows.forEach((url, i) => ins.run(accountId, url, i));
  });
  tx(urls || []);
}

function getAccountChildText(table, accountId) {
  return getDb()
    .prepare(`SELECT text FROM ${table} WHERE account_id = ? ORDER BY position`)
    .all(accountId)
    .map((r) => r.text);
}
function getAccountComments(accountId) {
  return getAccountChildText('account_comments', accountId);
}
function getAccountReplies(accountId) {
  return getAccountChildText('account_replies', accountId);
}
function getAccountDmMessages(accountId) {
  return getAccountChildText('account_dm_messages', accountId);
}
function getAccountGroups(accountId) {
  return getDb()
    .prepare(`SELECT url FROM account_groups WHERE account_id = ? ORDER BY position`)
    .all(accountId)
    .map((r) => r.url);
}

// ── Runtime state ────────────────────────────────────────────────────────────

function getAccountState(accountId) {
  return getDb().prepare(`SELECT * FROM account_state WHERE account_id = ?`).get(accountId);
}

function setLastPostId(accountId, lastPostId) {
  getDb()
    .prepare(
      `INSERT INTO account_state (account_id, last_post_id, updated_at)
       VALUES (@account_id, @last_post_id, datetime('now'))
       ON CONFLICT(account_id) DO UPDATE SET
         last_post_id = @last_post_id, updated_at = datetime('now')`
    )
    .run({ account_id: accountId, last_post_id: lastPostId });
}

function getSharedPosts(accountId) {
  const row = getAccountState(accountId);
  if (!row || !row.shared_posts) return [];
  try {
    return JSON.parse(row.shared_posts);
  } catch {
    return [];
  }
}

function setSharedPosts(accountId, urls) {
  getDb()
    .prepare(
      `INSERT INTO account_state (account_id, shared_posts, updated_at)
       VALUES (@account_id, @shared_posts, datetime('now'))
       ON CONFLICT(account_id) DO UPDATE SET
         shared_posts = @shared_posts, updated_at = datetime('now')`
    )
    .run({ account_id: accountId, shared_posts: JSON.stringify(urls || []) });
}

// ── seen_comments ────────────────────────────────────────────────────────────

function getSeenComments(accountId, postUrl) {
  const rows = getDb()
    .prepare(`SELECT comment_id FROM seen_comments WHERE account_id = ? AND post_url = ?`)
    .all(accountId, postUrl);
  return new Set(rows.map((r) => r.comment_id));
}

function addSeenComment(accountId, postUrl, commentId) {
  getDb()
    .prepare(
      `INSERT INTO seen_comments (account_id, post_url, comment_id) VALUES (?, ?, ?)
       ON CONFLICT(account_id, post_url, comment_id) DO NOTHING`
    )
    .run(accountId, postUrl, commentId);
}

// ── dm_sent ──────────────────────────────────────────────────────────────────

function getDmSent(accountId) {
  const rows = getDb()
    .prepare(`SELECT profile_url FROM dm_sent WHERE account_id = ?`)
    .all(accountId);
  return new Set(rows.map((r) => r.profile_url));
}

function addDmSent(accountId, profileUrl) {
  getDb()
    .prepare(
      `INSERT INTO dm_sent (account_id, profile_url) VALUES (?, ?)
       ON CONFLICT(account_id, profile_url) DO NOTHING`
    )
    .run(accountId, profileUrl);
}

// ── action_log (feeds P5 governor + UI events) ───────────────────────────────

function logAction({ accountId = null, actionType, targetUrl = null, status = 'ok', detail = null }) {
  getDb()
    .prepare(
      `INSERT INTO action_log (account_id, action_type, target_url, status, detail)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(accountId, actionType, targetUrl, status, detail);
}

// Local-day window bounds, expressed back in UTC so they compare directly
// against the UTC-stored created_at (datetime('now') is UTC). Computing the
// local day then converting its midnight boundaries to UTC keeps created_at
// BARE in the predicate — so the query stays SARGABLE and uses the index range
// scan — while being correct across the server's UTC offset (a row logged at
// 23:30 local is bucketed into the local day, not the UTC day). EXPLAIN QUERY
// PLAN confirms: global → idx_action_log_created; per-account → idx_action_log_acct_day.
const LOCAL_DAY_START_UTC = `datetime('now','localtime','start of day','utc')`;
const LOCAL_DAY_END_UTC = `datetime('now','localtime','start of day','+1 day','utc')`;

/**
 * Count today's successful (status='ok') actions, scoped to a single account or
 * — when accountId is null/undefined — globally across all accounts (the global
 * daily-cap path). The day is the SERVER-LOCAL calendar day, the same basis the
 * governor's active-hours window uses, so caps and windows never disagree on
 * "today". Only status='ok' rows count toward a cap (skipped/failed don't).
 *
 * The query is sargable (created_at appears bare against index-friendly bounds):
 *   - with accountId → uses idx_action_log_acct_day (account_id, created_at)
 *   - global         → uses idx_action_log_created (created_at)
 *
 * DST CAVEAT: the local-day→UTC window (datetime('now','localtime','start of
 * day','utc')) is computed at query time using the CURRENT offset. On a DST-
 * change night the day's true span is 23h or 25h, so the window can be off by ±1h
 * for rows logged in the transition hour. This is harmless for daily action caps
 * (a ~1h boundary fuzz once or twice a year never lets an account materially
 * exceed its cap) and is intentionally left uncorrected — fixing it would cost
 * sargability. Do NOT "fix" the query without re-checking EXPLAIN QUERY PLAN.
 *
 * @param {number|null} [accountId] account to scope to, or null/omitted for global
 * @returns {number} today's ok-action count
 */
function countActionsToday(accountId) {
  const hasAccount = accountId !== undefined && accountId !== null;
  if (hasAccount) {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM action_log
         WHERE account_id = ? AND status = 'ok'
           AND created_at >= ${LOCAL_DAY_START_UTC}
           AND created_at <  ${LOCAL_DAY_END_UTC}`
      )
      .get(accountId);
    return row ? row.n : 0;
  }
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM action_log
       WHERE status = 'ok'
         AND created_at >= ${LOCAL_DAY_START_UTC}
         AND created_at <  ${LOCAL_DAY_END_UTC}`
    )
    .get();
  return row ? row.n : 0;
}

/**
 * Delete action_log rows older than `days` days (retention — prevents unbounded
 * growth, which would otherwise compound the cost of the daily-cap index scans).
 * The cutoff is bare-comparable against the UTC-stored created_at and is a fixed
 * SQL fragment with `days` bound as a parameter (no interpolation).
 * @param {number} days keep rows newer than this many days (default 30); a
 *   non-positive or non-finite value is coerced to 30 (never deletes everything)
 * @returns {number} number of rows deleted
 */
function trimActionLog(days = 30) {
  const n = Number(days);
  const keepDays = Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
  const info = getDb()
    .prepare(`DELETE FROM action_log WHERE created_at < datetime('now', ?)`)
    .run(`-${keepDays} days`);
  return info.changes;
}

/**
 * Read a page of recent action_log rows for the dashboard feed, newest first
 * (DESC by id, which is monotonic and a stable cursor — created_at can tie at
 * 1s resolution, id never does).
 *
 * Cursor pagination: pass `before` = the smallest `id` from the previous page to
 * fetch strictly-older rows. We over-fetch by one row to determine has_more
 * without a second COUNT, then also return the unfiltered `total` so the UI can
 * show "N events" and decide whether older pages exist.
 *
 * @param {{limit?:number, accountId?:number, before?:number}} [opts]
 * @returns {{events:Array<Record<string, unknown>>, total:number, has_more:boolean, next_before:number|null}}
 */
function recentActions({ limit = 50, accountId, before } = {}) {
  const conn = getDb();
  const hasAccount = accountId !== undefined && accountId !== null;
  const hasBefore = before !== undefined && before !== null;

  // Build the WHERE clause from fixed fragments only; all values bind as params.
  const where = [];
  const params = [];
  if (hasAccount) {
    where.push('account_id = ?');
    params.push(accountId);
  }
  if (hasBefore) {
    where.push('id < ?');
    params.push(before);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  // Over-fetch one row to detect a further page without a second query.
  const pageRows = conn
    .prepare(
      `SELECT id, account_id, action_type, target_url, status, detail, created_at
       FROM action_log ${whereSql} ORDER BY id DESC LIMIT ?`
    )
    .all(...params, limit + 1);

  const has_more = pageRows.length > limit;
  const events = has_more ? pageRows.slice(0, limit) : pageRows;
  const next_before = has_more ? events[events.length - 1].id : null;

  // total is scoped to the account filter (if any) but ignores the cursor — it is
  // the size of the whole feed the UI is paging through, not just this page.
  const totalWhere = hasAccount ? 'WHERE account_id = ?' : '';
  const totalParams = hasAccount ? [accountId] : [];
  const totalRow = conn
    .prepare(`SELECT COUNT(*) AS n FROM action_log ${totalWhere}`)
    .get(...totalParams);

  return {
    events,
    total: totalRow ? totalRow.n : 0,
    has_more,
    next_before,
  };
}

// ── worker_state (control-plane coordination) ────────────────────────────────

function getWorkerState() {
  return getDb().prepare(`SELECT * FROM worker_state WHERE id = 1`).get();
}

function setDesiredState(state) {
  getDb()
    .prepare(`UPDATE worker_state SET desired_state = ?, updated_at = datetime('now') WHERE id = 1`)
    .run(state);
}

function heartbeat(status, detail = null) {
  getDb()
    .prepare(
      `UPDATE worker_state SET status = ?, detail = ?,
         last_heartbeat = datetime('now'), updated_at = datetime('now') WHERE id = 1`
    )
    .run(status, detail);
}

// ── account_status (per-account cycle status — fixes single-row heartbeat) ────

/**
 * Record a single account's last cycle status. Upserts ONE row per account, so
 * account B's 'error' is never clobbered by account A's 'running' (the single
 * worker_state row keeps the global process-liveness contract; this gives
 * per-account observability the dashboard's per-account summary surfaces).
 * `last_cycle_at` is bumped only on terminal cycle outcomes (ok|error), not on
 * the transient 'running' marker, so it reflects the last COMPLETED cycle.
 * @param {number} accountId
 * @param {string} status idle | running | ok | error | paused
 * @param {string|null} [detail]
 */
function setAccountStatus(accountId, status, detail = null) {
  const bumpCycle = status === 'ok' || status === 'error';
  getDb()
    .prepare(
      `INSERT INTO account_status (account_id, status, detail, last_cycle_at, updated_at)
       VALUES (@account_id, @status, @detail,
               CASE WHEN @bump = 1 THEN datetime('now') ELSE NULL END,
               datetime('now'))
       ON CONFLICT(account_id) DO UPDATE SET
         status = @status,
         detail = @detail,
         last_cycle_at = CASE WHEN @bump = 1 THEN datetime('now') ELSE last_cycle_at END,
         updated_at = datetime('now')`
    )
    .run({ account_id: accountId, status, detail, bump: bumpCycle ? 1 : 0 });
}

/**
 * Read one account's status row (or undefined if the account has never run).
 * @param {number} accountId
 * @returns {Record<string, unknown>|undefined}
 */
function getAccountStatus(accountId) {
  return getDb().prepare(`SELECT * FROM account_status WHERE account_id = ?`).get(accountId);
}

/**
 * Read all per-account status rows (for the dashboard per-account summary).
 * @returns {Array<Record<string, unknown>>}
 */
function listAccountStatuses() {
  return getDb().prepare(`SELECT * FROM account_status ORDER BY account_id`).all();
}

module.exports = {
  getDb,
  closeDb,
  dbPath,
  SCHEMA_VERSION,
  // settings
  getSettings,
  updateSettings,
  // accounts
  getAccountByName,
  getAccountById,
  listAccounts,
  insertAccount,
  updateAccount,
  deleteAccount,
  ACCOUNT_UPDATE_COLUMNS,
  // children
  setAccountComments,
  setAccountReplies,
  setAccountDmMessages,
  setAccountGroups,
  getAccountComments,
  getAccountReplies,
  getAccountDmMessages,
  getAccountGroups,
  // state
  getAccountState,
  setLastPostId,
  getSharedPosts,
  setSharedPosts,
  getSeenComments,
  addSeenComment,
  getDmSent,
  addDmSent,
  // action log
  logAction,
  countActionsToday,
  trimActionLog,
  recentActions,
  // worker state
  getWorkerState,
  setDesiredState,
  heartbeat,
  // per-account status
  setAccountStatus,
  getAccountStatus,
  listAccountStatuses,
};
