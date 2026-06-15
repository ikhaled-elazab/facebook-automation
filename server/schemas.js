'use strict';

/**
 * server/schemas.js — zod validation schemas.
 *
 * CRITICAL SECURITY ROLE: db.js builds SQL column lists dynamically from the keys
 * of the object it is handed (insertAccount: `INSERT INTO accounts (${cols})`;
 * updateSettings: `SET ${col} = @${col}`). db.js trusts its caller. THIS FILE IS
 * THAT TRUST BOUNDARY. Every object that reaches db.js must first pass through a
 * `.strict()` zod schema whose keys are EXACTLY the writable columns — so an
 * attacker-supplied key like `id` or `password_enc` or an injection attempt can
 * never reach the dynamic SQL builder.
 *
 * Rules:
 *   - `.strict()` everywhere → unknown keys are rejected (not stripped silently).
 *   - Secret inputs (password, proxy_password) are accepted as plaintext here and
 *     encrypted by the route BEFORE persist; they are NOT columns — they map to
 *     *_enc columns explicitly in the route, never passed through by key.
 *   - Booleans are accepted as JS booleans and converted to 0/1 for SQLite.
 */

const { z } = require('zod');

// ── Reusable primitives ──────────────────────────────────────────────────────

const nonEmptyString = z.string().trim().min(1);
const id = z.coerce.number().int().positive();

/**
 * A URL field constrained to the http/https schemes.
 *
 * SECURITY (stored-XSS defense): zod's `.url()` only checks that the string is a
 * parseable URL — it ACCEPTS `javascript:`, `data:`, `vbscript:` etc. Those are
 * later rendered into <a href> in the admin UI, and React does NOT strip a
 * javascript: href, so a stored `javascript:...` URL would execute on click.
 * Restricting the scheme to http(s) HERE (the single shared URL validator used by
 * every URL field: target_page_url / own_profile_url / dm_as_page_url + the
 * groups array) makes the dangerous schemes un-persistable in the first place.
 */
const HTTP_SCHEME = /^https?:$/i;
const optionalUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine(
    (s) => {
      try {
        return HTTP_SCHEME.test(new URL(s).protocol);
      } catch {
        return false;
      }
    },
    { message: 'URL must use the http or https scheme.' }
  );

/** Coerce a JS boolean to SQLite's 0/1 integer. */
const sqliteBool = z.boolean().transform((b) => (b ? 1 : 0));

/** A string array used for child collections (comments/replies/dm/groups). */
const textArray = z.array(z.string().trim().min(1).max(5000)).max(500);
const urlArray = z.array(optionalUrl).max(500);

// ── Auth ──────────────────────────────────────────────────────────────────────

const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(256),
    password: z.string().min(1).max(1024),
  })
  .strict();

// ── Accounts ────────────────────────────────────────────────────────────────--
//
// Writable account columns ONLY. `id`, `created_at`, `updated_at`, and the *_enc
// secret columns are deliberately excluded — they are managed by db.js / the
// route, never client-set. `password` / `proxy_password` are plaintext inputs the
// route encrypts; they are NOT columns and are split out before persist.

const accountWritableFields = {
  name: nonEmptyString.max(256),
  email: z.string().trim().email().max(320),
  session_file: nonEmptyString.max(1024),
  target_page_url: optionalUrl,
  own_profile_url: optionalUrl.nullable(),
  send_dm_to_commenters: sqliteBool,
  dm_as_page_url: optionalUrl.nullable(),
  user_agent: z.string().trim().max(1024).nullable(),
  locale: z.string().trim().max(35),
  timezone_id: z.string().trim().max(64),
  check_interval_minutes: z.coerce.number().int().min(1).max(1440),
  proxy_server: z.string().trim().max(2048).nullable(),
  proxy_username: z.string().trim().max(256).nullable(),
  daily_action_cap: z.coerce.number().int().min(0).max(100000).nullable(),
  enabled: sqliteBool,
};

/** Plaintext secret inputs — encrypted by the route, mapped to *_enc columns. */
const accountSecretFields = {
  password: z.string().min(1).max(1024).optional(),
  proxy_password: z.string().min(1).max(1024).optional(),
};

/** Child collections — replaced wholesale by db.js setters. */
const accountChildFields = {
  comments: textArray.optional(),
  replies: textArray.optional(),
  dm_messages: textArray.optional(),
  groups: urlArray.optional(),
};

// Create: name/email/session_file/target_page_url required; rest optional with
// DB defaults. Secrets + children optional. .strict() blocks unknown keys.
const createAccountSchema = z
  .object({
    name: accountWritableFields.name,
    email: accountWritableFields.email,
    session_file: accountWritableFields.session_file,
    target_page_url: accountWritableFields.target_page_url,
    own_profile_url: accountWritableFields.own_profile_url.optional(),
    send_dm_to_commenters: accountWritableFields.send_dm_to_commenters.optional(),
    dm_as_page_url: accountWritableFields.dm_as_page_url.optional(),
    user_agent: accountWritableFields.user_agent.optional(),
    locale: accountWritableFields.locale.optional(),
    timezone_id: accountWritableFields.timezone_id.optional(),
    check_interval_minutes: accountWritableFields.check_interval_minutes.optional(),
    proxy_server: accountWritableFields.proxy_server.optional(),
    proxy_username: accountWritableFields.proxy_username.optional(),
    daily_action_cap: accountWritableFields.daily_action_cap.optional(),
    enabled: accountWritableFields.enabled.optional(),
    ...accountSecretFields,
    ...accountChildFields,
  })
  .strict();

