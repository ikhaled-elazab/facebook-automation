# elite-engineer — Memory Index

<!-- Format:
- [memory-title](file.md) — one-line description
-->

- [project-live-db-index-apply](project_live_db_index_apply.md) — surgical one-off CREATE INDEX into live db/fb-bot.db vs full migrate; created_at sargability gotcha for P5 global daily-cap query
- [project-p2-module-decomposition](project_p2_module_decomposition.md) — Phase 2 worker module map; humanizer/retry factories; loadConfig ACL (snake→camel + .id); per-account browser isolation; crash guards in index.js
- [project-control-plane-p3](project_control_plane_p3.md) — P3 server/ API: db.js dynamic-column trust boundary, 3 missing db.js accessors, better-sqlite3-session-store unref+clear:false bugs, csrf-csrf×saveUninitialized gotcha, desired-vs-actual worker supervision
- [project-p2-worker-reliability](project_p2_worker_reliability.md) — P2 worker reliability HIGHs: zombie-account two-altitude loop+supervisor backoff, 25s heartbeat vs 90s threshold, module-scope orphan-browser shutdown+signals, per-id markCommentSeen flush, uncaughtException exit(1) policy; loop.js test seams
- [project-p5-deploy-hardening](project_p5_deploy_hardening.md) — P5 deploy: pm2 fb-control+fb-worker, the fb-worker name/script CONTRACT with server/config.js (H5 fb-bot mismatch fix), restart/memory policy, healthcheck intent-vs-mechanism alerts, pm2-logrotate is pm2 install not npm, per-VPS encryption key, login.js reads accounts.json
- [project-p5-governor](project_p5_governor.md) — P5 safety-first pacing governor: central canAct gate (decision-obj never-throws), sargable TZ-correct local-day-as-UTC cap query, per-account account_status (heartbeat last-writer-wins fix), trimActionLog days<=0 guard, comment.js scope||page null-deref fix; contract-drift test parses types.ts
- [project-p5-false-success-fix](project_p5_false_success_fix.md) — P5 correctness: RETRY_FAILED Symbol sentinel (fixes false-'ok' logging), status vocab ok/failed/skipped/blocked, dm.js {sent} result shape, fail-closed governor (Number(null)===0 gotcha), core/ban-signal.js mid-run checkpoint detection; sentinel-propagation hazard on raw withRetry consumers
