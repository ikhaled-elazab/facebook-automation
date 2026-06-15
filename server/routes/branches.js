'use strict';

/**
 * server/routes/branches.js — branch CRUD (the MONITORING UNIT; 1 account : N).
 *
 * Account-scoped collection (parent id in the path):
 *   GET  /api/accounts/:accountId/branches      -> list this account's branches
 *   POST /api/accounts/:accountId/branches      -> create a branch under the account
 *
 * Branch-scoped item ops (branch id in the path — a branch id is globally unique):
 *   GET    /api/branches/:id            -> get one + content arrays
 *   PATCH  /api/branches/:id            -> partial update (+ replace content arrays)
 *   DELETE /api/branches/:id            -> delete (children + state cascade);
 *                                          REFUSED (409) if it is the default branch
 *   POST   /api/branches/:id/default    -> promote this branch to the account default
 *
 * A branch owns: name, target_page_url, own_profile_url, send_dm_to_commenters,
 * dm_as_page_url, check_interval_minutes, daily_action_cap (per-branch override,
 * NULL = inherit the account ceiling), enabled, AND its content arrays
 * (comments/replies/dm_messages/groups).
 *
 * SECURITY (identical posture to accounts.js):
 *   - Behind requireAuth (the `/api` gate in app.js) + CSRF on every mutation.
 *   - `.strict()` zod is the SQL-injection trust boundary; unknown keys → 422,
 *     never the db.js dynamic SQL builder. `account_id`/`is_default` are NOT
 *     client-writable (account_id is fixed by the create URL; is_default flips
 *     only via the dedicated /default path, preserving one-default-per-account).
 *   - The http(s)-scheme refine on every URL field blocks stored javascript: XSS.
 *   - The allowlist serializer is fail-closed (a future column never auto-leaks).
 *   - A validated patch is split into {columns, children}; no raw object reaches
 *     db.js. The content arrays go through db.setBranch* setters (replace-wholesale).
 */

const express = require('express');
const { asyncHandler, parseOrThrow } = require('./helpers');
const db = require('../../db');
const {
  createBranchSchema,
  updateBranchSchema,
  idParamSchema,
  accountIdParamSchema,
  BRANCH_COLUMN_KEYS,
  BRANCH_CHILD_KEYS,
} = require('../schemas');
const { serializeBranch, serializeBranchWithChildren } = require('../serializers');
const { NotFoundError, ConflictError } = require('../errors');

/**
 * Split a validated branch payload into {columns, children}. account_id and
 * is_default are intentionally NOT in BRANCH_COLUMN_KEYS, so they can never be
 * carried through here (defense in depth atop the schema's `.strict()`).
 * @param {Record<string, unknown>} data validated payload
 * @returns {{columns:Record<string,unknown>, children:Record<string,unknown>}}
 */
function splitPayload(data) {
  const columns = {};
  const children = {};
  for (const key of BRANCH_COLUMN_KEYS) {
    if (key in data) columns[key] = data[key];
  }
  for (const key of BRANCH_CHILD_KEYS) {
    if (key in data) children[key] = data[key];
  }
  return { columns, children };
}

/** Apply content-array updates for a branch using db.js branch setters. */
function applyChildren(branchId, children) {
  if ('comments' in children) db.setBranchComments(branchId, children.comments);
  if ('replies' in children) db.setBranchReplies(branchId, children.replies);
  if ('dm_messages' in children) db.setBranchDmMessages(branchId, children.dm_messages);
  if ('groups' in children) db.setBranchGroups(branchId, children.groups);
}

/** Read a branch's content arrays into a single object. */
function readChildren(branchId) {
  return {
    comments: db.getBranchComments(branchId),
    replies: db.getBranchReplies(branchId),
    dm_messages: db.getBranchDmMessages(branchId),
    groups: db.getBranchGroups(branchId),
  };
}

/** Is this a UNIQUE(account_id, name) collision surfaced from SQLite? */
function isUniqueViolation(err) {
  return /UNIQUE constraint failed/i.test((err && err.message) || '');
}

/**
 * @param {{csrfProtection: import('express').RequestHandler}} deps
 * @returns {import('express').Router}
 */