// Update: every field optional (partial patch). At least one key required.
const updateAccountSchema = z
  .object({
    name: accountWritableFields.name.optional(),
    email: accountWritableFields.email.optional(),
    session_file: accountWritableFields.session_file.optional(),
    target_page_url: accountWritableFields.target_page_url.optional(),
    own_profile_url: accountWritableFields.own_profile_url.optional(),
    send_dm_to_commenters: accountWritableFields.send_dm_to_commenters.optional(),
    dm_as_page_url: accountWritableFields.dm_as_page_url.optional(),
    user_agent: accountWritableFields.user_agent.optional(),
    locale: accountWritableFields.locale.optional(),
    timezone_id: accountWritableFields.timezone_id.optional(),
    check_interval_minutes: accountWritableFields.check_interval_minutes.optional(),
    proxy_server: accountWritableFields.proxy_server.optional(),
    proxy_username: accountWritableFields.proxy_username.optional(),
    daily_action_cap: accountWritableFields.daily_action_cap.optional(),
    enabled: accountWritableFields.enabled.optional(),
    ...accountSecretFields,
    ...accountChildFields,
  })
  .strict()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one field must be provided.',
  });

// The set of writable account COLUMN names (excludes secrets + children, which
// are handled specially). Used by the route to split a validated patch into the
// part that goes to db.insertAccount/db.updateAccount vs the special parts.
const ACCOUNT_COLUMN_KEYS = Object.freeze(Object.keys(accountWritableFields));
const ACCOUNT_CHILD_KEYS = Object.freeze(Object.keys(accountChildFields));

// ── Settings ──────────────────────────────────────────────────────────────────
// Writable settings columns ONLY. `id` and `updated_at` excluded.

const settingsWritableFields = {
  headless: sqliteBool,
  use_proxy: sqliteBool,
  use_ai: sqliteBool,
  use_vision: sqliteBool,
  vision_model: z.string().trim().min(1).max(128),
  vision_max_steps: z.coerce.number().int().min(1).max(100),
  log_dir: z.string().trim().min(1).max(1024),
  screenshot_on_error: sqliteBool,
  enable_dm_to_commenters: sqliteBool,
  min_action_ms: z.coerce.number().int().min(0).max(600000),
  max_action_ms: z.coerce.number().int().min(0).max(600000),
  min_typing_ms: z.coerce.number().int().min(0).max(60000),
  max_typing_ms: z.coerce.number().int().min(0).max(60000),
  account_stagger_ms: z.coerce.number().int().min(0).max(3600000),
  pacing_enabled: sqliteBool,
  global_daily_action_cap: z.coerce.number().int().min(0).max(1000000),
  active_hours_start: z.coerce.number().int().min(0).max(23),
  active_hours_end: z.coerce.number().int().min(0).max(23),
};

const updateSettingsSchema = z
  .object(
    Object.fromEntries(
      Object.entries(settingsWritableFields).map(([k, v]) => [k, v.optional()])
    )
  )
  .strict()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one field must be provided.',
  })
  // Cross-field invariant: min must not exceed max for the paired ranges.
  .refine(
    (o) => o.min_action_ms == null || o.max_action_ms == null || o.min_action_ms <= o.max_action_ms,
    { message: 'min_action_ms must be <= max_action_ms', path: ['min_action_ms'] }
  )
  .refine(
    (o) => o.min_typing_ms == null || o.max_typing_ms == null || o.min_typing_ms <= o.max_typing_ms,
    { message: 'min_typing_ms must be <= max_typing_ms', path: ['min_typing_ms'] }
  );

// ── Worker control ──────────────────────────────────────────────────────────--

const workerActionSchema = z
  .object({
    // Optional explicit verb; routes also expose dedicated /start /stop paths.
    action: z.enum(['start', 'stop', 'restart']).optional(),
  })
  .strict();

// ── Status / recent actions query ─────────────────────────────────────────────

// `limit` caps the page size (default 50, max 500). `before` is a cursor: the
// smallest action_log `id` from the previous page; the feed returns strictly
// older rows so the UI can page backward in time without offset drift.
const recentActionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
    account_id: id.optional(),
    before: id.optional(),
  })
  .strict();

const idParamSchema = z.object({ id }).strict();

module.exports = {
  loginSchema,
  createAccountSchema,
  updateAccountSchema,
  updateSettingsSchema,
  workerActionSchema,
  recentActionsQuerySchema,
  idParamSchema,
  ACCOUNT_COLUMN_KEYS,
  ACCOUNT_CHILD_KEYS,
};
