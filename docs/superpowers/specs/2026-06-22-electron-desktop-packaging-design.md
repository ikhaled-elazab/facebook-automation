# Design: Electron desktop packaging (dual-target: desktop + VPS)

- **Date:** 2026-06-22
- **Status:** Approved (design)
- **Author:** Khaled EL-Azab (with Claude)
- **Topic:** Wrap the existing `facebook-automation` Node app in an Electron desktop
  shell so it can run locally as a double-click app, while the existing VPS
  deployment continues to run unchanged from the same repository.

## 1. Goal & constraints

Ship a desktop (Electron) build of the app for **macOS and Windows** without
disturbing the current VPS deployment. The same repository must keep running on
the VPS exactly as today (`npm run control` + `pm2 start pm2.config.js`).

Decisions confirmed with the user:

| Decision | Choice |
| --- | --- |
| Login UX on desktop | **Keep the admin login screen** (same as VPS) → requires a first-run setup wizard to set the admin password. |
| Chromium delivery | **Bundle chromium** inside the installer (offline, deterministic). |
| OS targets | **macOS + Windows.** |
| Distribution | **Unsigned local build** (no code-signing / notarization). |
| Control plane process model | **In-process** in the Electron main process (one fewer process). |
| Window-close behavior | **System tray with background run** — closing the window does not stop automation; Quit from the tray. |
| Encryption-key storage | **OS keychain via Electron `safeStorage`**; other secrets in `config.json` (0600). |

Non-goals (explicitly out of scope): code signing / notarization, auto-update,
a Linux build, and any change to Facebook-automation behavior, the worker, the
React UI, the DB schema, `login.js`, `crypto.js`, or the VPS runbook.

## 2. Current architecture (as discovered)

- **Control plane** — `server/index.js` boots an Express app (`server/app.js`),
  binds **loopback only** (enforced in `server/config.js`; non-loopback
  `CONTROL_HOST` aborts startup), serves the static React UI, and attaches an
  authenticated login-stream WebSocket (`server/login-stream-ws.js`) to the same
  HTTP server. Auth = admin session + CSRF, all secrets required from env.
- **Worker** — `index.js`, chromium-heavy (one Playwright/chromium per enabled
  account). Exits 0 on SIGTERM (graceful shutdown).
- **Worker supervision** — `server/worker-control.js` drives the worker through
  **pm2's programmatic API** (`{ start, stop, status }`). `pm2.config.js` brings
  both processes up on the VPS. The UI Start/Stop button calls this module; the
  desired state lives in SQLite (`worker_state.desired_state`), and the worker
  writes its own heartbeat/status.
- **Secrets** — `APP_ENCRYPTION_KEY` (AES-256-GCM for FB creds, `crypto.js`),
  `SESSION_SECRET`, `CSRF_SECRET`, `ADMIN_USER`, `ADMIN_PASSWORD_HASH` (bcrypt).
  All read from `process.env` (via `.env` on the VPS). The encryption key is
  **not** machine-bound in code — it is portable if carried.
- **Native / heavy deps** — `better-sqlite3` (native module), Playwright chromium.

The two facts that make this tractable: the control plane is **already
loopback-only** (perfect for an Electron window), and worker supervision is
**already behind a 3-method interface** (`start/stop/status`) — so only the
mechanism behind it needs to change for desktop.

## 3. Chosen approach

An **Electron shell over the existing control plane.** Electron's main process
boots the current control plane in-process on a loopback port and opens a window
at it. The worker stays a separate process, supervised via a **new
child-process backend** behind the same `worker-control` interface. pm2 remains
the default backend; desktop selects the child backend via config.

Rejected alternatives:

- **Bundle pm2 inside Electron** — ships a global daemon inside a desktop app
  (daemon-lifecycle and port fragility, messy shutdown, pm2-in-Electron is
  finicky). No upside.
- **Tauri instead of Electron** — still must bundle Node + chromium + native
  `better-sqlite3`; chromium dominates installer size regardless, so a Rust
  toolchain buys marginal size for lost Node integration.

## 4. Components & changes

### 4.1 Worker supervision abstraction (server-side)

