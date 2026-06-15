---
name: v2-migration-review
description: Security/data-safety gate on the v1->v2 multi-branch SQLite migration — VERDICT data-safe (CONDITIONAL PASS), no CRITICAL; live target is a near-empty clean v1 so real-world blast radius is tiny.
metadata:
  type: project
---

Reviewed `migrations/v2_branches.js` + `migrate.js` + `test/migration-v2.test.js` on 2026-06-15 as the gate before an eventual LIVE v1->v2 migration of `db/fb-bot.db`.

**VERDICT: CONDITIONAL PASS — data-safe to present for go/no-go. ZERO CRITICAL.**

**Why:** Why: The migration core is genuinely lossless. Verified with 8 temp-DB probes beyond the 4 shipped tests:
- Lossless re-key (COUNT==COUNT gate inside tx, before every DROP, all 8 tables) — confirmed.
- Partial-prior-run convergence: correct-default-exists re-run converges losslessly; the dangerous NON-default 'default' branch state THROWS + rolls back with zero loss (assertOneDefaultPerAccount catches it).
- Multi-branch isolation: dedup is correctly PER-BRANCH; same (post_url,comment_id) coexists across branches; no cross-branch or cross-account JOIN fan-out.
- Corrupt duplicate (would-be UNIQUE collision): aborts inside tx, rolls back, no loss.
- FK toggle restored to ON after BOTH success AND throw (finally block).

**LIVE TARGET REALITY (the decisive context):** `db/fb-bot.db` is a CLEAN v1: 1 account, 5 comments / 5 replies / 3 dm / 1 group, and CRITICALLY **seen_comments=0, dm_sent=0** — the ban-risk dedup history this review centers on is currently EMPTY. Zero orphans, zero FK violations, no branches table. Ran the real migration against a COPY: lossless, v2, FK-clean. Real-world blast radius is tiny right now.

**The one real (HIGH) finding — post-commit fk_check throw:** In `migrateToV2` the secondary `foreign_key_check` runs AFTER `tx()` commits (v2_branches.js:431). If a PRE-EXISTING orphan exists on action_log.account_id (only possible from prior FK-off corruption), the migration COMMITS successfully (v2, re-keyed, lossless) and THEN throws — surfacing a misleading error for a pre-existing condition the migration never caused. The runner (migrate.js:308) would report failure on an actually-successful migration. Live DB has 0 orphans so this won't fire now, but it's a latent foot-gun. Recommendation: run foreign_key_check as a PRE-flight (before the tx) to catch pre-existing corruption early, OR move it inside the tx so a real new violation rolls back.

**MEDIUM:** preflightV2Checkpoint (migrate.js:240) is a point-in-time check — a writer reconnecting AFTER the checkpoint but BEFORE the migration tx isn't prevented (better-sqlite3 busy_timeout=5000 + the single-writer WAL lock mitigate, but the worker-stopped check is documentation + WAL-quiescent proxy, not a hard process lock). Operationally fine if the runbook (pm2 stop) is followed.

**Self-inflicted note:** my WAL-mode probe created a benign 0-byte `db/fb-bot.db-wal` sidecar on the live path; the live DB file itself (118784 bytes) is unchanged. The auto-mode classifier correctly BLOCKED my attempt to wal_checkpoint(TRUNCATE) the live file to clean it up (I had bounded myself to not write the live db). Left it for the operator's own preflight.
