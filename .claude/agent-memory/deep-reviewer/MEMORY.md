# deep-reviewer — Memory Index

<!-- Format:
- [memory-title](file.md) — one-line description
-->

- [p1-secret-history-exposure](project_p1_secret_history_exposure.md) — crypto.js is sound, but live OpenAI key + FB passwords are still committed in git history (HEAD 72ff428); rotate + purge before calling P1 secure.
- [p2-worker-reliability](project_p2_worker_reliability.md) — P2 decomposition: crash-handler-keep-alive creates silent zombie accounts (no in-process restart + heartbeat never written); per-account browser orphan-on-SIGTERM leak; close/dedup/creds all sound.
- [p2-shutdown-concurrency](project_p2_shutdown_concurrency.md) — Post-fix shutdown/supervisor review: mostly correct (gracefulShutdown idempotent, two-altitude loop fixes zombie); HIGH launch-after-shutdown orphan window (loop.js:341-342); backoff never resets; DB-close-race REFUTED.
- [p4-ui-security-gate](project_p4_ui_security_gate.md) — P4 admin SPA security gate PASS; only real finding is MEDIUM latent javascript:-URL href XSS (no scheme check in client validate.ts OR server schemas.js z.url()); secrets/CSRF/static-serving/CSP all verified clean.
- [p5-governor-review](project_p5_governor_review.md) — P5 pacing governor: CRITICAL false-success logging (governed() logs 'ok' even when withRetry returns undefined on failure); decision logic all correct; conservative-on-error fails OPEN on NaN count; DB-throw does NOT reach supervisor (caught in checkAndAct).
