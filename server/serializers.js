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
 */
const ACCOUNT_PUBLIC_FIELDS = Object.freeze([
  'id',
  'name',
  'email',
  'session_file',
  'target_page_url',
  'own_profile_url',
  'dm_as_page_url',
  'user_agent',
  'locale',
  'timezone_id',
  'check_interval_minutes',
  'proxy_server',
  'proxy_username',
  'daily_action_cap',
  'created_at',
  'updated_at',
]);

const ACCOUNT_BOOLEAN_FIELDS = Object.freeze(['send_dm_to_commenters', 'enabled']);

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

/**
 * Serialize an account together with its child collections.
 * @param {Record<string, unknown>} row
 * @param {{comments:string[], replies:string[], dm_messages:string[], groups:string[]}} children
 * @returns {Record<string, unknown>}
 */
function serializeAccountWithChildren(row, children) {
  const base = serializeAccount(row);
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
  serializeAccountWithChildren,
  serializeSettings,
  ACCOUNT_PUBLIC_FIELDS,
  SETTINGS_PUBLIC_FIELDS,
};
