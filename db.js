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

const SCHEMA_VERSION = 2;

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
// Phase 2: the 5 per-target columns (target_page_url, own_profile_url,
// send_dm_to_commenters, dm_as_page_url, check_interval_minutes) MOVED to
// branches and are NOT updatable here. daily_action_cap STAYS (per-account
// ceiling). Branch-owned writable columns live on BRANCH_UPDATE_COLUMNS below.
const ACCOUNT_UPDATE_COLUMNS = Object.freeze([
  'name',
  'email',
  'password_enc',
  'session_file',
  'user_agent',
  'locale',
  'timezone_id',
  'proxy_server',
  'proxy_username',
  'proxy_password_enc',
  'daily_action_cap',
  'enabled',
]);

const ACCOUNT_UPDATE_SET = new Set(ACCOUNT_UPDATE_COLUMNS);

/**
 * Columns the control plane is permitted to UPDATE on branches. Same defense-in-
 * depth contract as ACCOUNT_UPDATE_COLUMNS: a frozen allowlist gating the dynamic
 * SET clause. `account_id` is never updatable (a branch cannot be re-parented),
 * `is_default` is managed via a dedicated path (setDefaultBranch) to preserve the
 * one-default-per-account invariant, and `id`/`created_at` are never updatable.
 */
const BRANCH_UPDATE_COLUMNS = Object.freeze([
  'name',
  'target_page_url',
  'own_profile_url',
  'send_dm_to_commenters',
  'dm_as_page_url',
  'check_interval_minutes',
  'daily_action_cap',
  'enabled',
]);

const BRANCH_UPDATE_SET = new Set(BRANCH_UPDATE_COLUMNS);

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

// ── Branches (1:N off accounts — the monitoring unit) ─────────────────────────

function getBranchById(branchId) {
  return getDb().prepare(`SELECT * FROM branches WHERE id = ?`).get(branchId);
}

/**
 * List branches, optionally scoped to one account and/or only enabled rows.
 * @param {{accountId?: number, enabledOnly?: boolean}} [opts]
 * @returns {Array<Record<string, unknown>>} ordered by (account_id, id)
 */
function listBranches({ accountId, enabledOnly = false } = {}) {
  const where = [];
  const params = [];
  if (accountId !== undefined && accountId !== null) {
    where.push('account_id = ?');
    params.push(accountId);
  }
  if (enabledOnly) where.push('enabled = 1');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return getDb()
    .prepare(`SELECT * FROM branches ${whereSql} ORDER BY account_id, id`)
    .all(...params);
}

/**
 * Count branches grouped by owning account, in a SINGLE query. Returns a Map of
 * account_id -> branch count. Accounts with zero branches are simply absent from
 * the map (the caller defaults them to 0). This backs the accounts LIST endpoint
 * so it can emit branch_count without N per-account queries (the list is the hot
 * path); single-account routes use listBranches({accountId}).length instead.
 * @returns {Map<number, number>}
 */
function countBranchesByAccount() {
  const rows = getDb()
    .prepare(`SELECT account_id, COUNT(*) AS n FROM branches GROUP BY account_id`)
    .all();
  const map = new Map();
  for (const r of rows) map.set(r.account_id, r.n);
  return map;
}

/** The default (is_default=1) branch for an account, or undefined. */
function getDefaultBranch(accountId) {
  return getDb()
    .prepare(`SELECT * FROM branches WHERE account_id = ? AND is_default = 1`)
    .get(accountId);
}

/**
 * Insert a branch row. `fields` keys map to columns directly; account_id + name
 * are required. Returns the new branch id. (The control plane should validate
 * inputs upstream; this is the low-level writer.)
 * @param {Record<string, unknown>} fields
 * @returns {number} new branch id
 */
function insertBranch(fields) {
  const cols = Object.keys(fields);
  const placeholders = cols.map((c) => `@${c}`).join(', ');
  const info = getDb()
    .prepare(`INSERT INTO branches (${cols.join(', ')}) VALUES (${placeholders})`)
    .run(fields);
  return info.lastInsertRowid;
}

/**
 * Update writable columns on a branch (frozen BRANCH_UPDATE_COLUMNS allowlist —
 * same defense-in-depth contract as updateAccount). Always bumps updated_at.
 * @param {number} branchId
 * @param {Record<string, unknown>} columns already-validated column->value map
 * @returns {boolean} true if a row was updated
 * @throws {Error} if any column is outside the allowlist (programming error)
 */
