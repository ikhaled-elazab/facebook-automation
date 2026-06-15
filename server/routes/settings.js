'use strict';

/**
 * server/routes/settings.js — global settings get/update.
 *
 *   GET   /api/settings   -> full settings (no secrets — keys live in .env)
 *   PATCH /api/settings   -> partial update (validated against the column allowlist)
 *
 * The settings table holds the safety-first pacing fields (pacing_enabled,
 * global_daily_action_cap, active_hours_start/end, the *_ms timing ranges,
 * account_stagger_ms) so the future UI can edit pacing/safety directly.
 */

const express = require('express');
const { asyncHandler, parseOrThrow } = require('./helpers');
const db = require('../../db');
const { updateSettingsSchema } = require('../schemas');
const { serializeSettings } = require('../serializers');

/**
 * @param {{csrfProtection: import('express').RequestHandler}} deps
 * @returns {import('express').Router}
 */
function settingsRouter({ csrfProtection }) {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json({ settings: serializeSettings(db.getSettings()) });
    })
  );

  router.patch(
    '/',
    csrfProtection,
    asyncHandler(async (req, res) => {
      const patch = parseOrThrow(updateSettingsSchema, req.body);
      const updated = db.updateSettings(patch);
      res.json({ settings: serializeSettings(updated) });
    })
  );

  return router;
}

module.exports = { settingsRouter };