- `server/worker-control.js` → thin **dispatcher** selecting a backend from
  `config.worker.supervisor`:
  - `'pm2'` (default) → `server/worker-control-pm2.js`
  - `'child'` → `server/worker-control-child.js`
- `server/worker-control-pm2.js` — the **existing pm2 logic, relocated
  verbatim** (byte-identical behavior). Same `{ start, stop, status }` exports.
- `server/worker-control-child.js` — new. Supervises the worker as a forked
  child:
  - `child_process.fork(config.worker.script)` with `cwd = config.worker.cwd`
    and env `{ ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production' }`
    (so the Electron binary runs `index.js` as plain Node).
  - Holds the `ChildProcess` handle as module singleton (valid because on
    desktop the control plane is a single long-lived process).
  - `start()` — idempotent: if a live child exists, restart it; else fork.
  - `stop()` — set a "deliberate stop" flag, send SIGTERM, wait up to a kill
    timeout (mirror `pm2.config.js` `kill_timeout: 15000`), then SIGKILL; no
    auto-restart while the flag is set.
  - On **unexpected** child exit (flag not set) → restart with backoff and a
    max-restart budget, mirroring pm2 semantics (`restart_delay`,
    `exp_backoff_restart_delay`, `max_restarts`).
  - `status()` — report `{ present, status, pid, uptime, restarts }` from the
    held handle, shaped to match the pm2 backend's return so routes are
    backend-agnostic.
- `server/config.js` — add `worker.supervisor` (env `WORKER_SUPERVISOR`,
  whitelist `pm2|child`, **default `pm2`**). The VPS never sets it → unchanged.

### 4.2 Control-plane boot extraction (small, shared refactor)

Extract the boot sequence currently inline in `server/index.js` `main()`
(loadConfig → `db.getDb()` → `createApp(config)` → `listen(host, port)` →
`attachLoginStreamWs` → shutdown wiring) into **`server/boot.js`**:

- Exports `startControlPlane({ config, logger })` → `{ server, app, shutdown }`,
  where `shutdown()` performs the existing drain sequence (close login-stream
  sockets → abort login flows → `server.close` → `db.closeDb`) **without**
  calling `process.exit`.
- `server/index.js` `main()` delegates to `startControlPlane` and keeps its
  `process.exit` paths and SIGINT/SIGTERM handlers — **VPS behavior identical**.
- `electron/main.js` calls `startControlPlane` in-process and owns shutdown via
  Electron's lifecycle instead of `process.exit`.

### 4.3 Electron shell (`electron/`)

`electron/main.js` — the long-lived desktop supervisor:

1. **Path resolution** — under `app.getPath('userData')`: `db/fb-bot.db`,
   `logs/`, `config.json`.
2. **First-run setup** — if `config.json` is absent, open a small **bundled HTML
   setup window** (not the React app, which cannot boot without an admin hash).
   It collects admin username + password and submits them over a single
   contextIsolated IPC channel. The main process then:
   - bcrypt-hashes the password (reuse `server/set-password.js` hashing logic),
   - generates `APP_ENCRYPTION_KEY` (via `crypto.generateKey()`), `SESSION_SECRET`,
     `CSRF_SECRET`,
   - stores the **encryption key in the OS keychain via `safeStorage`** and the
     remaining secrets + admin user + admin hash in `config.json` (mode 0600).
3. **Env injection** — set `process.env` from the resolved config + secrets,
   plus `WORKER_SUPERVISOR=child`, `DB_PATH=<userData>/db/fb-bot.db`,
   `PLAYWRIGHT_BROWSERS_PATH=<bundled chromium>`, `CONTROL_HOST=127.0.0.1`,
   `CONTROL_PORT=<free port>`, `NODE_ENV=production`.
4. **Migrations** — run the migration step (idempotent) against the userData DB
   before booting.
5. **Boot + window** — call `startControlPlane(...)` in-process, then open a
   `BrowserWindow` at `http://127.0.0.1:<port>` (existing React UI + login).
   Reconcile worker state on boot: if `worker_state.desired_state === 'running'`,
   start the worker.
