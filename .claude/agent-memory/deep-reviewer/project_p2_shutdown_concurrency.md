---
name: p2-shutdown-concurrency
description: Post-fix review of worker shutdown/supervisor concurrency — mostly correct; one real launch-after-shutdown orphan window; backoff never resets; DB-close-race REFUTED.
metadata:
  type: project
---

Reliability review (2026-06-12) of the shutdown/supervisor subsystem added to fix the [[p2-worker-reliability]] HIGHs (silent zombie account, orphan-browser-on-SIGTERM). Verdict: CONDITIONAL PASS — design is high-quality; the two-altitude loop genuinely fixes the zombie-account HIGH. Three things to remember:

**HIGH (real interleaving bug) — browser-launch-after-shutdown orphan window.** `worker/loop.js:341-342`: `const browser = await launchBrowser(); registerBrowser(browser);` has NO `shuttingDown` re-check between the launch await and the synchronous register. If SIGTERM lands while a supervisor is parked inside `launchBrowser()` (chromium launch = 1-3s), `shutdownAllBrowsers` (loop.js:130-136) sets `shuttingDown=true`, snapshots+clears `liveBrowsers` (the not-yet-launched browser isn't in it), closes, returns → then the launch resolves and `registerBrowser` adds a NEW browser into an already-swept Set. `process.exit()` from gracefulShutdown can fire before the session `finally` (loop.js:392) reaches `browser.close()` (the first guarded cycle at loop.js:384 awaits a 60-90s FB cycle; force-timer is 12s). Result: orphaned chromium tree — the exact leak the subsystem exists to prevent, in the launch-window case. Fix: `if (shuttingDown) { await browser.close().catch(()=>{}); return; }` right after loop.js:341, or make registerBrowser refuse-and-close when shuttingDown. NOTE: the BACKOFF-sleep path IS safe (re-checked at loop.js:469) — only the launch path leaks.

**MEDIUM — supervisor backoff never resets.** `loop.js:443` `backoffMs` is init once and only ever doubled (loop.js:470, cap 5min loop.js:305). No reset after a healthy long-lived session. A 3-day-healthy account that hits ONE transient browser death inherits whatever backoff it climbed to at boot → up to 5min recovery latency. Flapping-stays-capped is correct; healthy-session-reset is missing. Supervisor does NOT busy-loop (always `await sleep(backoffMs≥5000)` before retry — confirmed).

**REFUTED the builder's DB-close-race fear (Q6).** `closeDb()` (db.js:73-80) has ZERO callers in the worker path (grep-confirmed). `gracefulShutdown` (index.js:49-69) calls only `shutdownAllBrowsers()` then `process.exit()` — DB is never closed, so no heartbeat-after-close throw is possible. Doubly impossible: `heartbeat()`→`getDb()` (db.js:426) re-OPENS if `_db` is null. WAL + synchronous=NORMAL (db.js:50) makes abrupt `process.exit()` crash-safe — no corruption. The smell (not a bug today): no clean `closeDb()`/WAL-checkpoint on shutdown; matters more once control-plane shares the file.

**What is SOUND (verified this pass):**
- `gracefulShutdown` idempotency textbook: `shutdownStarted` latch (index.js:47-51) + unref'd force-timer + finally-exit. SIGTERM-then-uncaughtException runs cleanup exactly once.
- Two-altitude loop correct: `runCycleGuarded` (loop.js:362-378) truly never rejects — every throw in `runOneCycle` caught at loop.js:370. Fixes the zombie-account HIGH from [[p2-worker-reliability]].
- Heartbeat ticker reliably cleared all paths (stopHeartbeat first thing in shutdownAllBrowsers loop.js:132) + unref'd (loop.js:106) so never blocks exit.
- Registry: unregister-before-close in session finally (loop.js:395-396) correctly avoids double-close race with sweep. No close-without-unregister path.
- Browser closes are CONCURRENT (Promise.all loop.js:153), each 8s-bounded → total ~8s regardless of N; 12s ceiling (index.js:38) covers it. (Initially suspected serial N×8s — re-traced, it's concurrent.)

**MEDIUM/LOW — cycle heartbeat last-writer-wins.** worker_state is single row id=1 (db.js:429); the process-liveness ticker AND every account's per-cycle heartbeat (loop.js:366/373) write it. last_heartbeat (staleness) is reliable; status='error' for one account is overwritten by another's 'running cycle ok' → per-account error invisible to control-plane. Observability-only.

**Test gap persists:** loop.js still has no shutdown/supervisor test. Finding-1 is testable via `deps.launchBrowser` injection (set a flag during the await, fire shutdownAllBrowsers mid-launch, assert the launched browser was closed not left in liveBrowsers). Backoff-reset testable via deps.once.
