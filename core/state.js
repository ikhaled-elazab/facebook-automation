'use strict';

/**
 * core/state.js — runtime state, DB-backed (was fs-backed in the monolith).
 *
 * The legacy index.js persisted per-account runtime state as files under state/:
 *   - state/<name>_last_post.txt
 *   - state/<name>_shared_posts.json
 *   - state/<name>_seen_comments_<hash>.json   (file-per-post sprawl)
 *   - state/<name>_dm_sent.json
 *
 * Phase 2 (multi-branch) keys all runtime state by BRANCH. The PUBLIC SHAPE of
 * these helpers is preserved — they still take the hydrated object as their first
 * argument and read its `.id` — but in Phase 2 that `.id` is the BRANCH id (see
 * worker/loadConfig.js hydrateBranch). The parameter is named `branch` to make
 * the meaning-shift explicit; the worker passes a hydrated branch whose `.id` is
 * the branch id and whose `.accountName` carries the FB-login identity.
 *
 * IMPORTANT — branch identity:
 *   The DB keys runtime state (account_state / seen_comments / dm_sent) by
 *   branches.id. The hydrated branch carries `.id` = branch id (DB key) plus the
 *   camelCase fields the selectors use. These helpers read `branch.id`.
 *
 * The pure helpers (cleanFbUrl, postHash, extractFbHandle,
 * extractUserIdFromProfileUrl) have NO DB dependency and are exported for unit
 * testing — they are byte-for-byte ports of the monolith logic.
 */

const db = require('../db');

// ── Pure helpers (no I/O — unit-test targets) ────────────────────────────────

/**
 * Strip Facebook tracking / session params from a URL. Port of index.js.
 * @param {string} url
 * @returns {string} cleaned url (or the original on parse failure / falsy input)
 */
function cleanFbUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    // Remove Facebook tracking / session params
    ['__cft__', '__tn__', '__xts__', 'ref', 'refid', 'fref', 'hc_ref', 'source'].forEach((p) =>
      u.searchParams.delete(p)
    );
    // Also remove any bracket-suffixed cft params like __cft__[0]
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith('__cft__') || key.startsWith('__tn__')) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Deterministic short hash of a post URL. Port of index.js. Retained as a pure
 * helper (the DB keys seen_comments by the real post_url now, so this is no
 * longer used for file naming, but the migration produced legacy: keys with it
 * and it remains a stable, testable primitive).
 * @param {string} postUrl
 * @returns {string} 12-char alnum hash
 */
function postHash(postUrl) {
  return Buffer.from(postUrl).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(-12);
}

/**
 * Extract the username or numeric ID from a Facebook profile URL so we can
 * build a direct Messenger link. Port of index.js extractFbHandle.
 *
 * Handles:
 *   facebook.com/username            → "username"
 *   facebook.com/profile.php?id=123  → "123"
 *   /groups/xxx/user/123/            → "123"
 * @param {string} profileUrl
 * @returns {string|null}
 */
