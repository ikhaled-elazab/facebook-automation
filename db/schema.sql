-- =============================================================================
-- facebook-automation — SQLite schema (Phase 2 — multi-branch, version 2)
-- Engine: better-sqlite3. Mode: WAL (concurrent reads while worker writes).
--
-- Design notes (database-expert discipline):
--   * All tables use INTEGER PRIMARY KEY (rowid alias) for fast joins.
--   * accounts is the LOGIN ENVELOPE (1 account = 1 Facebook login = 1 browser):
--     credentials, session file, proxy, browser fingerprint.
--   * branches is the MONITORING UNIT (1 account : N branches). A branch owns the
--     target page, own-profile, DM-as-page identity, check interval, per-branch
--     daily cap, and the content arrays (comments/replies/dm/groups). Each account
--     gets exactly one is_default=1 branch (the v1→v2 migration seeds it).
--   * Child + state tables are keyed by branch_id (Phase 1 keyed them by
--     account_id; the v1→v2 migration re-keys them onto the default branch).
--   * FB credentials are stored ENCRYPTED (AES-256-GCM) in accounts.password_enc;
--     this column never holds plaintext. See crypto.js.
--   * settings is a single-row (id=1) global config table = old config.json.
--   * THREE-TIER CAP HIERARCHY (most-specific wins; NULL inherits the next tier):
--       branches.daily_action_cap   per-branch  (NULL = inherit account ceiling)
--       accounts.daily_action_cap    per-account ceiling (NULL = inherit global)
--       settings.global_daily_action_cap  global (0 = unlimited, special-cased)
--   * schema_meta.version supports idempotent migrations (this is version 2).
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Schema versioning ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_meta (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  version     INTEGER NOT NULL,
  applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Global settings (replaces config.json) ──────────────────────────────────
-- Single row (id = 1). The OpenAI key is NOT stored here — it lives in .env.
CREATE TABLE IF NOT EXISTS settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  headless              INTEGER NOT NULL DEFAULT 0,   -- boolean 0/1
  use_proxy             INTEGER NOT NULL DEFAULT 0,
  use_ai                INTEGER NOT NULL DEFAULT 0,
  use_vision            INTEGER NOT NULL DEFAULT 1,
  vision_model          TEXT    NOT NULL DEFAULT 'gpt-4o-mini',
  vision_max_steps      INTEGER NOT NULL DEFAULT 8,
  log_dir               TEXT    NOT NULL DEFAULT 'logs',
  screenshot_on_error   INTEGER NOT NULL DEFAULT 1,
  enable_dm_to_commenters INTEGER NOT NULL DEFAULT 0,
  -- timing / humanization (old config.delays + accountStaggerMs)
  min_action_ms         INTEGER NOT NULL DEFAULT 2000,
  max_action_ms         INTEGER NOT NULL DEFAULT 5000,
  min_typing_ms         INTEGER NOT NULL DEFAULT 220,
  max_typing_ms         INTEGER NOT NULL DEFAULT 500,
  account_stagger_ms    INTEGER NOT NULL DEFAULT 45000,
  -- ── Safety-first pacing governor (modeled P1, enforced P5) ──
  -- Global caps; per-account ceiling + per-branch overrides live on those tables.
  pacing_enabled            INTEGER NOT NULL DEFAULT 1,
  global_daily_action_cap   INTEGER NOT NULL DEFAULT 200,  -- 0 = unlimited
  active_hours_start        INTEGER NOT NULL DEFAULT 8,    -- 0-23 local hour
  active_hours_end          INTEGER NOT NULL DEFAULT 23,   -- 0-23 local hour
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Accounts (the LOGIN ENVELOPE: 1 account = 1 FB login = 1 browser) ────────
-- Phase 2: the per-target fields (target_page_url, own_profile_url,
-- send_dm_to_commenters, dm_as_page_url, check_interval_minutes) MOVED to
-- branches. daily_action_cap STAYS here as the per-account CEILING (sums across
-- the account's branches; NULL = inherit settings.global_daily_action_cap).
CREATE TABLE IF NOT EXISTS accounts (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT    NOT NULL UNIQUE,
  email                 TEXT    NOT NULL,
  -- AES-256-GCM ciphertext (base64 "iv:tag:ciphertext"). NEVER plaintext.
  password_enc          TEXT,
  session_file          TEXT    NOT NULL,
  -- browser fingerprint
  user_agent            TEXT,
  locale                TEXT    NOT NULL DEFAULT 'en-US',
  timezone_id           TEXT    NOT NULL DEFAULT 'America/New_York',
  -- proxy (nullable; only used when settings.use_proxy = 1)
  proxy_server          TEXT,
  proxy_username        TEXT,
  proxy_password_enc    TEXT,   -- encrypted like password_enc
  -- ── Per-account pacing CEILING (NULL = inherit global) ──
  daily_action_cap      INTEGER,  -- NULL = use settings.global_daily_action_cap
  enabled               INTEGER NOT NULL DEFAULT 1,  -- worker skips disabled accts
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Branches (the MONITORING UNIT: 1 account : N branches) ───────────────────
-- Each branch is one monitoring target (page + own-profile + groups + content).
-- Exactly one branch per account is is_default=1 (enforced by a partial unique
-- index). daily_action_cap NULL = inherit the account ceiling.
CREATE TABLE IF NOT EXISTS branches (
  id                     INTEGER PRIMARY KEY,
  account_id             INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name                   TEXT    NOT NULL,
  is_default             INTEGER NOT NULL DEFAULT 0,   -- boolean 0/1
  target_page_url        TEXT    NOT NULL DEFAULT '',
  own_profile_url        TEXT,
  -- DM-as-page identity (highest ban-risk feature; per-branch opt-in)
  send_dm_to_commenters  INTEGER NOT NULL DEFAULT 0,
  dm_as_page_url         TEXT,
  check_interval_minutes INTEGER NOT NULL DEFAULT 7,
  -- ── Per-branch pacing override (NULL = inherit account ceiling) ──
  daily_action_cap       INTEGER,  -- NULL = inherit accounts.daily_action_cap
  enabled                INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, name)
);
CREATE INDEX IF NOT EXISTS idx_branches_acct ON branches(account_id);
-- At most one default branch per account. A partial unique index is the correct
-- tool: it constrains ONLY the is_default=1 rows, leaving non-default rows free.
CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_one_default_per_account
  ON branches(account_id) WHERE is_default = 1;

-- ── Branch content arrays (replace accounts.json comments/replies/dm/groups) ─
CREATE TABLE IF NOT EXISTS account_comments (
  id          INTEGER PRIMARY KEY,
  branch_id   INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  text        TEXT    NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0   -- preserve original array order
);
CREATE INDEX IF NOT EXISTS idx_account_comments_branch ON account_comments(branch_id);

CREATE TABLE IF NOT EXISTS account_replies (
  id          INTEGER PRIMARY KEY,
  branch_id   INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  text        TEXT    NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_account_replies_branch ON account_replies(branch_id);

CREATE TABLE IF NOT EXISTS account_dm_messages (
  id          INTEGER PRIMARY KEY,
  branch_id   INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  text        TEXT    NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_account_dm_messages_branch ON account_dm_messages(branch_id);

CREATE TABLE IF NOT EXISTS account_groups (
  id          INTEGER PRIMARY KEY,
  branch_id   INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  url         TEXT    NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_account_groups_branch ON account_groups(branch_id);

-- ── Runtime state (replaces state/*.txt and state/*.json) ───────────────────
-- One row per BRANCH: last seen post id + shared post URLs (JSON array text).
CREATE TABLE IF NOT EXISTS account_state (
  branch_id     INTEGER PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
  last_post_id  TEXT,
  shared_posts  TEXT NOT NULL DEFAULT '[]',  -- JSON array of clean URLs
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Replaces state/<name>_seen_comments_<hash>.json (file-per-post sprawl → rows).
CREATE TABLE IF NOT EXISTS seen_comments (
  id          INTEGER PRIMARY KEY,
  branch_id   INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  post_url    TEXT    NOT NULL,
  comment_id  TEXT    NOT NULL,
  seen_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (branch_id, post_url, comment_id)
);
CREATE INDEX IF NOT EXISTS idx_seen_comments_lookup ON seen_comments(branch_id, post_url);

-- Replaces state/<name>_dm_sent.json
CREATE TABLE IF NOT EXISTS dm_sent (
  id            INTEGER PRIMARY KEY,
  branch_id     INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  profile_url   TEXT    NOT NULL,
  sent_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (branch_id, profile_url)
);
CREATE INDEX IF NOT EXISTS idx_dm_sent_branch ON dm_sent(branch_id);

-- ── Action log (feeds the safety governor's daily caps + UI recent-events) ────
-- Every like/comment/share/dm gets a row. Carries BOTH account_id (the login,
-- for the per-account ceiling sum) and branch_id (the monitoring unit, for the
-- per-branch cap + UI drill-down). Both CASCADE so a deleted account/branch
-- takes its log rows with it.
CREATE TABLE IF NOT EXISTS action_log (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  branch_id   INTEGER REFERENCES branches(id) ON DELETE CASCADE,
  action_type TEXT    NOT NULL,   -- like | comment | share | dm | monitor
  target_url  TEXT,
  status      TEXT    NOT NULL DEFAULT 'ok',  -- ok | failed | skipped | blocked
  detail      TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_action_log_acct_day ON action_log(account_id, created_at);
-- The composite (account_id, created_at) index can't serve the global daily-cap
-- query (no account_id predicate) — EXPLAIN QUERY PLAN shows a full table SCAN.
-- This created_at-only index lets the governor count today's global actions via
-- an index range scan.
CREATE INDEX IF NOT EXISTS idx_action_log_created ON action_log(created_at);
-- Per-branch daily-cap query: (branch_id, created_at) so the per-branch cap
-- count is an index range scan (mirrors the per-account index, one tier down).
CREATE INDEX IF NOT EXISTS idx_action_log_branch_day ON action_log(branch_id, created_at);

-- ── Worker control + heartbeat (control-plane <-> worker coordination, P3) ───
-- Single row (id=1). Control plane writes desired_state; worker writes status.
CREATE TABLE IF NOT EXISTS worker_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  desired_state   TEXT    NOT NULL DEFAULT 'stopped',  -- running | stopped
  status          TEXT    NOT NULL DEFAULT 'stopped',  -- running | stopped | error
  last_heartbeat  TEXT,
  detail          TEXT,
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Per-branch cycle status (P5 — fixes single-row heartbeat last-writer-wins) ─
-- worker_state is a single row; with N monitoring units each writing per-cycle
-- status, one unit's 'error' is immediately overwritten by another's 'running'.
-- This table holds ONE row PER BRANCH so each branch's last cycle status is
-- independently observable, while worker_state keeps the single global
-- process-liveness contract the control-plane reads. ON DELETE CASCADE keeps it
-- consistent with branches.
CREATE TABLE IF NOT EXISTS account_status (
  branch_id       INTEGER PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
  status          TEXT    NOT NULL DEFAULT 'idle',  -- idle | running | ok | error | paused
  detail          TEXT,
  last_cycle_at   TEXT,
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
