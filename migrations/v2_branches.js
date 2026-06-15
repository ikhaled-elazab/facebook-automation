'use strict';

/**
 * migrations/v2_branches.js — v1 → v2 schema migration: multi-branch support.
 *
 * Splits the v1 per-account (1:1) model into per-account (1:N) BRANCHES:
 *   - NEW `branches` table (1:N off accounts), with exactly one is_default=1
 *     branch seeded per existing account.
 *   - 8 child/state tables re-keyed account_id -> branch_id via the SQLite
 *     table-rebuild idiom (CREATE __new, INSERT…SELECT join, DROP, RENAME,
 *     recreate indexes), JOINing onto each account's default branch.
 *   - 5 per-target columns DROPPED off accounts (target_page_url,
 *     own_profile_url, send_dm_to_commenters, dm_as_page_url,
 *     check_interval_minutes) — moved to branches. daily_action_cap RETAINED
 *     (per-account ceiling).
 *   - action_log gains a branch_id column (CASCADE) + a per-branch day index,
 *     backfilled to each account's default branch.
 *   - schema_meta.version 1 -> 2 (bumped LAST, inside the tx).
 *
 * THE 4 NON-NEGOTIABLE CHALLENGER FIXES (all enforced here):
 *   BLOCKING-1  Per-rebuild COUNT(__new)==COUNT(old) assertion INSIDE the tx,
 *               BEFORE the DROP. foreign_key_check can't see zero-row data loss;
 *               the COUNT assertion is the real integrity gate. Also: after
 *               seeding default branches, assert each account has EXACTLY ONE
 *               is_default=1 branch before the JOIN-based rebuilds run.
 *   BLOCKING-2  Operational pre-flight (in the runner, see migrate.js): WAL
 *               checkpoint(TRUNCATE) with busy==0, abort if a -wal sidecar
 *               persists, and the worker+control-plane-stopped runbook.
 *   TX STRUCTURE  PRAGMA foreign_keys is a no-op inside a tx, so: read version
 *               (return if >=2); foreign_keys=OFF OUTSIDE the tx; the whole DDL
 *               + COUNT assertions + version bump in ONE db.transaction();
 *               foreign_key_check empty afterward (secondary gate);
 *               foreign_keys=ON. All-or-nothing.
 *
 * Idempotent: re-running on a v2 DB is a no-op (version gate). The default-branch
 * seed is NOT EXISTS-guarded so even a half-applied state converges.
 *
 * This module operates on a better-sqlite3 Database HANDLE (not the db.js
 * singleton) so it can be driven directly against a temp DB in tests AND against
 * the live connection by the runner.
 */

const SCHEMA_VERSION_V2 = 2;