function extractFbHandle(profileUrl) {
  try {
    const u = new URL(profileUrl);
    // profile.php?id=123 format
    const idParam = u.searchParams.get('id');
    if (idParam) return idParam;
    // /groups/.../user/123/ format
    const userMatch = u.pathname.match(/\/user\/(\d+)/);
    if (userMatch) return userMatch[1];
    // facebook.com/username format — last meaningful path segment
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 1) return parts[parts.length - 1];
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Extract this account's own user ID from its ownProfileUrl. Port of index.js
 * extractUserIdFromProfileUrl. Operates on the hydrated account's camelCase
 * `ownProfileUrl` field (preserved by worker/loadConfig.js).
 * @param {{ ownProfileUrl?: string }} account
 * @returns {string|null}
 */
function extractUserIdFromProfileUrl(account) {
  if (!account || !account.ownProfileUrl) return null;
  try {
    const url = new URL(account.ownProfileUrl);
    // profile.php?id=123456 format
    const idParam = url.searchParams.get('id');
    if (idParam) return idParam;
    // facebook.com/username format — return the last path segment
    return url.pathname.split('/').filter(Boolean).pop() || null;
  } catch {
    return null;
  }
}

// ── DB-backed state (was fs in the monolith) ─────────────────────────────────

/**
 * @param {{ id: number }} branch hydrated branch (carries the branch DB id)
 * @returns {string|null} last seen post id, or null
 */
function readLastPostId(branch) {
  const row = db.getBranchState(branch.id);
  return row && row.last_post_id ? row.last_post_id : null;
}

/**
 * @param {{ id: number }} branch
 * @param {string} id post id to persist
 */
function writeLastPostId(branch, id) {
  db.setLastPostId(branch.id, id);
}

/**
 * @param {{ id: number }} branch
 * @returns {string[]} shared post URLs
 */
function readSharedPosts(branch) {
  return db.getSharedPosts(branch.id);
}

/**
 * Append a cleaned post URL to the branch's shared-posts set (dedup by clean
 * URL). Port of index.js addSharedPost, now DB-backed per branch.
 * @param {{ id: number }} branch
 * @param {string} url
 */
function addSharedPost(branch, url) {
  if (!url) return;
  const clean = cleanFbUrl(url);
  const existing = db.getSharedPosts(branch.id);
  if (!existing.includes(clean)) {
    db.setSharedPosts(branch.id, [...existing, clean]);
  }
}

/**
 * Read the set of already-seen comment IDs for a post (scoped to this branch).
 * Returns a real Set so the monitor's `seen.has(id)` / `seen.add(id)` loop is
 * unchanged from the monolith.
 * @param {{ id: number }} branch
 * @param {string} postUrl
 * @returns {Set<string>}
 */
function readSeenComments(branch, postUrl) {
  return db.getSeenComments(branch.id, postUrl);
}

/**
 * Persist the seen-comments set for a post. The DB layer is append-only with
 * ON CONFLICT DO NOTHING, so we just insert every id in the set — already-known
 * ids are no-ops. This preserves the monolith's "build a Set, write it at the
 * end of the post loop" pattern while making persistence row-based per branch.
 * @param {{ id: number }} branch
 * @param {string} postUrl
 * @param {Set<string>} seenSet
 */
function writeSeenComments(branch, postUrl, seenSet) {
  for (const commentId of seenSet) {
    db.addSeenComment(branch.id, postUrl, commentId);
  }
}

/**
 * Persist a SINGLE seen-comment id immediately. Idempotent via the DB's
 * ON CONFLICT DO NOTHING. Used by the monitor to mark each comment as seen the
 * moment it is acted on, so a cycle interrupted mid-loop (SIGTERM during a DM
 * navigation, a thrown article handler) does NOT lose the in-memory record and
 * re-like / re-reply / re-DM an already-actioned commenter on the next cycle
 * (a ban-risk amplifier — MEDIUM-1). Batching at loop end is no longer safe.
 * @param {{ id: number }} branch
 * @param {string} postUrl
 * @param {string} commentId
 */
function markCommentSeen(branch, postUrl, commentId) {
  db.addSeenComment(branch.id, postUrl, commentId);
}

/**
 * Read the set of profile URLs this branch has already DM'd.
 * @param {{ id: number }} branch
 * @returns {Set<string>}
 */
function readDmSent(branch) {
  return db.getDmSent(branch.id);
}

/**
 * Persist the DM-sent set (append-only, dedup in the DB). Mirrors
 * writeSeenComments: insert every entry, known ones are no-ops.
 * @param {{ id: number }} branch
 * @param {Set<string>} set
 */
function writeDmSent(branch, set) {
  for (const profileUrl of set) {
    db.addDmSent(branch.id, profileUrl);
  }
}

module.exports = {
  // pure helpers
  cleanFbUrl,
  postHash,
  extractFbHandle,
  extractUserIdFromProfileUrl,
  // DB-backed state
  readLastPostId,
  writeLastPostId,
  readSharedPosts,
  addSharedPost,
  readSeenComments,
  writeSeenComments,
  markCommentSeen,
  readDmSent,
  writeDmSent,
};
