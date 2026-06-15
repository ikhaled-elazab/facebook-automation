---
name: project-p4-web-ui
description: Phase 4 admin UI architecture — web/ Vite+React+TS SPA served same-origin by the Express control plane
metadata:
  type: project
---

The Phase 4 (P4) admin dashboard for the facebook-automation control plane lives in `web/` as a SELF-CONTAINED Vite + React 19 + TypeScript SPA with its OWN `web/package.json`, `web/eslint.config.js`, and lint/build scripts. Built to static assets in `web/dist/` (gitignored) and served SAME-ORIGIN by the Express control plane (`server/app.js`) so the session cookie + CSRF token work with zero CORS.

**Why a nested package, not root devDeps:** the toolchain (React/Vite/TS/eslint plugins) must NEVER ship to the VPS — the VPS only runs `node server/index.js` against root deps. Root gains only thin orchestration scripts: `ui:dev`, `ui:build`, `ui:lint`, `ui:typecheck`, `ui:install` (each `npm --prefix web run …`).

**How it's served:** `server/app.js` mounts `express.static(web/dist)` + a SPA history fallback AFTER all `/api/*` routes. The fallback (`app.get(/.*/, …)`) explicitly excludes `/api/` and `/healthz` so unknown API paths still return the JSON `{error:{code,message}}` 404, never SPA HTML. If `web/dist` is absent (pre-build), the root serves a friendly "run npm run ui:build" message instead of crashing `npm run control`.

**Verification command pattern (no real .env creds present):** the repo `.env` only has `APP_ENCRYPTION_KEY` + `OPENAI_API_KEY` — `ADMIN_USER`/`ADMIN_PASSWORD_HASH`/`SESSION_SECRET`/`CSRF_SECRET` are NOT set. To run the control plane for testing, generate a hash with `node server/set-password.js "pw"` and pass all secrets inline via `env VAR=… node server/index.js` (do NOT `source` a file with the bcrypt hash — the `$2b$` chars get shell-expanded and mangled). Use a non-default `CONTROL_PORT` (e.g. 8090) to avoid the 8080 default.

Gates were green: 77/77 backend tests, root lint 0 errors, UI typecheck + lint clean, build 91KB gzipped JS. P4 was working-tree-only (no commit); the user manually tests before committing.

See [[reference-control-plane-api-contract]] for the API shapes the UI binds to.