function updateBranch(branchId, columns) {
  const keys = Object.keys(columns).filter((k) => BRANCH_UPDATE_SET.has(k));
  const rejected = Object.keys(columns).filter((k) => !BRANCH_UPDATE_SET.has(k));
  if (rejected.length > 0) {
    throw new Error(`updateBranch: disallowed column(s): ${rejected.join(', ')}`);
  }
  if (keys.length === 0) return false;

  const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
  const params = {};
  for (const k of keys) params[k] = columns[k];
  params.id = branchId;

  const info = getDb()
    .prepare(`UPDATE branches SET ${assignments}, updated_at = datetime('now') WHERE id = @id`)
    .run(params);
  return info.changes > 0;
}

/**
 * Delete a branch. Child + state rows cascade. GUARD: refuses to delete the
 * is_default=1 branch (every account must always retain its default branch — a
 * deleted default would orphan the account's monitoring + violate the seed
 * invariant). Promote another branch to default first if you must remove it.
 * @param {number} branchId
 * @returns {boolean} true if a row was deleted
 * @throws {Error} if the branch is the account's default branch
 */
function deleteBranch(branchId) {
  const row = getBranchById(branchId);
  if (!row) return false;
  if (row.is_default) {
    throw new Error(
      `deleteBranch: branch ${branchId} is the account's default branch — promote ` +
        `another branch to default before deleting it.`
    );
  }
  const info = getDb().prepare(`DELETE FROM branches WHERE id = ?`).run(branchId);
  return info.changes > 0;
}

/**
 * Atomically make `branchId` the sole default for its account: clear the current
 * default, set this one. Wrapped in a transaction so the partial unique index
 * (uq_branches_one_default_per_account) is never transiently violated.
 * @param {number} branchId
 * @returns {boolean} true if the branch was promoted
 * @throws {Error} if the branch does not exist
 */
function setDefaultBranch(branchId) {
  const conn = getDb();
  const row = getBranchById(branchId);
  if (!row) throw new Error(`setDefaultBranch: branch ${branchId} not found`);
  const tx = conn.transaction(() => {
    conn
      .prepare(
        `UPDATE branches SET is_default = 0, updated_at = datetime('now')
         WHERE account_id = ? AND is_default = 1 AND id != ?`
      )
      .run(row.account_id, branchId);
    conn
      .prepare(`UPDATE branches SET is_default = 1, updated_at = datetime('now') WHERE id = ?`)
      .run(branchId);
  });
  tx();
  return true;
}

// ── Branch child collections (comments/replies/dm_messages/groups) ───────────

function replaceChildText(table, branchId, items) {
  const db = getDb();
  db.prepare(`DELETE FROM ${table} WHERE branch_id = ?`).run(branchId);
  const ins = db.prepare(
    `INSERT INTO ${table} (branch_id, text, position) VALUES (?, ?, ?)`
  );
  const tx = db.transaction((rows) => {
    rows.forEach((text, i) => ins.run(branchId, text, i));
  });
  tx(items || []);
}

function setBranchComments(branchId, items) {
  replaceChildText('account_comments', branchId, items);
}
function setBranchReplies(branchId, items) {
  replaceChildText('account_replies', branchId, items);
}
function setBranchDmMessages(branchId, items) {
  replaceChildText('account_dm_messages', branchId, items);
}
function setBranchGroups(branchId, urls) {
  const db = getDb();
  db.prepare(`DELETE FROM account_groups WHERE branch_id = ?`).run(branchId);
  const ins = db.prepare(
    `INSERT INTO account_groups (branch_id, url, position) VALUES (?, ?, ?)`
  );
  const tx = db.transaction((rows) => {
    rows.forEach((url, i) => ins.run(branchId, url, i));
  });
  tx(urls || []);
}

function getBranchChildText(table, branchId) {
  return getDb()
    .prepare(`SELECT text FROM ${table} WHERE branch_id = ? ORDER BY position`)
    .all(branchId)
    .map((r) => r.text);
}
function getBranchComments(branchId) {
  return getBranchChildText('account_comments', branchId);
}
function getBranchReplies(branchId) {
  return getBranchChildText('account_replies', branchId);
}
function getBranchDmMessages(branchId) {
  return getBranchChildText('account_dm_messages', branchId);
}
function getBranchGroups(branchId) {
  return getDb()
    .prepare(`SELECT url FROM account_groups WHERE branch_id = ? ORDER BY position`)
    .all(branchId)
    .map((r) => r.url);
}

// ── Runtime state (keyed by branch_id since Phase 2) ─────────────────────────

function getBranchState(branchId) {
  return getDb().prepare(`SELECT * FROM account_state WHERE branch_id = ?`).get(branchId);
}

function setLastPostId(branchId, lastPostId) {
  getDb()
    .prepare(
      `INSERT INTO account_state (branch_id, last_post_id, updated_at)
       VALUES (@branch_id, @last_post_id, datetime('now'))
       ON CONFLICT(branch_id) DO UPDATE SET
         last_post_id = @last_post_id, updated_at = datetime('now')`
    )
    .run({ branch_id: branchId, last_post_id: lastPostId });
}