6. **System tray** — closing the window hides it (worker keeps running); tray
   menu = Show / Quit. **Quit** → graceful shutdown: stop the worker (SIGTERM +
   kill timeout) → `shutdown()` the control plane → `app.quit()`.

`electron/preload.js` — minimal, `contextIsolation: true`, `nodeIntegration:
false`; exposes only the setup-form IPC channel to the setup window.

`electron/setup.html` — the first-run form (username, password, confirm).

### 4.4 Packaging (`electron-builder`)

- **Native module** — `@electron/rebuild` rebuilds `better-sqlite3` against
  Electron's ABI. `asarUnpack` the native `.node` artifacts and the forked
  worker entry (`index.js` + its require graph) so `child_process.fork` resolves
  a real on-disk path.
- **Chromium** — a build step runs `playwright install chromium` into a staged
  directory; ship it via `extraResources`; at runtime point
  `PLAYWRIGHT_BROWSERS_PATH` at the unpacked resources location.
- **Targets** — macOS (`dmg` + `zip`, `identity: null`) and Windows (`nsis`).
  No signing.
- **Electron entry point** — `package.json` `main` **stays `index.js`** (the
  worker entry; the VPS depends on nothing reading `main`, since pm2 and the npm
  scripts reference scripts by explicit path). Electron is pointed at the shell
  two ways without touching `main`:
  - dev: `electron:dev` runs `electron electron/main.js` (an explicit entry path
    overrides the `main` field);
  - packaged: electron-builder sets `build.extraMetadata.main = "electron/main.js"`,
    which rewrites `main` only inside the bundled app's `package.json`.

  This keeps the worker contract in `pm2.config.js` / `server/config.js`
  untouched while the packaged desktop app launches the shell.
- **Scripts** (new, in `package.json`) — `electron:dev`, `electron:rebuild`,
  `dist:mac`, `dist:win`. **DevDeps** — `electron`, `electron-builder`,
  `@electron/rebuild`.

## 5. What stays identical (VPS guarantee)

`index.js` (worker), `login.js` (manual/CDP-screencast 2FA/QR/push login),
the React UI, `crypto.js`, the DB schema, `pm2.config.js`, `server/app.js`, and
the VPS runbook. `server/index.js` `main()` keeps identical behavior (delegating
to the extracted `boot.js`). The relocated pm2 supervision logic is verbatim.
Desktop-only behavior is gated entirely behind `WORKER_SUPERVISOR=child` and the
`electron/` directory.

## 6. Risks & mitigations

- **`fork` from inside an asar archive** — mitigate by `asarUnpack`-ing the
  worker entry and its deps; verify the forked path resolves in a packaged
  build, not just `electron:dev`.
- **`better-sqlite3` ABI mismatch** — `@electron/rebuild` in the build pipeline;
  smoke-test a packaged build opens the DB.
- **Port conflict on `CONTROL_PORT`** — pick a free ephemeral port at launch
  rather than a fixed 8080; the window is pointed at the chosen port.
- **`safeStorage` unavailable** (rare on mac/win) — fall back to storing the
  encryption key in `config.json` (0600) with a logged warning. Targets are
  mac+win where `safeStorage` is reliable.
- **Control plane crash takes the app down (in-process)** — accepted trade-off
  for a single-user local app; wrap boot in try/catch and surface a dialog.

## 7. Verification (acceptance criteria)

1. **VPS unchanged** — `npm run control` and `pm2 start pm2.config.js` behave
   exactly as before; existing tests pass; `WORKER_SUPERVISOR` unset → pm2 path.
2. **`electron:dev`** — first launch shows the setup wizard; after setting a
   password, the window loads the UI and login succeeds with those credentials.
3. **Worker via child backend** — UI Start launches a forked worker that opens
   chromium and runs; UI Stop terminates it; unexpected death auto-restarts;
   app Quit leaves no orphaned chromium.
4. **Manual login** — 2FA/QR/push streams into the desktop window as on the VPS.
5. **Packaged build (mac + win)** — installs, runs offline (bundled chromium),
   opens the DB (rebuilt `better-sqlite3`), and forks the worker successfully.
