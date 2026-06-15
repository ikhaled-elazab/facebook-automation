'use strict';

/**
 * server/routes/accounts.js — account CRUD + child collections.
 *
 *   GET    /api/accounts            -> list (safe projection, no secrets)
 *   GET    /api/accounts/:id        -> get one + children
 *   POST   /api/accounts            -> create (encrypt secrets, set children)
 *   PATCH  /api/accounts/:id        -> partial update (encrypt secrets, set children)
 *   DELETE /api/accounts/:id        -> delete (children cascade in DB)
 *
 * SECURITY:
 *   - All routes are behind requireAuth (wired in app.js) + CSRF on mutations.
 *   - FB password + proxy password arrive as plaintext, are encrypted via
 *     crypto.encrypt() into *_enc columns HERE, and are NEVER returned.
 *   - Responses go through serializers (allowlist projection).
 *   - A validated patch is split into {columns, secrets, children} using the
 *     fixed key-sets from schemas.js — no raw object is ever forwarded to db.js.
 */

const express = require('express');
const { asyncHandler, parseOrThrow } = require('./helpers');
const db = require('../../db');
const { encrypt } = require('../../crypto');
const {
  createAccountSchema,
  updateAccountSchema,
  idParamSchema,
  ACCOUNT_COLUMN_KEYS,
  ACCOUNT_CHILD_KEYS,
} = require('../schemas');
const { serializeAccount, serializeAccountWithChildren } = require('../serializers');
const { NotFoundError, ConflictError } = require('../errors');

/**
 * Split a validated payload into the three destination streams.
 * @param {Record<string, unknown>} data validated payload
 * @returns {{columns:Record<string,unknown>, secrets:Record<string,string>, children:Record<string,unknown>}}
 */
function splitPayload(data) {
  const columns = {};
  const children = {};
  const secrets = {};

  for (const key of ACCOUNT_COLUMN_KEYS) {
    if (key in data) columns[key] = data[key];
  }
  for (const key of ACCOUNT_CHILD_KEYS) {
    if (key in data) children[key] = data[key];
  }
  // Plaintext secrets -> encrypted *_enc columns (mapped explicitly, by name).
  if (data.password !== undefined) secrets.password_enc = encrypt(data.password);
  if (data.proxy_password !== undefined) {
    secrets.proxy_password_enc = encrypt(data.proxy_password);
  }
  return { columns, secrets, children };
}

/** Apply child-collection updates for an account using db.js setters. */
function applyChildren(accountId, children) {
  if ('comments' in children) db.setAccountComments(accountId, children.comments);
  if ('replies' in children) db.setAccountReplies(accountId, children.replies);
  if ('dm_messages' in children) db.setAccountDmMessages(accountId, children.dm_messages);
  if ('groups' in children) db.setAccountGroups(accountId, children.groups);
}

/** Read an account's children into a single object. */
function readChildren(accountId) {
  return {
    comments: db.getAccountComments(accountId),
    replies: db.getAccountReplies(accountId),
    dm_messages: db.getAccountDmMessages(accountId),
    groups: db.getAccountGroups(accountId),
  };
}

/**
 * @param {{csrfProtection: import('express').RequestHandler}} deps
 * @returns {import('express').Router}
 */
function accountsRouter({ csrfProtection }) {
  const router = express.Router();

  // List — safe projection.
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const rows = db.listAccounts();
      res.json({ accounts: rows.map(serializeAccount) });
    })
  );

  // Get one + children.
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const row = db.getAccountById(id);
      if (!row) throw new NotFoundError('Account not found');
      res.json({ account: serializeAccountWithChildren(row, readChildren(id)) });
    })
  );

  // Create.
  router.post(
    '/',
    csrfProtection,
    asyncHandler(async (req, res) => {
      const data = parseOrThrow(createAccountSchema, req.body);

      // Uniqueness pre-check (accounts.name is UNIQUE) for a clean 409 instead of
      // a raw SQLite constraint error.
      if (db.getAccountByName(data.name)) {
        throw new ConflictError(`An account named "${data.name}" already exists.`);
      }

      const { columns, secrets, children } = splitPayload(data);
      const insertFields = { ...columns, ...secrets };

      let newId;
      try {
        newId = db.insertAccount(insertFields);
      } catch (err) {
        // Defensive: race on the UNIQUE(name) between check and insert.
        if (/UNIQUE constraint failed/i.test(err.message || '')) {
          throw new ConflictError(`An account named "${data.name}" already exists.`);
        }
        throw err;
      }

      applyChildren(newId, children);

      const row = db.getAccountById(newId);
      res
        .status(201)
        .json({ account: serializeAccountWithChildren(row, readChildren(newId)) });
    })
  );

  // Update (partial).
  router.patch(
    '/:id',
    csrfProtection,
    asyncHandler(async (req, res) => {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const existing = db.getAccountById(id);
      if (!existing) throw new NotFoundError('Account not found');

      const data = parseOrThrow(updateAccountSchema, req.body);

      // If renaming, guard the UNIQUE(name) constraint against OTHER accounts.
      if (data.name && data.name !== existing.name) {
        const clash = db.getAccountByName(data.name);
        if (clash && clash.id !== id) {
          throw new ConflictError(`An account named "${data.name}" already exists.`);
        }
      }

      const { columns, secrets, children } = splitPayload(data);
      const updateColumns = { ...columns, ...secrets };

      if (Object.keys(updateColumns).length > 0) {
        try {
          db.updateAccount(id, updateColumns);
        } catch (err) {
          if (/UNIQUE constraint failed/i.test(err.message || '')) {
            throw new ConflictError(`An account named "${data.name}" already exists.`);
          }
          throw err;
        }
      }
      applyChildren(id, children);

      const row = db.getAccountById(id);
      res.json({ account: serializeAccountWithChildren(row, readChildren(id)) });
    })
  );

  // Delete (children + state cascade via FK).
  router.delete(
    '/:id',
    csrfProtection,
    asyncHandler(async (req, res) => {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const deleted = db.deleteAccount(id);
      if (!deleted) throw new NotFoundError('Account not found');
      res.json({ ok: true, id });
    })
  );

  return router;
}

module.exports = { accountsRouter };