function getSharedPosts(branchId) {
  const row = getBranchState(branchId);
  if (!row || !row.shared_posts) return [];
  try {
    return JSON.parse(row.shared_posts);
  } catch {
    return [];
  }
}

function setSharedPosts(branchId, urls) {
  getDb()
    .prepare(
      `INSERT INTO account_state (branch_id, shared_posts, updated_at)
       VALUES (@branch_id, @shared_posts, datetime('now'))
       ON CONFLICT(branch_id) DO UPDATE SET
         shared_posts = @shared_posts, updated_at = datetime('now')`
    )
    .run({ branch_id: branchId, shared_posts: JSON.stringify(urls || []) });
}

// ── seen_comments (keyed by branch_id since Phase 2) ─────────────────────────

function getSeenComments(branchId, postUrl) {
  const rows = getDb()
    .prepare(`SELECT comment_id FROM seen_comments WHERE branch_id = ? AND post_url = ?`)
    .all(branchId, postUrl);
  return new Set(rows.map((r) => r.comment_id));
}

function addSeenComment(branchId, postUrl, commentId) {
  getDb()
    .prepare(
      `INSERT INTO seen_comments (branch_id, post_url, comment_id) VALUES (?, ?, ?)
       ON CONFLICT(branch_id, post_url, comment_id) DO NOTHING`
    )
    .run(branchId, postUrl, commentId);
}

// ── dm_sent (keyed by branch_id since Phase 2) ───────────────────────────────

function getDmSent(branchId) {
  const rows = getDb()
    .prepare(`SELECT profile_url FROM dm_sent WHERE branch_id = ?`)
    .all(branchId);
  return new Set(rows.map((r) => r.profile_url));
}

function addDmSent(branchId, profileUrl) {
  getDb()
    .prepare(
      `INSERT INTO dm_sent (branch_id, profile_url) VALUES (?, ?)
       ON CONFLICT(branch_id, profile_url) DO NOTHING`
    )
    .run(branchId, profileUrl);
}

// ── action_log (feeds P5 governor + UI events) ───────────────────────────────

/**
 * Append an action_log row. Phase 2: carries BOTH branchId (the monitoring unit,
 * for the per-branch cap + UI drill-down) and accountId (the login, for the
 * per-account ceiling sum). Either may be null. When only branchId is supplied we
 * resolve its owning accountId so the per-account ceiling stays accurate without
 * the caller having to thread both — and vice-versa is left to the caller.
 * @param {{branchId?: number|null, accountId?: number|null, actionType: string,
 *   targetUrl?: string|null, status?: string, detail?: string|null}} entry
 */