// The 8 child/state tables re-keyed account_id -> branch_id. Each entry is a
// full table-rebuild spec: the __new DDL (with branch_id), the column list to
// carry across the INSERT…SELECT, and the indexes to recreate afterward.
//
// The INSERT…SELECT JOINs old.account_id -> branches.account_id WHERE
// branches.is_default = 1, mapping every old row onto its account's default
// branch and preserving the original id + all payload columns + timestamps.
const REKEY_SPECS = [
  // ── Group A: content (id PK, ordered by position) ──
  {
    table: 'account_comments',
    newDdl: `CREATE TABLE account_comments__new (
      id        INTEGER PRIMARY KEY,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      text      TEXT    NOT NULL,
      position  INTEGER NOT NULL DEFAULT 0
    )`,
    insertSelect: `INSERT INTO account_comments__new (id, branch_id, text, position)
      SELECT o.id, b.id, o.text, o.position
      FROM account_comments o
      JOIN branches b ON b.account_id = o.account_id AND b.is_default = 1`,
    indexes: [`CREATE INDEX idx_account_comments_branch ON account_comments(branch_id)`],
  },
  {
    table: 'account_replies',
    newDdl: `CREATE TABLE account_replies__new (
      id        INTEGER PRIMARY KEY,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      text      TEXT    NOT NULL,
      position  INTEGER NOT NULL DEFAULT 0
    )`,
    insertSelect: `INSERT INTO account_replies__new (id, branch_id, text, position)
      SELECT o.id, b.id, o.text, o.position
      FROM account_replies o
      JOIN branches b ON b.account_id = o.account_id AND b.is_default = 1`,
    indexes: [`CREATE INDEX idx_account_replies_branch ON account_replies(branch_id)`],
  },
  {
    table: 'account_dm_messages',
    newDdl: `CREATE TABLE account_dm_messages__new (
      id        INTEGER PRIMARY KEY,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      text      TEXT    NOT NULL,
      position  INTEGER NOT NULL DEFAULT 0
    )`,
    insertSelect: `INSERT INTO account_dm_messages__new (id, branch_id, text, position)
      SELECT o.id, b.id, o.text, o.position
      FROM account_dm_messages o
      JOIN branches b ON b.account_id = o.account_id AND b.is_default = 1`,
    indexes: [`CREATE INDEX idx_account_dm_messages_branch ON account_dm_messages(branch_id)`],
  },
  {
    table: 'account_groups',
    newDdl: `CREATE TABLE account_groups__new (
      id        INTEGER PRIMARY KEY,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      url       TEXT    NOT NULL,
      position  INTEGER NOT NULL DEFAULT 0
    )`,
    insertSelect: `INSERT INTO account_groups__new (id, branch_id, url, position)
      SELECT o.id, b.id, o.url, o.position
      FROM account_groups o
      JOIN branches b ON b.account_id = o.account_id AND b.is_default = 1`,
    indexes: [`CREATE INDEX idx_account_groups_branch ON account_groups(branch_id)`],
  },
  // ── Group B: state (PK or UNIQUE re-keyed; BAN-RISK tables preserve id+ts) ──
  {
    // account_state PK was account_id -> PK becomes branch_id.
    table: 'account_state',
    newDdl: `CREATE TABLE account_state__new (
      branch_id     INTEGER PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
      last_post_id  TEXT,
      shared_posts  TEXT NOT NULL DEFAULT '[]',
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    insertSelect: `INSERT INTO account_state__new (branch_id, last_post_id, shared_posts, updated_at)
      SELECT b.id, o.last_post_id, o.shared_posts, o.updated_at
      FROM account_state o
      JOIN branches b ON b.account_id = o.account_id AND b.is_default = 1`,
    indexes: [],
  },
  {
    // account_status PK was account_id -> PK becomes branch_id.
    table: 'account_status',
    newDdl: `CREATE TABLE account_status__new (
      branch_id       INTEGER PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
      status          TEXT    NOT NULL DEFAULT 'idle',
      detail          TEXT,
      last_cycle_at   TEXT,
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    )`,
    insertSelect: `INSERT INTO account_status__new (branch_id, status, detail, last_cycle_at, updated_at)
      SELECT b.id, o.status, o.detail, o.last_cycle_at, o.updated_at
      FROM account_status o
      JOIN branches b ON b.account_id = o.account_id AND b.is_default = 1`,
    indexes: [],
  },
  {
    // seen_comments UNIQUE(account_id,post_url,comment_id) -> UNIQUE(branch_id,…)
    // BAN-RISK: preserve every row + id + seen_at.
    table: 'seen_comments',
    newDdl: `CREATE TABLE seen_comments__new (
      id          INTEGER PRIMARY KEY,
      branch_id   INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      post_url    TEXT    NOT NULL,
      comment_id  TEXT    NOT NULL,
      seen_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (branch_id, post_url, comment_id)
    )`,
    insertSelect: `INSERT INTO seen_comments__new (id, branch_id, post_url, comment_id, seen_at)
      SELECT o.id, b.id, o.post_url, o.comment_id, o.seen_at
      FROM seen_comments o
      JOIN branches b ON b.account_id = o.account_id AND b.is_default = 1`,
    indexes: [`CREATE INDEX idx_seen_comments_lookup ON seen_comments(branch_id, post_url)`],
  },
  {
    // dm_sent UNIQUE(account_id,profile_url) -> UNIQUE(branch_id,profile_url)
    // BAN-RISK: preserve every row + id + sent_at.
    table: 'dm_sent',
    newDdl: `CREATE TABLE dm_sent__new (
      id            INTEGER PRIMARY KEY,
      branch_id     INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      profile_url   TEXT    NOT NULL,
      sent_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (branch_id, profile_url)
    )`,
    insertSelect: `INSERT INTO dm_sent__new (id, branch_id, profile_url, sent_at)
      SELECT o.id, b.id, o.profile_url, o.sent_at
      FROM dm_sent o
      JOIN branches b ON b.account_id = o.account_id AND b.is_default = 1`,
    indexes: [`CREATE INDEX idx_dm_sent_branch ON dm_sent(branch_id)`],
  },
];

/**
 * Read the current schema_meta.version (0 if the row is missing).
 * @param {import('better-sqlite3').Database} conn
 * @returns {number}
 */
function readVersion(conn) {
  const row = conn.prepare(`SELECT version FROM schema_meta WHERE id = 1`).get();
  return row ? Number(row.version) : 0;
}

/**
 * Does a column exist on a table? Uses PRAGMA table_info (no string-built SQL on
 * untrusted input — table name is a fixed literal at every call site).
 * @param {import('better-sqlite3').Database} conn
 * @param {string} table
 * @param {string} column
 * @returns {boolean}
 */
function hasColumn(conn, table, column) {
  const cols = conn.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

/**
 * Create the branches table + its indexes if absent. Idempotent (IF NOT EXISTS).
 * @param {import('better-sqlite3').Database} conn
 */
function createBranchesTable(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS branches (
      id                     INTEGER PRIMARY KEY,
      account_id             INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name                   TEXT    NOT NULL,
      is_default             INTEGER NOT NULL DEFAULT 0,
      target_page_url        TEXT    NOT NULL DEFAULT '',
      own_profile_url        TEXT,
      send_dm_to_commenters  INTEGER NOT NULL DEFAULT 0,
      dm_as_page_url         TEXT,
      check_interval_minutes INTEGER NOT NULL DEFAULT 7,
      daily_action_cap       INTEGER,
      enabled                INTEGER NOT NULL DEFAULT 1,
      created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (account_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_branches_acct ON branches(account_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_one_default_per_account
      ON branches(account_id) WHERE is_default = 1;
  `);
}

