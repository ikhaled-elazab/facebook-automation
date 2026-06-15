---
name: project-fb-automation-prodgrade
description: facebook-automation bot production-grade conversion engagement — mandate, locked decisions, urgent secret fix applied, architecture direction
metadata:
  type: project
---

# facebook-automation → production-grade (engagement started 2026-06-12)

**Mandate (verbatim):** "convert this project to production grade also create ui for inserting data instead of json config"

**What it is:** Multi-account Facebook automation bot. Node.js CommonJS + playwright-extra + puppeteer-extra-plugin-stealth. Optional OpenAI for AI comments/replies + gpt-4o-mini vision fallback. index.js is ~1529 lines, entire orchestrator entangled in one file.

## Locked decisions (do NOT re-ask)
1. UI form factor: local-only web dashboard, bound to localhost.
2. Deploy target: VPS / single Linux server, existing pm2 setup (pm2.config.js).
3. Scope: FULL hardening — modularize, real datastore, secrets mgmt, error handling/observability, UI, tests, deployment.

**Architectural direction (CTO-owned):** 2-process architecture — long-lived worker (bot loop) + localhost-bound web control plane (UI/API) sharing a datastore. UI starts/stops/observes worker. On VPS: bind to 127.0.0.1, access via SSH tunnel, single login as defense-in-depth. Datastore: SQLite is the likely pragmatic choice for single VPS. Worker<->control-plane coordination is the central design decision.

## URGENT secret fix — APPLIED this pass (2026-06-12), NOT committed
- config.json:14 had LIVE OpenAI key (committed). accounts.json:5 had PLAINTEXT FB password (committed). **sessions/account1.json was a LIVE Playwright auth session committed to git** (worse than brief stated — credential+2FA-bypass equivalent). debug_dom*.html committed. No .gitignore. node_modules tracked (2681 files).
- Done: created .gitignore, .env (real key, gitignored), .env.example, config.example.json, accounts.example.json; `git rm --cached` on config/accounts/sessions/debug_dom + node_modules. Files remain on disk. Staged, NOT committed.
- **USER MUST: rotate the OpenAI key, treat FB password as compromised. Code can't undo git-history exposure. Did NOT scrub history (destructive) — recommended only.**

## Why secrets are committed (compliance context)
This is the user automating their OWN FB accounts (marketing/engagement). ToS/ban/detection risk is a legitimate PRODUCTION concern to surface, not a refusal reason.

## Execution state
- Plan P1-P5 APPROVED by user 2026-06-12. SQLite confirmed. Safety-first pacing confirmed (longer randomized intervals, daily caps, active-hours, jitter — all UI-tunable).
- **HARD CONSTRAINT (every dispatch):** NO git commits by anyone. All work stays in working tree/staged. USER manually tests each phase and is the sole acceptance gate. If a commit seems needed, surface to user — never commit.
- **Execution model:** phase-by-phase, STOP after each for user manual test. Do P1 only, return, await re-engagement for P2+P3 (parallel).

## Phase 1 — COMPLETE (2026-06-12), NOT committed
Built (new): db/schema.sql, db.js, crypto.js (AES-256-GCM), migrate.js (idempotent+lossless), eslint.config.js, .prettierrc.json, .prettierignore, test/{crypto,db,migrate}.test.js. Modified: ai.js+vision.js (now read process.env.OPENAI_API_KEY via dotenv, NOT config.json — rewire caveat from assessment RESOLVED), package.json (scripts+deps), .gitignore (added db/*.db). Deps added: better-sqlite3, dotenv (runtime); eslint, prettier (dev). Test runner = node:test (built-in, no vitest).
- Gates (self-reviewed — team tooling DOWN both runs, no independent agents): 22/22 tests pass; lint 0 errors (12 legacy warnings in P2-target files); real migration of account1 verified lossless (password Rana@aba1 decrypts, 5/5/1/3 children match).
- APP_ENCRYPTION_KEY generated into .env (dev box). On VPS user must generate a SEPARATE key.
- DB file db/fb-bot.db created locally + gitignored (contains encryptable creds).

**Next:** P2 (modularize index.js) + P3 (control-plane API) in parallel — awaiting user manual test of P1 + re-engagement.
