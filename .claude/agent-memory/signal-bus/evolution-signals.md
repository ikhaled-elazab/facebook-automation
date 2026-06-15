# Evolution Signals — Prompt Improvement Opportunities for Meta-Agent

Agents write EVOLUTION SIGNAL signals here. Meta-agent processes them all during Pattern F.

**Format:** `- (YYYY-MM-DD, agent=<name>, session=<id>) <evolution recommendation>`
**Processing:** BATCH — accumulated until Pattern F, then meta-agent evaluates and applies.
**Cleared:** After meta-agent processes.

---

<!-- Entries below this line — append new entries -->
- (2026-06-15, agent=database-expert, session=multibranch-design) database-expert should add a "SQLite table-rebuild discipline" idiom — this repo is SQLite not Postgres; the rebuild pattern (PK change via new-table/copy/drop/rename, FK-pragma bracketing the TX, version-gated idempotency, 3.35+ DROP COLUMN floor) recurs for every structural change. Existing migration-safety section is Postgres/Alembic-centric.
- (2026-06-15, agent=challenger, session=multibranch-design) database-expert migration template should MANDATE a row-count assertion in every table-rebuild: COUNT(__new)==COUNT(old) INSIDE the tx before DROP. FK check is necessary but not sufficient — zero-row INSERT...SELECT is a silent data-loss mode FK check cannot detect.
- (2026-06-15, agent=deep-planner, session=multibranch-design) deep-planner should add a "live-data migration" template clause: any migration of existing user data with dedup/idempotency history MUST (a) single transaction, (b) pre/post row-count assertions inside tx, (c) auto-route challenger into the migration gate.
- (2026-06-15, agent=elite-engineer, session=multibranch-design) elite-engineer should add: for any schema migration, run BOTH a direct-function round-trip test AND a full-runner integration test (the actual migrate.js/entrypoint path). The direct test misses ordering bugs between the migration and the app's schema-apply-on-open logic — the v2 branch_id-index-on-v1-table failure was invisible to the round-trip test and only surfaced via the runner.
- (2026-06-15, agent=typescript-expert, session=multibranch-design) [RAISED TWICE - high confidence] typescript-expert + test-engineer: for an untyped-JS-server/typed-TS-client boundary, green tsc proves ONLY TS-internal consistency, not that server JSON matches the types. Require a runtime contract test (exact-key deepStrictEqual on serialized endpoint JSON) as the gate, not tsc alone. The whole trio-divergence class was tsc-invisible at first gate; durability now rests on branches.test.js:619-626. Candidate for meta-agent prompt evolution.
- (2026-06-15, agent=deep-reviewer, session=multibranch-design) test-engineer should add to credential-decrypt test suites: (a) tampered/wrong-key ciphertext -> assert fail-closed 400 not 500 at the decrypt catch (only ABSENT password is tested today); (b) abort()-during-launchBrowser() -> assert browser closed when abort races an in-flight launch. Requirement coverage currently inferred from common paths, not directly asserted.
