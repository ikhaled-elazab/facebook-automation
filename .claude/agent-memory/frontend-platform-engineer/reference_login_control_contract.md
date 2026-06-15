---
name: login-control-contract
description: Per-account Facebook login UI contract (Model A creds + 2FA relay) — RECONCILED & CONFIRMED against the landed server/routes/login-control.js + server/login-control.js
metadata:
  type: reference
---

Phase 3.5 web/login half. Per-ACCOUNT login (one envelope = one FB session), NOT per-branch. Model A: email+password entered in the account editor → server encrypts to password_enc. 2FA code entered in the UI when the flow parks at needs_2fa. **CONFIRMED 2026-06-15 against the real server source — no longer assumed.**

**Actual server contract (server/routes/login-control.js + server/login-control.js toPublic()):**
- WRAPPED envelope: EVERY endpoint returns `{ login: LoginSessionView }` — must unwrap `.login`. (My initial UI assumed a BARE `{status, detail}`; that was the divergence — fixed.)
- `LoginSessionView = { account_name: string; status: LoginStatus; detail: string | null; started_at: number | null; finished_at: number | null }`. started_at/finished_at are epoch ms.
- `LoginStatus = 'idle' | 'running' | 'needs_2fa' | 'ok' | 'failed'` (unchanged, matched).
- `POST /api/accounts/:id/login` → **202 Accepted** (not 200; request<T> treats any 2xx as ok via res.ok, so 202 is transparent), body `{ login }`.
- `GET  /api/accounts/:id/login/status` → 200, body `{ login }`. Returns an explicit IDLE view (not 404) when no session has started; keeps returning terminal ok/failed after the flow ends (does NOT reset to idle) — so "stop polling, render last state" is correct.
- `POST /api/accounts/:id/login/2fa` body `{ code }` (login2faSchema: z.string().trim().min(1).max(32).strict) → 200, body `{ login }`.

**Status codes:** concurrent launch → 409 (ConflictError); no stored password → 400 (BadRequest); empty/oversize 2FA code → 422 (schema); **2fa when session is NOT awaiting a code → 409** (ConflictError, NOT 422 — the brief said 422 for "bad code" but that 422 is the schema/empty case; the not-awaiting case is 409). UI keys 409 via ApiError.isConflict; everything else surfaces via errorMessage() and keeps the operator at needs_2fa so the typed code is preserved.

**Frontend files (web/src):** api/types.ts (LoginSessionView + LoginEnvelope + the 3 wrapped response aliases), api/client.ts (`api.login.launch/status/submit2fa` all `.then(r => r.login)` to unwrap → return bare LoginSessionView), lib/useAccountLogin.tsx (`apply(view: LoginSessionView)` reads view.status/view.detail; 2s poll, visibility-pause, in-flight guard, terminal stops timer; 409-on-launch switches to polling existing flow), screens/AccountsScreen.tsx (`LoginCell` + `TwoFactorRelay`, read only hook fields), styles/screens.css (`.login-cell`).

**LESSON (envelope-shape divergence):** I built the login types against a documented contract before the server route landed and assumed a BARE response; the server actually WRAPS under `login` (consistent with this repo's `{account}`/`{accounts}`/`{branch}`/`{settings}`/`{events}` convention — every other endpoint here wraps too). Next time, when mirroring a not-yet-landed route, DEFAULT to the repo's existing wrapping convention rather than a bare shape. Also: started_at/finished_at are available in the view (epoch ms) if a "logging in for Ns" / "logged in at" display is ever wanted.
