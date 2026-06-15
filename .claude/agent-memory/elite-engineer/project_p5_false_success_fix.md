---
name: project-p5-false-success-fix
description: P5 worker correctness — RETRY_FAILED sentinel + status vocab (ok/failed/skipped/blocked); fail-closed governor; mid-run ban-signal detection
metadata:
  type: project
---

P5 CORRECTNESS pass (3 fixes) landed in the untracked worker tree (`core/`, `worker/`, `fb/`, `db.js`, `test/` are all uncommitted P5 work — `git status` shows `??`).

**Status vocabulary CONTRACT (the edge engineer's error-rate probe depends on EXACTLY these action_log status values):**
- `'ok'` = action VERIFIED performed (the ONLY status `db.countActionsToday` counts toward daily caps)
- `'failed'` = attempted but failed all retries (+vision fallback)
- `'skipped'` = governor blocked it (cap/active-hours) OR a legitimate no-op (DM deduped, etc.)
- `'blocked'` = a Facebook checkpoint/challenge/login-redirect detected (ban signal — wakes the operator)

**Fix 1 — false-success (the root bug):** `core/retry.js:withRetry` returned `undefined` on attempts-exhaustion and NEVER threw, so `governed()` logged `'ok'` unconditionally. Fix = `RETRY_FAILED = Symbol('retry-failed')` (exported from core/retry.js), returned on exhaustion. A Symbol (not `result !== undefined`) is mandatory because likePost/commentOnPost return `undefined` ON SUCCESS — a naive non-undefined check INVERTS the bug.
- `worker/loop.js governed()`: `status = result === RETRY_FAILED ? 'failed' : 'ok'`; maps `RETRY_FAILED → null` on return so downstream SHARE-URL logic treats failure as no-URL.
- **Sentinel propagation hazard:** the MONITOR read (`worker/loop.js` ~line 296) bypasses `governed()` (reads aren't cap-counted), so its `if (!latest)` guard had to become `if (latest === RETRY_FAILED || !latest)` — a truthy Symbol would otherwise pass the falsy guard and crash on destructure. ALWAYS audit every raw withRetry consumer when changing the failure return from falsy→truthy.
- `fb/actions/dm.js sendDmToUser`: now returns `{sent:true}` | `{sent:false,reason:<no-op>}` | `{sent:false,reason:'error',error}`. monitor.js maps `sent→'ok'`, `reason:'error'→'failed'`, else→`'skipped'`. A DM that sent nothing must NOT count toward the cap.
- `fb/monitor.js` reply path: logs EXACTLY ONE row per attempted reply (`'ok'` on submit, `'failed'` on box-not-found/throw) via a `replyLogged` flag.

**Fix 2 — fail-closed governor:** `core/governor.js` added `safeCount()` helper. On count-source throw (SQLITE_BUSY/corrupt) or non-finite (NaN) → deny with `reason:'count_error'`. GOTCHA: `Number(null) === 0` (finite!) so null/undefined must be rejected BEFORE the `Number()` coercion, not via `Number.isFinite`. Both per-account AND global cap paths fail closed (symmetric). canAct still never throws.

**Fix 3 — mid-run ban detection:** new `core/ban-signal.js` (`detectBanSignal`, `isCheckpointUrl`, `probe`). `retry.js` catch block calls it per failed attempt with a per-call `banScope = {logged:false}` (de-dupes so one checkpoint logs once per withRetry call, not per attempt). Sniffs `page.url()` for /checkpoint|/challenge|/login|/recover + a few challenge DOM markers; logs ONE `status:'blocked'` row. Best-effort: NEVER throws (it runs inside an action's catch).

**db.js:** added DST-caveat doc comment at `countActionsToday` (local-day→UTC window is ±1h on DST-change nights; harmless for caps; do NOT "fix" — it would cost sargability). Query UNCHANGED.

**Logger retention (added same pass, edge-engineer flag):** `logger.js` wrote `logs/automation_YYYY-MM-DD.log` via appendFileSync with NO retention → unbounded growth (pm2-logrotate only covers pm2's own stdout capture, NOT app-written files). Added `pruneOldLogs(days)` + `logRetentionDays()`, env `LOG_RETENTION_DAYS` (default 30, mirrors ACTION_LOG_RETENTION_DAYS). Runs ONE best-effort sweep at module load (NOT a timer — logger is a leaf module imported by worker/control-plane/login.js/scripts; a setInterval would leak a timer into every importer; file name rolls daily so boot-only is sufficient). Prunes by filename-ENCODED date (not mtime), only matches `^automation_(\d{4}-\d{2}-\d{2})\.log$` (never touches stray/malformed files). SAFETY: coerces days<=0/NaN→30 INSIDE the function (same lesson as trimActionLog — a default param only fires for undefined, an explicit 0 would mean "delete everything before today").

Tests: 149 green (119 prior + 30 new across test/falsesuccess.test.js, test/dm.test.js, test/ban-signal.test.js, test/logger.test.js, + Fix-2 cases in test/governor.test.js, + RETRY_FAILED assertions updated in test/retry.test.js). Note: falsesuccess tests take ~3s each — `checkAndAct` calls the module-level `sleep(3000)` between SHARE/SHARE-GROUPS (not injectable via `ctx.h.sleep`).
