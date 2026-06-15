---
name: project-p2-module-decomposition
description: Phase 2 worker decomposition architecture — module map, DB-driven config adapter, humanizer/retry factories, per-account browser isolation
metadata:
  type: project
---

Phase 2 (2026-06-12) decomposed the 1,529-line `index.js` monolith into modules; behavior-preserving + DB-driven. Worker now loads config from SQLite (db.js), not accounts.json/config.json.

**Module map (dependency-ordered DAG):**
- `core/humanize.js` — `createHumanizer(settings)` FACTORY returns randInt/pickRandom/sleep/randomDelay/typeText bound to a settings snapshot (settings is snake_case db.getSettings() row). randInt/pickRandom/sleep also exported standalone.
- `core/retry.js` — `createRetry({settings, aiAct})` FACTORY returns withRetry. Vision gate preserved: `settings.use_vision && visionGoal && aiAct`. aiAct injected (null when use_vision off).
- `core/state.js` — DB-backed state keyed by `account.id` (NOT name/files). Pure helpers (cleanFbUrl/postHash/extractFbHandle/extractUserIdFromProfileUrl) are unit-test targets. writeSeenComments/writeDmSent are append-only (insert every set member; ON CONFLICT DO NOTHING makes re-writes idempotent — preserves monolith's "build Set, write at end" pattern).
- `fb/scope.js`, `fb/scrape.js`, `fb/actions/{like,comment,share,dm}.js`, `fb/monitor.js` — selectors preserved VERBATIM. All take humanizer `h` as a param (NOT a global) so both `h.randomDelay()` and `h.randomDelay(4000,7000)` explicit-bounds calls work.
- `worker/loadConfig.js` — Anti-Corruption Layer: `hydrateAccount(row)` maps snake_case DB → camelCase domain shape the fb/ code expects, while ALSO preserving numeric `.id` for state. Password NOT decrypted here (only at login time). proxy.passwordEnc carried encrypted, decrypted at context-build in worker/loop.js.
- `worker/loop.js` — checkAndAct + runAccount. **Per-account browser isolation**: each runAccount launches its OWN chromium (was shared in monolith — one crash killed all). launchBrowser/aiAct injectable for tests.
- `index.js` — slim entry (~85 lines): loadWorkerConfig() → install unhandledRejection/uncaughtException guards (do NOT exit — keep process alive) → staggered per-account launch (stagger from settings.account_stagger_ms).

**Key signature change:** sendDmToUser is now (page, account, url, settings, h) — 5 args (was 3). monitor forwards settings+h.

**DM enable gate:** was `config.enableDmToCommenters === false` (strict). Now `settings.enable_dm_to_commenters` (DB INTEGER 0/1) truthy gate — correct opt-in discipline.

Tests: 22→47 (added test/{state,retry,loadConfig}.test.js). Lint: 0 errors, warnings 11→5 (5 remaining all in unowned debug/* scripts). No git ops performed (user gates commits).
