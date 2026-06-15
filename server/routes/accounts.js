'use strict';

/**
 * server/routes/accounts.js — account CRUD (the LOGIN ENVELOPE).
 *
 *   GET    /api/accounts            -> list (safe projection, no secrets)
 *   GET    /api/accounts/:id        -> get one
 *   POST   /api/accounts            -> create (encrypt secrets)
 *   PATCH  /api/accounts/:id        -> partial update (encrypt secrets)
 *   DELETE /api/accounts/:id        -> delete (branches + children + state + log
 *                                      cascade in the DB via ON DELETE CASCADE)
 *
 * PHASE 2 RE-KEY: an account is now ONLY the login envelope — credentials,
 * session file, browser fingerprint, proxy, and the per-account daily-cap
 * CEILING. The monitoring target + content arrays MOVED to branches (1 account :
 * N branches). Branch CRUD lives in routes/branches.js. Accordingly this router
 * no longer reads/writes child collections or the per-target columns; a stale
 * client that still sends them hits the account schema's `.strict()` → 422 (a
 * loud, correct failure, not a 500 against a dropped column).
 *
 * SECURITY:
 *   - All routes are behind requireAuth (wired in app.js) + CSRF on mutations.
 *   - FB password + proxy password arrive as plaintext, are encrypted via
 *     crypto.encrypt() into *_enc columns HERE, and are NEVER returned.
 *   - Responses go through serializers (allowlist projection).
 *   - A validated patch is split into {columns, secrets} using the fixed key-sets
 *     from schemas.js — no raw object is ever forwarded to db.js.
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
} = require('../schemas');
const { serializeAccount } = require('../serializers');
const { NotFoundError, ConflictError } = require('../errors');

/**
 * Attach branch_count to a serialized account. CONTRACT: types.ts declares
 * Account.branch_count as REQUIRED, so EVERY account response (list, get-one,
 * create, update) must carry it — never undefined. An account is the login
 * envelope; branch_count tells the UI how many monitoring units hang off it
 * (AccountsScreen renders it as a badge). The count is derived, not a column.
 * @param {Record<string, unknown>} serialized result of serializeAccount(row)
 * @param {number} count number of branches owned by this account
 * @returns {Record<string, unknown>}
 */
function withBranchCount(serialized, count) {
  return { ...serialized, branch_count: count };
}

/**
 * Split a validated account payload into the two destination streams.
 * @param {Record<string, unknown>} data validated payload
 * @returns {{columns:Record<string,unknown>, secrets:Record<string,string>}}
 */
function splitPayload(data) {
  const columns = {};
  const secrets = {};

  for (const key of ACCOUNT_COLUMN_KEYS) {
    if (key in data) columns[key] = data[key];
  }
  // Plaintext secrets -> encrypted *_enc columns (mapped explicitly, by name).
  if (data.password !== undefined) secrets.password_enc = encrypt(data.password);
  if (data.proxy_password !== undefined) {
    secrets.proxy_password_enc = encrypt(data.proxy_password);
  }
  return { columns, secrets };
}

/**
 * @param {{csrfProtection: import('express').RequestHandler}} deps
 * @returns {import('express').Router}
 */
function accountsRouter({ csrfProtection }) {
  const router = express.Router();

  // List — safe projection. branch_count comes from a SINGLE grouped query
  // (db.countBranchesByAccount) so the hot path stays O(1) queries, not O(N).
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const rows = db.listAccounts();
      const counts = db.countBranchesByAccount();
      res.json({
        accounts: rows.map((r) => withBranchCount(serializeAccount(r), counts.get(r.id) || 0)),
      });
    })
  );

  // Get one.
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const row = db.getAccountById(id);
      if (!row) throw new NotFoundError('Account not found');
      const count = db.listBranches({ accountId: id }).length;
      res.json({ account: withBranchCount(serializeAccount(row), count) });
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

      const { columns, secrets } = splitPayload(data);
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

      const row = db.getAccountById(newId);
      const count = db.listBranches({ accountId: newId }).length;
      res.status(201).json({ account: withBranchCount(serializeAccount(row), count) });
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

      const { columns, secrets } = splitPayload(data);
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

      const row = db.getAccountById(id);
      const count = db.listBranches({ accountId: id }).length;
      res.json({ account: withBranchCount(serializeAccount(row), count) });
    })
  );

  // Delete (branches + children + state + log cascade via FK ON DELETE CASCADE).
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
