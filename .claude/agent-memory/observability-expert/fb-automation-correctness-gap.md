---
name: fb-automation-correctness-gap
description: P5 observability has strong liveness (heartbeat/healthcheck) but a false-success correctness gap — action_log logs ok for failed actions
metadata:
  type: project
---

The fb-automation P5 monitoring stack has SOLID **liveness** (heartbeat ticker 25s < 90s staleness; scripts/healthcheck.js cron probe; pm2 process supervision; per-account account_status table fixing last-writer-wins) but a **correctness blind spot**.

**The false-success trap (CRITICAL):** `core/retry.js:86` — `withRetry` returns `undefined` on total failure (never throws). `worker/loop.js:263-269` — `governed()` does `await fn()` then unconditionally logs `status:'ok'`. So a like/comment/share that failed all attempts is recorded as `ok` in action_log. The doc comment at loop.js:219 claims "an 'ok'/'failed' row is logged" but there is NO `status:'failed'` write anywhere in the codebase (grep confirms zero). The action_log — the single richest "what did the bot do" signal and the governor's cap counter — therefore over-counts success and the operator's feed actively lies.

**Why this matters:** for an automation bot, "process up + fresh heartbeat" (which healthcheck.js checks) != "FB actions succeeding". A worker can be perfectly live while every action silently fails (login-session expired, selectors broke, FB checkpoint). There is no success-rate / error-rate signal the operator can see.

**Other gaps:** (1) account_status table exists in db.js (setAccountStatus/getAccountStatus/listAccountStatuses) but is NOT exposed via any /api route — per-account error status is written but unreadable by the operator. (2) trimActionLog retention IS wired (index.js:131) — good. (3) No ban/checkpoint detection in the worker runtime — login.js:185 detects checkpoint at login time only, not mid-run. (4) No alerting for control-plane (fb-control) down, disk-full, or pm2 restart-storm — only worker liveness.

**Why:** Verifying the team-lead's Phase 5 monitoring gate.
**How to apply:** When reviewing any automation-bot observability, separate liveness from correctness explicitly. A status field that's always 'ok' is worse than no field. Always grep for the failure-write path, don't trust the success-write path or the doc comment.