function branchesRouter({ csrfProtection }) {
  const router = express.Router();

  // ── Account-scoped collection ───────────────────────────────────────────────

  // List the branches for one account (404 if the account does not exist, so the
  // client can distinguish "no such account" from "account has zero branches").
  router.get(
    '/accounts/:accountId/branches',
    asyncHandler(async (req, res) => {
      const { accountId } = parseOrThrow(accountIdParamSchema, req.params);
      if (!db.getAccountById(accountId)) throw new NotFoundError('Account not found');
      const rows = db.listBranches({ accountId });
      res.json({ branches: rows.map(serializeBranch) });
    })
  );

  // Create a branch under an account. account_id comes from the URL (never the
  // body); is_default is left at the DB default (0) — a new branch is NOT made
  // default implicitly (promotion is an explicit /default call).
  router.post(
    '/accounts/:accountId/branches',
    csrfProtection,
    asyncHandler(async (req, res) => {
      const { accountId } = parseOrThrow(accountIdParamSchema, req.params);
      if (!db.getAccountById(accountId)) throw new NotFoundError('Account not found');

      const data = parseOrThrow(createBranchSchema, req.body);

      // Pre-check UNIQUE(account_id, name) for a clean 409 (vs a raw constraint).
      const clash = db
        .listBranches({ accountId })
        .find((b) => b.name === data.name);
      if (clash) {
        throw new ConflictError(
          `A branch named "${data.name}" already exists for this account.`
        );
      }

      const { columns, children } = splitPayload(data);
      const insertFields = { ...columns, account_id: accountId };

      let newId;
      try {
        newId = db.insertBranch(insertFields);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            `A branch named "${data.name}" already exists for this account.`
          );
        }
        throw err;
      }

      applyChildren(newId, children);

      const row = db.getBranchById(newId);
      res.status(201).json({ branch: serializeBranchWithChildren(row, readChildren(newId)) });
    })
  );

  // ── Branch-scoped item ops ──────────────────────────────────────────────────

  // Get one branch + its content arrays.
  router.get(
    '/branches/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const row = db.getBranchById(id);
      if (!row) throw new NotFoundError('Branch not found');
      res.json({ branch: serializeBranchWithChildren(row, readChildren(id)) });
    })
  );

  // Update (partial) — columns and/or content arrays.
  router.patch(
    '/branches/:id',
    csrfProtection,
    asyncHandler(async (req, res) => {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const existing = db.getBranchById(id);
      if (!existing) throw new NotFoundError('Branch not found');

      const data = parseOrThrow(updateBranchSchema, req.body);

      // If renaming, guard UNIQUE(account_id, name) against OTHER branches of the
      // SAME account (a name may legitimately repeat across different accounts).
      if (data.name && data.name !== existing.name) {
        const clash = db
          .listBranches({ accountId: existing.account_id })
          .find((b) => b.name === data.name && b.id !== id);
        if (clash) {
          throw new ConflictError(
            `A branch named "${data.name}" already exists for this account.`
          );
        }
      }

      const { columns, children } = splitPayload(data);

      if (Object.keys(columns).length > 0) {
        try {
          db.updateBranch(id, columns);
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new ConflictError(
              `A branch named "${data.name}" already exists for this account.`
            );
          }
          throw err;
        }
      }
      applyChildren(id, children);

      const row = db.getBranchById(id);
      res.json({ branch: serializeBranchWithChildren(row, readChildren(id)) });
    })
  );

  // Delete — refused (409) for the account's default branch (db.deleteBranch
  // throws the guard; we map it to a clean Conflict with actionable guidance).
  router.delete(
    '/branches/:id',
    csrfProtection,
    asyncHandler(async (req, res) => {
      const { id } = parseOrThrow(idParamSchema, req.params);
      let deleted;
      try {
        deleted = db.deleteBranch(id);
      } catch (err) {
        if (/default branch/i.test((err && err.message) || '')) {
          throw new ConflictError(
            'Cannot delete the account’s default branch. Promote another branch ' +
              'to default first, then delete this one.'
          );
        }
        throw err;
      }
      if (!deleted) throw new NotFoundError('Branch not found');
      res.json({ ok: true, id });
    })
  );

  // Promote this branch to the account's sole default (atomic in db.setDefaultBranch).
  // Returns the branch WITH its content arrays so the envelope matches the
  // {branch: BranchWithChildren} contract every other item endpoint uses (the UI
  // can drop the response straight into its branch-detail state with no reshape).
  router.post(
    '/branches/:id/default',
    csrfProtection,
    asyncHandler(async (req, res) => {
      const { id } = parseOrThrow(idParamSchema, req.params);
      if (!db.getBranchById(id)) throw new NotFoundError('Branch not found');
      db.setDefaultBranch(id);
      const row = db.getBranchById(id);
      res.json({ branch: serializeBranchWithChildren(row, readChildren(id)) });
    })
  );

  return router;
}

module.exports = { branchesRouter };
