'use strict';

/**
 * server/serializers.js — convert raw DB rows into safe client-facing shapes.
 *
 * SECURITY (OWASP A01/A02): credentials NEVER leave this process. We use an
 * explicit ALLOWLIST projection rather than deleting secret fields. Allowlisting
 * fails closed — if db.js later adds a new secret column, it is invisible to the
 * API until deliberately added here, instead of silently leaking via a denylist.
 *
 * The two secret columns (accounts.password_enc, accounts.proxy_password_enc) are
 * intentionally absent from the allowlist. Instead we expose booleans
 * (has_password / has_proxy_password) so the UI can render "credential is set"
 * state without ever receiving the ciphertext.
 */

/**
 * Public, safe account fields. Note: SQLite stores booleans as 0/1 integers;
 * we coerce the known boolean columns to real booleans for a clean API.
 *
 * Phase 2 RE-KEY: the per-target monitoring fields (target_page_url,
 * own_profile_url, dm_as_page_url, send_dm_to_commenters, check_interval_minutes)
 * MOVED to branches and are gone from this allowlist. The account now exposes
 * login/identity/fingerprint/proxy + the per-account cap CEILING. The content
 * arrays (comments/replies/dm_messages/groups) likewise moved to the branch
 * serializer below. Allowlisting fails closed: a dropped column simply stops
 * appearing, never leaks.
 */
const ACCOUNT_PUBLIC_FIELDS = Object.freeze([
  'id',
  'name',
  'email',
  'session_file',
  'user_agent',
  'locale',
  'timezone_id',
  'proxy_server',
  'proxy_username',
  'daily_action_cap',
  'created_at',
  'updated_at',
]);

const ACCOUNT_BOOLEAN_FIELDS = Object.freeze(['enabled']);

/**
 * Serialize a raw accounts row to the safe client shape.
 * @param {Record<string, unknown>|undefined|null} row
 * @returns {Record<string, unknown>|null}
 */
function serializeAccount(row) {
  if (!row) return null;
  const out = {};
  for (const field of ACCOUNT_PUBLIC_FIELDS) {
    out[field] = row[field] === undefined ? null : row[field];
  }
  for (const field of ACCOUNT_BOOLEAN_FIELDS) {
    out[field] = !!row[field];
  }
  // Derived "secret is set" booleans — never the secret itself.
  out.has_password = !!row.password_enc;
  out.has_proxy_password = !!row.proxy_password_enc;
  return out;
}

// ── Branches (Phase 2 — the MONITORING UNIT) ──────────────────────────────────
//
// Same allowlist discipline as accounts (fail closed). A branch holds NO secrets,
// but we STILL project an explicit field subset so a future branches column never
// silently appears in the API. `account_id` is exposed (read-only) so the client
// can group branches under their account; `is_default` is exposed (read-only) so
// the UI can mark/guard the default branch — but neither is writable (see
// schemas.js: account_id is set via the create URL, is_default via setDefaultBranch).
const BRANCH_PUBLIC_FIELDS = Object.freeze([
  'id',
  'account_id',
  'name',
  'target_page_url',
  'own_profile_url',
  'dm_as_page_url',
  'check_interval_minutes',
  'daily_action_cap',
  'created_at',
  'updated_at',
]);

const BRANCH_BOOLEAN_FIELDS = Object.freeze([
  'is_default',
  'send_dm_to_commenters',
  'enabled',
]);

/**
 * Serialize a raw branches row to the safe client shape (allowlist projection;
 * boolean 0/1 columns coerced to real booleans).
 * @param {Record<string, unknown>|undefined|null} row
 * @returns {Record<string, unknown>|null}
 */
function serializeBranch(row) {
  if (!row) return null;
  const out = {};
  for (const field of BRANCH_PUBLIC_FIELDS) {
    out[field] = row[field] === undefined ? null : row[field];
  }
  for (const field of BRANCH_BOOLEAN_FIELDS) {
    out[field] = !!row[field];
  }
  return out;
}

/**
 * Serialize a branch together with its content collections.
 * @param {Record<string, unknown>} row
 * @param {{comments:string[], replies:string[], dm_messages:string[], groups:string[]}} children
 * @returns {Record<string, unknown>|null}
 */
function serializeBranchWithChildren(row, children) {
  const base = serializeBranch(row);
  if (!base) return base;
  return {
    ...base,
    comments: children.comments || [],
    replies: children.replies || [],
    dm_messages: children.dm_messages || [],
    groups: children.groups || [],
  };
}

/**
 * Public, safe settings fields. Settings hold NO secrets (the OpenAI / encryption
 * keys live in .env), but we still project through an EXPLICIT allowlist — not a
 * `{...row}` passthrough — so a future schema.sql column does not silently appear
 * in the API. This mirrors the accounts allowlist (MED-5: API shape stays a
 * deliberate contract, decoupled from physical schema). `updated_at` is included
 * (clients want to show "last changed"); `id` is the fixed singleton (always 1)
 * and is omitted as uninformative.
 */
const SETTINGS_PUBLIC_FIELDS = Object.freeze([
  'headless',
  'use_proxy',
  'use_ai',
  'use_vision',
  'vision_model',
  'vision_max_steps',
  'log_dir',
  'screenshot_on_error',
  'enable_dm_to_commenters',
  'min_action_ms',
  'max_action_ms',
  'min_typing_ms',
  'max_typing_ms',
  'account_stagger_ms',
  'pacing_enabled',
  'global_daily_action_cap',
  'active_hours_start',
  'active_hours_end',
  'updated_at',
]);

/** Settings boolean columns (stored as 0/1) — coerced to real booleans. */
const SETTINGS_BOOLEAN_FIELDS = Object.freeze([
  'headless',
  'use_proxy',
  'use_ai',
  'use_vision',
  'screenshot_on_error',
  'enable_dm_to_commenters',
  'pacing_enabled',
]);

const SETTINGS_BOOLEAN_SET = new Set(SETTINGS_BOOLEAN_FIELDS);

/**
 * Serialize the settings row to the safe client shape via an explicit allowlist
 * projection (fails closed on new schema columns). Boolean columns are coerced
 * from SQLite's 0/1 to real booleans.
 * @param {Record<string, unknown>|undefined|null} row
 * @returns {Record<string, unknown>|null}
 */
function serializeSettings(row) {
  if (!row) return null;
  const out = {};
  for (const field of SETTINGS_PUBLIC_FIELDS) {
    if (SETTINGS_BOOLEAN_SET.has(field)) {
      out[field] = !!row[field];
    } else {
      out[field] = row[field] === undefined ? null : row[field];
    }
  }
  return out;
}

module.exports = {
  serializeAccount,
  serializeBranch,
  serializeBranchWithChildren,
  serializeSettings,
  ACCOUNT_PUBLIC_FIELDS,
  BRANCH_PUBLIC_FIELDS,
  SETTINGS_PUBLIC_FIELDS,
};
