---
name: p5-deploy-pm2-topology
description: P5 pm2 topology facts — fb-control/fb-worker shutdown timing chain (8s browser < 12s force < 15s kill), parallel browser close, worker-control inline restart config intentionally diverges from pm2.config.js
metadata:
  type: project
---

P5 deploy verified facts about the two-app pm2 topology (fb-control + fb-worker), so future reviews don't re-derive them:

- **Shutdown timing chain is sound:** worker SIGTERM -> gracefulShutdown (index.js:107, exits 0) -> shutdownAllBrowsers closes browsers IN PARALLEL (loop.js:175 `Promise.all`), each bounded 8s (BROWSER_CLOSE_TIMEOUT_MS) -> 12s force timer (SHUTDOWN_DEADLINE_MS, index.js:39) -> pm2 kill_timeout 15s. Parallel close means worst-case drain is ~8s regardless of account count, so 8s < 12s < 15s holds for any N. The earlier worry that N accounts x 8s sequential could blow the deadline does NOT apply.
- **Worker name/script contract holds:** pm2.config.js fb-worker name='fb-worker' script=index.js MATCHES server/config.js DEFAULTS.workerAppName/workerScript (frozen constants). RUNBOOK Appendix A has a one-liner CONTRACT-OK assertion. The old 'fb-bot' mismatch (H5) is fixed.
- **Intentional divergence (not a bug):** server/worker-control.js:113-114 hardcodes its own inline pm2 start config (max_restarts:10, restart_delay:10000, NO max_memory_restart) when the UI starts a worker that pm2 has never seen. This differs from pm2.config.js (max_restarts:50, exp backoff, max_memory_restart:1G). In normal operation `pm2 start pm2.config.js` registers the worker FIRST, so the UI path hits the `restart()` branch (worker-control.js:96) and inherits the richer pm2.config.js policy. The inline config only applies on a cold UI-first start that bypassed the ecosystem file — a degraded-but-safe fallback (no memory cap, lower restart budget). Worth a comment noting the divergence; not blocking.

**Why:** these are the load-bearing reliability claims the team asked to verify; all confirmed against source.

**How to apply:** if the pm2 config or shutdown deadlines change, re-verify the 8<12<15 ordering and the name/script contract. Related: [[p5-deploy-secret-exposure]].
