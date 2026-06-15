# Cross-Agent Flags — Findings for Other Agents' Domains

Agents write CROSS-AGENT FLAG signals here when they discover something outside their domain.
CTO/Orchestrator routes to the target agent.

**Format:** `- (YYYY-MM-DD, agent=<source>, session=<id>, target=<agent>) <finding>`
**Processing:** IMMEDIATE — route to the target agent.
**Cleared:** After the target agent is dispatched with the finding.

---

<!-- Entries below this line — append new entries -->
- (2026-06-15, from=elite-engineer, session=multibranch-design) frontend-platform-engineer + api-expert: server/routes/accounts.js + server/routes/status.js still call REMOVED v1 accessors (setAccountComments, getAccountState, listAccountStatuses) and insert DROPPED columns (target_page_url on accounts) -> they 500 under v2. Phase 3 must re-key to branch accessors + add branch CRUD endpoints (db.insertBranch/updateBranch/deleteBranch/setDefaultBranch + BRANCH_UPDATE_COLUMNS ready). LIVE MIGRATION BLOCKED until server layer re-keyed.
- (2026-06-15, from=elite-engineer, session=multibranch-design) test-engineer: ~51 existing tests need v1->v2 migration (renamed accessors, three-tier governor semantics, hydrateAccount->hydrateBranch, v1 column inserts). test/migration-v2.test.js is the reference for the v2 shape.
- (2026-06-15, from=elite-engineer, session=multibranch-design) database-expert: live db/fb-bot.db is still v1; real v1->v2 migration must run with worker+control-plane STOPPED (BLOCKING-2 pre-flight enforces); user is acceptance gate for the live run.