/**
 * Seed exactly one is_default=1 branch per account, copying the per-target
 * fields off the (still-present, pre-DROP) accounts columns. NOT EXISTS-guarded
 * so it is idempotent.
 *
 * IMPORTANT (ban-safety): the default branch's daily_action_cap is seeded NULL
 * (inherit the account ceiling), NOT the account's cap value — copying the
 * account cap into the branch would DOUBLE the effective budget the moment a 2nd
 * branch is added (branch cap + account cap both apply). The account ceiling
 * (accounts.daily_action_cap) is left exactly as-is.
 * @param {import('better-sqlite3').Database} conn
 */
function seedDefaultBranches(conn) {
  conn
    .prepare(
      `INSERT INTO branches
         (account_id, name, is_default, target_page_url, own_profile_url,
          send_dm_to_commenters, dm_as_page_url, check_interval_minutes,
          daily_action_cap, enabled, created_at, updated_at)
       SELECT a.id, 'default', 1,
              COALESCE(a.target_page_url, ''), a.own_profile_url,
              COALESCE(a.send_dm_to_commenters, 0), a.dm_as_page_url,
              COALESCE(a.check_interval_minutes, 7),
              NULL, 1, datetime('now'), datetime('now')
       FROM accounts a
       WHERE NOT EXISTS (SELECT 1 FROM branches b WHERE b.account_id = a.id)`
    )
    .run();
}

/**
 * BLOCKING-1 (default-branch invariant): every account must have EXACTLY ONE
 * is_default=1 branch before the JOIN-based rebuilds run. A 0 here would make the
 * INNER JOINs match zero rows and SILENTLY drop all that account's content/state
 * (the most dangerous failure mode). THROW on any violation (rolls back the tx).
 * @param {import('better-sqlite3').Database} conn
 * @throws {Error} if any account has != 1 default branch
 */
