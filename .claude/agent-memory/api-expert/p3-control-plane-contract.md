---
name: p3-control-plane-contract
description: REST contract shape + known gaps of the Phase 3 control-plane API the P4 UI consumes
metadata:
  type: project
---

The Phase 3 control-plane is a local-only Express REST API at `server/` that the Phase 4 web UI is built directly against.

**Contract conventions (the UI relies on these):**
- snake_case at the JSON boundary everywhere EXCEPT the auth namespace, which uses camelCase (`csrfToken`, `authenticated`, `user`) — `server/routes/auth.js:84-88`. This is an accidental inconsistency, not a deliberate TWO-NAMESPACE design.
- Single stable error shape `{ error: { code, message, details? } }` enforced centrally in `server/errors.js` + the handler in `server/app.js:196-229`. zod issues map to field-level `details: [{path, message}]` (`server/routes/helpers.js:30-40`) — directly UI-consumable for form validation.
- Status codes are real + consistent: 201 create, 409 dup-name (create + patch-rename, with race-catch), 422 validation, 413 oversized, 400 bad-JSON, 404 re-delete, 403 CSRF.
- Account serialization is an allowlist (`server/serializers.js`) exposing `has_password`/`has_proxy_password` booleans, never ciphertext. Account read-after-write works (create/patch re-read + return full object with children).

**Worker model:** desired-vs-actual reconciliation — intent written to DB `worker_state.desired_state` FIRST (`server/routes/worker.js:59`), pm2 mechanism driven second. `/worker/status` exposes `desired_state` + `reported_status` + `heartbeat` (90s stale threshold) + `process` (pm2 view). Idempotent start (→restart if present) / stop (→`{action:'noop'}`).

**Known contract gaps flagged 2026-06-12 (verify fixed before trusting):**
1. HIGH — `GET /api/status/events` has no pagination metadata (no pageInfo/has_more/cursor), only flat `limit` newest-N — `server/routes/status.js:51-61`.
2. HIGH — worker start/stop spread `...result` inline (`{ok,desired_state,action,status}`) which DIFFERS from `/worker/status` structured shape — `server/routes/worker.js:62-80`. Two shapes for the same concept.
3. MED — `serializeSettings` does `{...row}` passthrough (`server/serializers.js:99`), no allowlist — settings API contract coupled to schema.sql columns.

**Why:** The UI hardcodes against these shapes next; gaps 1+2 change response shapes and should be fixed before P4 starts. See [[p4-ui-frontend-contract]] if/when P4 work surfaces UI-side coupling.

**How to apply:** When reviewing P4 UI code or further server changes, confirm gaps 1+2 were resolved; if the UI was built before the fix, flag a refactor. Treat the snake_case-except-auth split as a known wart.
