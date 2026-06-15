---
name: p2-modular-architecture
description: Phase 2 decomposition of facebook-automation index.js monolith — module boundaries, ACL, factory pattern, and behavior-preservation status
metadata:
  type: project
---

Phase 2 decomposed the 1,529-line `index.js` monolith (preserved at git `ceda21c:index.js`) into core/ + fb/ + worker/ modules. Gate result: PASS (sound to build P3/P4/P5 on).

**Why:** Production conversion. The monolith mixed timing, retry, fs-state, FB selectors, and orchestration in one file with module-global config; needed clean seams for the control-plane (P3) and DB-backed state (already done in P1).

**How to apply (architecture facts that hold for future audits):**
- Dependency direction is strictly inward: `core/` and `fb/` NEVER require `worker/`; `core/` never requires `fb/`; leaf modules (ai.js, db.js, logger.js, crypto.js) have no back-edges. No circular deps.
- Factory pattern is real, not cosmetic: `createHumanizer(settings)` / `createRetry({settings,aiAct})` close over per-account settings; no timing/config globals remain. `config.delays.*` module-load defaults are GONE.
- The ACL is `worker/loadConfig.js#hydrateAccount` — sole snake_case→camelCase boundary. State is keyed by numeric `account.id` (preserved through hydration), NOT by name as the monolith did.
- Per-account browser isolation: monolith launched ONE shared `chromium` in `main()` and passed it to every `runAccount(browser, account)`; refactor moves launch INTO `runAccount` so each account owns its browser + has a `try/finally browser.close()`. This is the documented HIGH fix, verified genuine.
- Selectors are VERBATIM ports (scope.js, scrape.js, like.js, dm.js, monitor.js) — confirmed by diff against ceda21c.

**Known non-blocking carry-overs (pre-existing, NOT refactor regressions — do not re-flag as new):**
- `dailyActionCap` is hydrated (loadConfig.js:62) but never read anywhere — dead axis; never enforced in the monolith either.
- `comment.js` uses `dialog.$(sel)` where `dialog` can be null (latent null-deref, caught by withRetry) — identical to monolith; the dead `scope` var the monolith had was correctly dropped.
- Comment is AI-generated TWICE per post (loop.js:70 for vision-goal string + comment.js:27 for typed text) — identical to monolith (orig lines 659+1396); 2 AI calls/post is pre-existing.
- DM gate semantics changed opt-out (`config.X === false`) → opt-in (`!settings.enable_dm_to_commenters`); behaviorally equivalent because the column is `INTEGER NOT NULL DEFAULT 0` and migrate maps the old `false`→0 / `true`→1.

3 new test files (state/retry/loadConfig) assert real behavior (round-trips, retry control-flow, vision gating, ACL field mapping) — 25 tests, all pass. Not smoke-only.