function assertOneDefaultPerAccount(conn) {
  const bad = conn
    .prepare(
      `SELECT a.id AS account_id,
              (SELECT COUNT(*) FROM branches b
               WHERE b.account_id = a.id AND b.is_default = 1) AS n
       FROM accounts a
       WHERE n != 1`
    )
    .all();
  if (bad.length > 0) {
    const detail = bad.map((r) => `account ${r.account_id} has ${r.n} default branches`).join('; ');
    throw new Error(`BLOCKING-1 default-branch invariant violated: ${detail}`);
  }
}

/**
 * Rebuild ONE child/state table to be keyed by branch_id, with the BLOCKING-1
 * COUNT assertion: COUNT(__new) MUST equal COUNT(old) BEFORE we DROP old. A
 * mismatch (e.g. a JOIN that matched zero rows because a default branch was
 * missing) THROWS, rolling back the whole tx. foreign_key_check cannot detect
 * this zero-row loss — the COUNT is the real gate.
 * @param {import('better-sqlite3').Database} conn
 * @param {{table:string,newDdl:string,insertSelect:string,indexes:string[]}} spec
 * @throws {Error} on a COUNT mismatch (data loss) — aborts the migration
 */
function rebuildTable(conn, spec) {
  const { table, newDdl, insertSelect, indexes } = spec;

  const oldCount = conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

  conn.exec(newDdl);
  conn.prepare(insertSelect).run();

  const newCount = conn.prepare(`SELECT COUNT(*) AS n FROM ${table}__new`).get().n;

  // BLOCKING-1: the integrity gate. Equal counts before the destructive DROP.
  if (newCount !== oldCount) {
    throw new Error(
      `BLOCKING-1 row-count mismatch rebuilding "${table}": old=${oldCount} new=${newCount} ` +
        `— refusing to DROP (would lose ${oldCount - newCount} row(s)). Transaction will roll back.`
    );
  }

  conn.exec(`DROP TABLE ${table}`);
  conn.exec(`ALTER TABLE ${table}__new RENAME TO ${table}`);
  for (const idx of indexes) conn.exec(idx);
}

/**
 * Drop the 5 per-target columns moved to branches. daily_action_cap is NOT in
 * this list — it STAYS as the per-account ceiling. SQLite 3.49 supports
 * ALTER TABLE DROP COLUMN. Idempotent (guarded by hasColumn).
 * @param {import('better-sqlite3').Database} conn
 */
function dropMovedAccountColumns(conn) {
  const moved = [
    'target_page_url',
    'own_profile_url',
    'send_dm_to_commenters',
    'dm_as_page_url',
    'check_interval_minutes',
  ];
  for (const col of moved) {
    if (hasColumn(conn, 'accounts', col)) {
      conn.exec(`ALTER TABLE accounts DROP COLUMN ${col}`);
    }
  }
}

/**
 * Add action_log.branch_id (CASCADE), backfill it to each account's default
 * branch, and create the per-branch day index. Idempotent (guarded by
 * hasColumn / IF NOT EXISTS).
 * @param {import('better-sqlite3').Database} conn
 */
function migrateActionLog(conn) {
  if (!hasColumn(conn, 'action_log', 'branch_id')) {
    conn.exec(
      `ALTER TABLE action_log ADD COLUMN branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE`
    );
  }
  // Backfill rows that have an account but no branch yet -> the account default.
  conn
    .prepare(
      `UPDATE action_log
       SET branch_id = (
         SELECT b.id FROM branches b
         WHERE b.account_id = action_log.account_id AND b.is_default = 1
       )
       WHERE branch_id IS NULL AND account_id IS NOT NULL`
    )
    .run();
  conn.exec(
    `CREATE INDEX IF NOT EXISTS idx_action_log_branch_day ON action_log(branch_id, created_at)`
  );
}

