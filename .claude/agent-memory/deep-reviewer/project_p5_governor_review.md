---
name: p5-governor-review
description: P5 pacing governor correctness review — false-success logging is the one CRITICAL; governor is conservative+non-throwing in unit-tested paths but a live DB throw in countActionsToday bubbles to the supervisor.
metadata:
  type: project
---

P5 anti-ban pacing governor (core/governor.js + worker/loop.js governed()) reviewed 2026-06-12. Verdict: NOT production-trustworthy until the false-success bug is fixed; governor decision logic is otherwise correct + conservative.

**CRITICAL — false-success logging (worker/loop.js:263-269).** `governed()` does `const result = await fn(); record({... status:'ok'})` UNCONDITIONALLY. `withRetry` (core/retry.js:86) RETURNS `undefined` on attempts-exhaustion (never throws). So a FAILED action logs `status:'ok'`, which `db.countActionsToday` (db.js:366, `status='ok'` filter) counts toward the daily cap. Blast radius: (1) cap is consumed by FAILED actions → bot stops early thinking it hit the cap (this direction is SAFE for anti-ban — it OVER-blocks); (2) /events feed shows false green; (3) NO 'failed' write path exists repo-wide despite schema.sql:155 documenting `failed` as a valid status. **Why:** withRetry's swallow-and-return-undefined contract was not connected to governed()'s log path. **How to apply:** the fix is `const result = await fn(); const ok = result !== undefined && result !== false; record({... status: ok ? 'ok' : 'failed'})`. Caveat: actions that legitimately return undefined on success (commentOnPost, shareToGroups return nothing) would then log 'failed' on SUCCESS — the fix must make each action return a truthy success sentinel OR governed() must treat "no throw" as success and only mark 'failed' on an explicit failure signal. This is the load-bearing nuance the builder must resolve.

**Governor never-throws: HOLDS in-process, BREAKS at the DB boundary.** core/governor.js canAct() has no try/catch around countActionsToday (governor.js:131,143). The injected default is `db.countActionsToday` which calls getDb().prepare().get() — a locked/corrupt/disk-error DB THROWS, and that throw bubbles canAct → governed → the outer checkAndAct try (loop.js:272 catches it, so the CYCLE survives) BUT monitor.js:236 calls governor.canAct() inside the per-article try only, and a throw there is caught per-article. Net: a DB throw in canAct does NOT reach the supervisor in checkAndAct (caught at loop.js:373) — so "throw bubbles to supervisor → restart" is REFUTED for the main path. localHour bad-tz fallback (governor.js:52-68) is correctly try/caught — never throws.

**Conservative-on-error is WRONG (fail-OPEN).** This is the real reliability gap, not the throw. If countActionsToday throws, canAct throws, governed never reaches `await fn()` — action is effectively skipped (safe). BUT if countActionsToday returns NaN/undefined (it returns `row ? row.n : 0`, so 0 on empty — never NaN from the real impl), `acctCount >= acctCap` with NaN is `false` → ALLOWED. A custom/injected count fn returning NaN fails OPEN. For an anti-ban system ambiguity must fail toward DENY. **How to apply:** governor should treat a non-finite count as "cap reached" (deny), and wrap countActionsToday in try/catch that denies on throw rather than letting it propagate.

**Decision correctness: ALL CORRECT.** 0=unlimited special-cased BEFORE count query (governor.js:130,142 — `if (cap > 0)`); active-hours start===end=full-day (governor.js:82), overnight wrap (governor.js:84), account-local hour via timezoneId (governor.js:117); per-account null inherits global (governor.js:128-129); MONITOR read NOT gated/counted (loop.js:273-274), reply+DM ARE gated (monitor.js:236) and counted (monitor.js:307,332).

**comment.js:50 carry-over fix CORRECT** — `scope = dialog || page` matches like.js:72 and share.js:43 exactly. No regression.

**Contract test (test/contract.test.js) is NON-VACUOUS** — interfaceFields() brace-walks real web/src/api/types.ts (verified 13 interfaces exist), drives REAL endpoints, asserts `fields.length >= 15` sanity floor (line 199) so a failed-parse-to-empty can't pass silently, and removing a server field → `missing` non-empty → assert fails. Confirmed it catches drift.
</content>
</invoke>
