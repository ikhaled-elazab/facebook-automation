---
name: reference-control-plane-api-contract
description: Control-plane CSP reality + API contract facts the admin UI binds to (auth/CSRF, snake_case, worker status shape)
metadata:
  type: reference
---

**CSP reality (non-obvious):** `server/app.js` declares a SHORT CSP directives block (`default-src 'self'`, `script-src 'self'`, etc.) but helmet MERGES it with its defaults, so the ACTUAL served `Content-Security-Policy` is broader: `script-src 'self'` + `script-src-attr 'none'` (NO inline scripts/handlers — enforced), but `style-src 'self' https: 'unsafe-inline'`, `img-src 'self' data:`, `font-src 'self' https: data:`. So runtime inline `style={}` AND `data:` URIs in CSS actually WORK as deployed. The UI was still built CSP-strict-safe (CSS-only select chevron, no inline styles, no inline scripts via Vite `modulePreload:{polyfill:false}`) so it survives a future CSP tightening. Verify served headers with `curl -sI <base>/ | grep -i content-security-policy` — do NOT trust the source directives block.

**API contract facts (verified live):**
- Boundary is snake_case end-to-end; the UI keeps snake_case (no translation layer).
- Auth: `GET /api/auth/csrf` → `{csrf_token}` + sets session cookie. Send token in `x-csrf-token` header on ALL mutations (POST/PATCH/DELETE). Session cookie (httpOnly) carries auth.
- **On successful login the server `regenerate()`s the session** (new id) → the old CSRF token is invalidated. The client MUST re-fetch CSRF after login (the api client drops the cached token post-login so the next mutation refetches).
- 401 = not logged in; 403 = CSRF invalid (refetch token + retry once); 422 = validation with `details:[{path,message}]`; 409 = duplicate name.
- Accounts NEVER expose ciphertext — only `has_password`/`has_proxy_password` booleans (allowlist serializer). A grep for `password` false-positives on `has_password`; check for the exact field names `password_enc`/`proxy_password_enc` to test for a real leak.
- Account create REQUIRES `session_file` (a Playwright storageState path) with no server default — the UI auto-derives `sessions/<name>.json` from the name in an Advanced section so users don't need to understand it. POSSIBLE API ergonomics improvement: derive it server-side.
- Worker: `GET /api/worker/status` and POST `/start`|`/stop` all return the SAME shape `{desired_state, reported_status, detail, heartbeat:{lastHeartbeat,ageMs,stale}, process, updated_at}`; start/stop add `ok` + `action` (started/restarted/stopped/noop). Intent (desired_state) updates immediately; heartbeat lags ~1 tick (eventual consistency) — derive health: live/warn/down/pending.
- Feed: `GET /api/status/events?limit&account_id&before` → `{events,total,has_more,next_before}`; page older via `before=next_before`.

**P4 post-gate hardening (applied):**
- **URL scheme = http(s) only, BOTH layers.** zod `.url()` accepts `javascript:`/`data:` (it only checks parseability) → stored-XSS via `<a href>` (React does NOT strip a javascript: href). Fixed at `server/schemas.js` `optionalUrl` (single shared validator → covers target_page_url/own_profile_url/dm_as_page_url + groups array) with a `.refine()` on `new URL(s).protocol` ∈ {http,https}; mirrored in `web/src/lib/validate.ts` `isUrl`. Plus a `SafeUrl` component (`web/src/components/ui.tsx`) + `safeHref()` (`format.ts`) render-time guard: anchors only emit safe http(s) hrefs, else plain text. Test: server.test.js "non-http(s) URL scheme (stored-XSS defense)".
- **Single worker poller.** `useWorkerStatus` is now a Context (`WorkerStatusProvider` mounted in App.tsx RequireAuth) — one `/api/worker/status` poller shared by top-bar telemetry + Overview + Worker screen (was 2-3 independent pollers). File is `useWorkerStatus.tsx` (was .ts). Keeps visibility-pause + in-flight guard.
- **Unsaved-changes guard** (`web/src/lib/useUnsavedGuard.ts`): 3 layers — React Router `useBlocker` (in-app nav) + `attempt()` (explicit Cancel/Revert) + `beforeunload` (tab close). Dirty = `isEqualJson(form, baseline)` (`format.ts`). Used by AccountEditor + Settings; both render `<ConfirmDialog>`.
- ConfirmDialog title id now `useId()` (was hardcoded — collided with multiple dialogs).

See [[project-p4-web-ui]] for the build/serve setup.