function logAction({ branchId = null, accountId = null, actionType, targetUrl = null, status = 'ok', detail = null }) {
  let acct = accountId;
  // If the caller gave a branch but no account, resolve the owning account so the
  // per-account ceiling count (which sums across the account's branches) is whole.
  if ((acct === null || acct === undefined) && branchId !== null && branchId !== undefined) {
    const b = getBranchById(branchId);
    if (b) acct = b.account_id;
  }
  getDb()
    .prepare(
      `INSERT INTO action_log (account_id, branch_id, action_type, target_url, status, detail)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(acct ?? null, branchId ?? null, actionType, targetUrl, status, detail);
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
 * Phase 2: this remains the per-ACCOUNT-ceiling / global tier. The per-BRANCH
 * tier is countBranchActionsToday(branchId) below (uses idx_action_log_branch_day).
 * The per-account count sums across ALL the account's branches because every
 * action_log row carries the owning account_id (resolved in logAction).
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
 * Count today's successful (status='ok') actions for a single BRANCH — the
 * per-branch cap tier of the three-tier hierarchy. Sargable against
 * idx_action_log_branch_day (branch_id, created_at). Same local-day basis and DST
 * caveat as countActionsToday.
 * @param {number} branchId branch to scope to (required)
 * @returns {number} today's ok-action count for the branch
 */
function countBranchActionsToday(branchId) {
  if (branchId === undefined || branchId === null) return 0;
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM action_log
       WHERE branch_id = ? AND status = 'ok'
         AND created_at >= ${LOCAL_DAY_START_UTC}
         AND created_at <  ${LOCAL_DAY_END_UTC}`
    )
    .get(branchId);
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
 * Phase 2: an optional `branchId` filter drills the feed down to one branch
 * (additive — `accountId` still works and is the broader scope). The row shape
 * now also carries branch_id so the UI can label which branch an event came from.
 *
 * @param {{limit?:number, accountId?:number, branchId?:number, before?:number}} [opts]
 * @returns {{events:Array<Record<string, unknown>>, total:number, has_more:boolean, next_before:number|null}}
 */
function recentActions({ limit = 50, accountId, branchId, before } = {}) {
  const conn = getDb();
  const hasAccount = accountId !== undefined && accountId !== null;
  const hasBranch = branchId !== undefined && branchId !== null;
  const hasBefore = before !== undefined && before !== null;

  // Build the WHERE clause from fixed fragments only; all values bind as params.
  const where = [];
  const params = [];
  if (hasAccount) {
    where.push('account_id = ?');
    params.push(accountId);
  }
  if (hasBranch) {
    where.push('branch_id = ?');
    params.push(branchId);
  }
  if (hasBefore) {
    where.push('id < ?');
    params.push(before);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  // Over-fetch one row to detect a further page without a second query.
  const pageRows = conn
    .prepare(
      `SELECT id, account_id, branch_id, action_type, target_url, status, detail, created_at
       FROM action_log ${whereSql} ORDER BY id DESC LIMIT ?`
    )
    .all(...params, limit + 1);

  const has_more = pageRows.length > limit;
  const events = has_more ? pageRows.slice(0, limit) : pageRows;
  const next_before = has_more ? events[events.length - 1].id : null;

  // total is scoped to the same account/branch filter (if any) but ignores the
  // cursor — it is the size of the whole feed the UI is paging through.
  const totalWhere = [];
  const totalParams = [];
  if (hasAccount) {
    totalWhere.push('account_id = ?');
    totalParams.push(accountId);
  }
  if (hasBranch) {
    totalWhere.push('branch_id = ?');
    totalParams.push(branchId);
  }
  const totalWhereSql = totalWhere.length ? `WHERE ${totalWhere.join(' AND ')}` : '';
  const totalRow = conn
    .prepare(`SELECT COUNT(*) AS n FROM action_log ${totalWhereSql}`)
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

// ── account_status (per-BRANCH cycle status — fixes single-row heartbeat) ─────

/**
 * Record a single BRANCH's last cycle status. Upserts ONE row per branch, so
 * branch B's 'error' is never clobbered by branch A's 'running' (the single
 * worker_state row keeps the global process-liveness contract; this gives
 * per-branch observability the dashboard's per-branch summary surfaces).
 * `last_cycle_at` is bumped only on terminal cycle outcomes (ok|error), not on
 * the transient 'running' marker, so it reflects the last COMPLETED cycle.
 *
 * Phase 2: keyed by branch_id (was account_id). The function name is preserved
 * (setBranchStatus is the alias) so callers can migrate at their own pace.
 * @param {number} branchId
 * @param {string} status idle | running | ok | error | paused
 * @param {string|null} [detail]
 */
function setBranchStatus(branchId, status, detail = null) {
  const bumpCycle = status === 'ok' || status === 'error';
  getDb()
    .prepare(
      `INSERT INTO account_status (branch_id, status, detail, last_cycle_at, updated_at)
       VALUES (@branch_id, @status, @detail,
               CASE WHEN @bump = 1 THEN datetime('now') ELSE NULL END,
               datetime('now'))
       ON CONFLICT(branch_id) DO UPDATE SET
         status = @status,
         detail = @detail,
         last_cycle_at = CASE WHEN @bump = 1 THEN datetime('now') ELSE last_cycle_at END,
         updated_at = datetime('now')`
    )
    .run({ branch_id: branchId, status, detail, bump: bumpCycle ? 1 : 0 });
}

/**
 * Read one branch's status row (or undefined if the branch has never run).
 * @param {number} branchId
 * @returns {Record<string, unknown>|undefined}
 */
function getBranchStatus(branchId) {
  return getDb().prepare(`SELECT * FROM account_status WHERE branch_id = ?`).get(branchId);
}

/**
 * Read all per-branch status rows (for the dashboard per-branch summary).
 * @returns {Array<Record<string, unknown>>}
 */
function listBranchStatuses() {
  return getDb().prepare(`SELECT * FROM account_status ORDER BY branch_id`).all();
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
  // branches
  getBranchById,
  listBranches,
  countBranchesByAccount,
  getDefaultBranch,
  insertBranch,
  updateBranch,
  deleteBranch,
  setDefaultBranch,
  BRANCH_UPDATE_COLUMNS,
  // branch children
  setBranchComments,
  setBranchReplies,
  setBranchDmMessages,
  setBranchGroups,
  getBranchComments,
  getBranchReplies,
  getBranchDmMessages,
  getBranchGroups,
  // branch state
  getBranchState,
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
  countBranchActionsToday,
  trimActionLog,
  recentActions,
  // worker state
  getWorkerState,
  setDesiredState,
  heartbeat,
  // per-branch status
  setBranchStatus,
  getBranchStatus,
  listBranchStatuses,
};