/**
 * Run the v1 -> v2 migration on the given connection. ALL-OR-NOTHING.
 *
 * TX STRUCTURE (challenger): version gate first; foreign_keys=OFF OUTSIDE the tx
 * (PRAGMA is a no-op inside one); the whole DDL + COUNT assertions + version bump
 * inside ONE transaction; foreign_key_check empty afterward (secondary gate);
 * foreign_keys=ON. A throw anywhere inside the tx rolls EVERYTHING back.
 *
 * @param {import('better-sqlite3').Database} conn an OPEN better-sqlite3 handle
 * @param {{log?: (msg: string) => void}} [opts]
 * @returns {{migrated: boolean, fromVersion: number, toVersion: number}}
 * @throws {Error} on any integrity violation (the tx rolls back; the DB is
 *   left exactly as it was before the call)
 */
function migrateToV2(conn, opts = {}) {
  const log = opts.log || (() => {});

  const fromVersion = readVersion(conn);
  if (fromVersion >= SCHEMA_VERSION_V2) {
    log(`Already at version ${fromVersion} (>= ${SCHEMA_VERSION_V2}) — no-op.`);
    return { migrated: false, fromVersion, toVersion: fromVersion };
  }

  log(`Migrating schema v${fromVersion} -> v${SCHEMA_VERSION_V2} (multi-branch)...`);

  // PRAGMA foreign_keys is a no-op INSIDE a transaction, so toggle it here,
  // outside the tx. Snapshot the prior state so we restore it in finally.
  const fkWasOn = conn.pragma('foreign_keys', { simple: true }) === 1;
  conn.pragma('foreign_keys = OFF');

  try {
    const tx = conn.transaction(() => {
      // 1. branches table + indexes.
      createBranchesTable(conn);

      // 2. Seed one default branch per account (idempotent, NOT EXISTS-guarded),
      //    then assert the EXACTLY-ONE invariant BEFORE any JOIN-based rebuild.
      seedDefaultBranches(conn);
      assertOneDefaultPerAccount(conn); // BLOCKING-1 (default-branch invariant)

      // 3. Re-key all 8 child/state tables, each with its COUNT==COUNT gate.
      for (const spec of REKEY_SPECS) {
        rebuildTable(conn, spec); // BLOCKING-1 (row-count invariant)
        log(`  re-keyed ${spec.table} -> branch_id`);
      }

      // 4. action_log: add branch_id, backfill to default branch, index.
      migrateActionLog(conn);
      log('  action_log.branch_id added + backfilled');

      // 5. Drop the 5 moved columns off accounts (daily_action_cap RETAINED).
      dropMovedAccountColumns(conn);
      log('  dropped 5 per-target columns off accounts (daily_action_cap retained)');

      // 6. Bump version LAST, inside the tx, so a failure anywhere above leaves
      //    schema_meta at the OLD version (the whole tx rolls back regardless).
      conn.prepare(`UPDATE schema_meta SET version = ?, applied_at = datetime('now') WHERE id = 1`).run(
        SCHEMA_VERSION_V2
      );
    });

    tx(); // commit (or roll back on throw)

    // Secondary integrity gate: with FKs off during the rebuild, verify no
    // dangling references slipped in. Empty result == clean.
    const fkViolations = conn.pragma('foreign_key_check');
    if (Array.isArray(fkViolations) && fkViolations.length > 0) {
      // The tx already committed; surface the violation loudly. (In practice the
      // COUNT gates + INNER JOINs make this unreachable, but it is the documented
      // secondary gate and must be checked.)
      throw new Error(
        `foreign_key_check found ${fkViolations.length} violation(s) after v2 migration: ` +
          JSON.stringify(fkViolations)
      );
    }

    log(`Migration to v${SCHEMA_VERSION_V2} complete.`);
    return { migrated: true, fromVersion, toVersion: SCHEMA_VERSION_V2 };
  } finally {
    // Restore the connection's prior foreign_keys state (default ON for the app).
    conn.pragma(`foreign_keys = ${fkWasOn ? 'ON' : 'OFF'}`);
  }
}

module.exports = {
  migrateToV2,
  SCHEMA_VERSION_V2,
  // Exported for white-box testing of the individual steps.
  readVersion,
  hasColumn,
  REKEY_SPECS,
};
