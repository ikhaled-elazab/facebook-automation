---
name: p4-ui-security-gate
description: P4 web UI security gate PASS — only real finding is javascript:-URL href XSS (MEDIUM, latent) because neither client validate.ts nor server schemas.js z.url() restricts scheme.
metadata:
  type: project
---

P4 admin SPA (web/) security gate, 2026-06-12. Verdict: PASS (secure for credential entry; P3 posture preserved).

**The one real finding — MEDIUM, latent javascript:-URL XSS:**
- Sink A: `web/src/screens/AccountsScreen.tsx:109` renders `href={acct.target_page_url}`.
- Sink B: `web/src/screens/ActivityScreen.tsx:196` renders `href={ev.target_url}` (action_log.target_url, db/schema.sql:154, written by `logAction` at db.js:336).
- Root cause: NEITHER layer restricts URL scheme. Client `isUrl()` (web/src/lib/validate.ts:16) uses `new URL(v)` which accepts `javascript:...`; server `optionalUrl = z.string().trim().url()` (server/schemas.js:27) also accepts `javascript:` (zod .url() / WHATWG parser does not enforce http(s)). So a `javascript:alert(document.cookie)` URL persists and clicking it runs script same-origin (where the session cookie lives).
- Why MEDIUM not CRITICAL: threat model is single trusted operator, loopback + SSH tunnel, single login. Self-XSS only — UNLESS `action_log.target_url` later ingests untrusted Facebook-scraped URLs (worker not yet wiring logAction callers as of this commit). If/when worker writes scraped URLs to target_url, this escalates to HIGH.
- Fix direction (for elite-engineer, NOT applied — assessment only): enforce `http(s)`-only scheme in server schemas.js (`.refine(u => /^https?:/i.test(u))`) AND client validate.ts; defense-in-depth render guard on the two hrefs.

**Verified clean (do not re-flag):**
- Write-only secrets: SecretField type=password, fromAccount() always password:'' / proxy_password:'', payload builders include secret only `if (form.password)`. No echo-back. State GC'd on navigate-away after submit.
- No persistence sinks (no localStorage/sessionStorage/IndexedDB/document.cookie), no import.meta.env secret exposure, no dangerouslySetInnerHTML/innerHTML/eval.
- CSRF: all 8 mutation routes have csrfProtection in chain; http.ts retries ONCE (_isRetry guard), token from GET /api/auth/csrf (32-byte, session-bound), auth via httpOnly cookie not JS.
- Static serving (server/app.js:198-251): mounted AFTER /api/*; SPA fallback excludes /api/ + /healthz; express.static root is fixed `path.resolve(..,web,dist)`; sendFile uses constant absolute path (no req.path concat) → no traversal. CSP UNCHANGED (scriptSrc 'self', no unsafe-inline/eval); built index.html has only ONE external module script (vite modulePreload polyfill:false). web/dist clean (no .map, no .env, asset-only). 127.0.0.1 bind intact (server/index.js:49).
- web/dist + web/node_modules NOT git-tracked (web/.gitignore covers both).
- ErrorBoundary console.error logs render error only (no secret path); both hrefs carry rel="noopener noreferrer".
