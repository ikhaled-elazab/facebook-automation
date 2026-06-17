/*
 * api/types.ts — TypeScript mirror of the control-plane API contract.
 *
 * These types are derived directly from the server source (NOT guessed):
 *   - shapes:        server/serializers.js (ACCOUNT_PUBLIC_FIELDS, SETTINGS_PUBLIC_FIELDS)
 *   - writable input: server/schemas.js (create/update zod schemas)
 *   - errors:        server/errors.js ({ error: { code, message, details? } })
 *   - worker status: server/routes/worker.js (buildWorkerStatus)
 *   - status/feed:   server/routes/status.js
 *
 * The boundary is snake_case (matching the API); we keep snake_case end-to-end so
 * there is never a translation layer to drift out of sync with the server.
 */

// ── Error shape ─────────────────────────────────────────────────────────────

export interface ApiErrorDetail {
  /** Dotted field path, e.g. "name" or "min_action_ms"; "(root)" for form-level. */
  path: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Populated for 422 validation errors (field-level issues). */
    details?: ApiErrorDetail[];
  };
}

// ── Auth ────────────────────────────────────────────────────────────────────

export interface CsrfResponse {
  csrf_token: string;
}

export interface MeResponse {
  authenticated: boolean;
  user: string | null;
}

export interface LoginResponse {
  ok: true;
  user: string;
}

// ── Accounts (v2: account ENVELOPE only) ──────────────────────────────────────
//
// v2 multi-branch: an account is the IDENTITY + browser ENVELOPE (credentials,
// session, proxy, fingerprint) plus an account-level ceiling cap. All TARGETING
// and CONTENT moved to per-account Branch records (see Branch below):
//   moved to branch: target_page_url, own_profile_url, dm_as_page_url,
//                    send_dm_to_commenters, check_interval_minutes, enabled,
//                    daily_action_cap (per-branch), and the child collections
//                    (comments / replies / dm_messages / groups).
// `daily_action_cap` on the ACCOUNT is now the CEILING across all its branches.

/** Safe account projection (no secrets — has_* booleans instead). */
export interface Account {
  id: number;
  name: string;
  email: string;
  session_file: string;
  user_agent: string | null;
  locale: string;
  timezone_id: string;
  proxy_server: string | null;
  proxy_username: string | null;
  /** Account-level CEILING across all branches (null = inherit global cap). */
  daily_action_cap: number | null;
  created_at: string;
  updated_at: string;
  // Boolean columns (server coerces 0/1 → bool).
  enabled: boolean;
  // Derived "secret is set" booleans — the ciphertext never leaves the server.
  has_password: boolean;
  has_proxy_password: boolean;
  // Durable login state: whether a saved session (storageState) file exists — the
  // restart-proof "logged in" signal (the in-memory login status only tracks an
  // active attempt). `session_updated_at` is the file's mtime (epoch ms) or null.
  has_session: boolean;
  session_updated_at: number | null;
  // List-projection convenience: how many branches this account has. Present on
  // the list endpoint so the UI can show a branch-count badge without N+1 reads.
  branch_count: number;
}

export interface AccountsListResponse {
  accounts: Account[];
}

export interface AccountResponse {
  account: Account;
}

export interface DeleteAccountResponse {
  ok: true;
  id: number;
}

/**
 * Writable account ENVELOPE payload (create/update). Mirrors server/schemas.js.
 * Secrets (password, proxy_password) are WRITE-ONLY plaintext inputs; they are
 * never read back. Omitting a secret leaves the stored one unchanged. Targeting +
 * content fields are NOT here — they live on Branch.
 */
export interface AccountWritable {
  name: string;
  email: string;
  session_file: string;
  user_agent: string | null;
  locale: string;
  timezone_id: string;
  proxy_server: string | null;
  proxy_username: string | null;
  /** Account ceiling cap (null = inherit global). */
  daily_action_cap: number | null;
  enabled: boolean;
  // Write-only secrets — only sent when (re)setting them.
  password?: string;
  proxy_password?: string;
}

/** Create requires name/email/session_file; the rest fall back to DB defaults. */
export type AccountCreateInput = Partial<AccountWritable> &
  Pick<AccountWritable, 'name' | 'email' | 'session_file'>;

/** Update is a partial patch (at least one field). */
export type AccountUpdateInput = Partial<AccountWritable>;

// ── Branches (v2: per-account targeting + content) ────────────────────────────
//
// A Branch is one targeting context under an account: which page it monitors,
// the DM identity, its check cadence, its own daily cap (capped by the account
// ceiling), and its content collections. Each account has ≥1 branch; exactly one
// is the default. CONTRACT MIRROR of server/serializers.js (serializeBranch) +
// server/schemas.js (create/update branch zod). Snake_case end-to-end.

/** Safe branch projection (the serializer output, no children). */
export interface Branch {
  id: number;
  account_id: number;
  name: string;
  /** Exactly one branch per account is the default. */
  is_default: boolean;
  target_page_url: string;
  own_profile_url: string | null;
  dm_as_page_url: string | null;
  /** Per-branch daily cap (null = inherit the account ceiling / global). */
  daily_action_cap: number | null;
  check_interval_minutes: number;
  created_at: string;
  updated_at: string;
  // Boolean columns (server coerces 0/1 → bool).
  send_dm_to_commenters: boolean;
  enabled: boolean;
}

/** Branch child collections (replaced wholesale, same as accounts in v1). */
export interface BranchChildren {
  comments: string[];
  replies: string[];
  dm_messages: string[];
  groups: string[];
}

export type BranchWithChildren = Branch & BranchChildren;

export interface BranchesListResponse {
  branches: Branch[];
}

export interface BranchResponse {
  branch: BranchWithChildren;
}

export interface DeleteBranchResponse {
  ok: true;
  id: number;
}

/**
 * Writable branch payload (create/update). Mirrors server/schemas.js branch zod.
 * `account_id` is taken from the route, not the body. `is_default` is set via the
 * dedicated set-default endpoint (exactly-one invariant), not freely writable.
 */
export interface BranchWritable {
  name: string;
  target_page_url: string;
  own_profile_url: string | null;
  dm_as_page_url: string | null;
  send_dm_to_commenters: boolean;
  check_interval_minutes: number;
  /** Per-branch cap (null = inherit account ceiling). */
  daily_action_cap: number | null;
  enabled: boolean;
  // Child collections — replaced wholesale when present.
  comments?: string[];
  replies?: string[];
  dm_messages?: string[];
  groups?: string[];
}

/** Create requires name + target_page_url; the rest fall back to DB defaults. */
export type BranchCreateInput = Partial<BranchWritable> &
  Pick<BranchWritable, 'name' | 'target_page_url'>;

/** Update is a partial patch (at least one field). */
export type BranchUpdateInput = Partial<BranchWritable>;

// ── Settings ──────────────────────────────────────────────────────────────--

/** Settings projection (no secrets — keys live in .env). */
export interface Settings {
  headless: boolean;
  use_proxy: boolean;
  use_ai: boolean;
  use_vision: boolean;
  vision_model: string;
  vision_max_steps: number;
  log_dir: string;
  screenshot_on_error: boolean;
  enable_dm_to_commenters: boolean;
  min_action_ms: number;
  max_action_ms: number;
  min_typing_ms: number;
  max_typing_ms: number;
  account_stagger_ms: number;
  pacing_enabled: boolean;
  global_daily_action_cap: number;
  active_hours_start: number;
  active_hours_end: number;
  updated_at: string;
}

export type SettingsWritable = Omit<Settings, 'updated_at'>;
export type SettingsUpdateInput = Partial<SettingsWritable>;

export interface SettingsResponse {
  settings: Settings;
}

// ── Worker control + status ───────────────────────────────────────────────--

export interface HeartbeatHealth {
  lastHeartbeat: string | null;
  ageMs: number | null;
  /** null when no heartbeat has ever been recorded. */
  stale: boolean | null;
}

export interface WorkerProcessView {
  present: boolean;
  status: string;
  error?: string;
  // pm2 may add more fields; keep them addressable without `any`.
  [key: string]: unknown;
}

export type WorkerDesiredState = 'running' | 'stopped';
export type WorkerAction = 'started' | 'restarted' | 'stopped' | 'noop';

/** The canonical worker-status shape (GET /status and POST /start|/stop). */
export interface WorkerStatus {
  desired_state: WorkerDesiredState;
  reported_status: string;
  detail: string | null;
  heartbeat: HeartbeatHealth;
  process: WorkerProcessView;
  updated_at: string;
}

/** POST /start | /stop layer `ok` + `action` on top of the status shape. */
export interface WorkerActionResponse extends WorkerStatus {
  ok: true;
  action: WorkerAction;
}

// ── Status / dashboard / feed ─────────────────────────────────────────────--

/**
 * Per-branch cycle status vocabulary. Mirrors server/routes/status.js
 * ROLLUP_SEVERITY (worst-wins order: error > running > ok > paused > idle) and the
 * account_status.status column documented there. A branch that has never finished
 * a cycle is 'idle' (NEVER_RUN_STATUS default).
 */
export type StatusVocab = 'idle' | 'running' | 'ok' | 'error' | 'paused';

/**
 * Per-branch drill-down row in GET /api/status. The serializer projects an
 * EXPLICIT field subset (allowlist) onto each branch — see status.js
 * branchesByAccount mapping. `last_cycle_at` is the last COMPLETED cycle (bumped
 * only on ok|error), null until the branch has run once.
 */
export interface StatusBranchSummary {
  id: number;
  name: string;
  is_default: boolean;
  enabled: boolean;
  actions_today: number;
  last_status: StatusVocab;
  last_detail: string | null;
  last_cycle_at: string | null;
}

/**
 * Per-account rollup in GET /api/status. `last_status` is the account-level
 * rollup (worst branch status wins, so a failing branch never hides behind a
 * healthy sibling); `actions_today` is the sum across branches (the per-account
 * ceiling basis). `branches` carries the per-branch drill-down.
 */
export interface StatusAccountSummary {
  id: number;
  name: string;
  enabled: boolean;
  actions_today: number;
  last_status: StatusVocab;
  branch_count: number;
  branches: StatusBranchSummary[];
}

export interface StatusResponse {
  worker: {
    desired_state: WorkerDesiredState;
    reported_status: string;
    last_heartbeat: string | null;
  };
  accounts: StatusAccountSummary[];
  account_count: number;
}

export interface ActionLogEvent {
  id: number;
  account_id: number | null;
  // action_log.branch_id (ON DELETE SET NULL → null for orphaned rows after a
  // branch is deleted). Drives the per-branch event drill-down.
  branch_id: number | null;
  action_type: string;
  target_url: string | null;
  status: string;
  detail: string | null;
  created_at: string;
}

export interface EventsResponse {
  events: ActionLogEvent[];
  total: number;
  has_more: boolean;
  next_before: number | null;
}

export interface EventsQuery {
  limit?: number;
  account_id?: number;
  /** Optional per-branch filter for the per-branch event drill-down. */
  branch_id?: number;
  before?: number;
}

// ── Per-account login control (Model A: creds stored on the account; 2FA relayed
//    through the UI mid-flow) ───────────────────────────────────────────────--
//
// CONTRACT MIRROR of server/routes/login-control.js + server/login-control.js
// (the session registry's toPublic() view). The login flow is ACCOUNT-level (one
// envelope = one Facebook session), NOT per-branch. A login parks at 'needs_2fa'
// when Facebook challenges for an SMS/authenticator code; the operator types it in
// the UI and we POST it to resume the same server-side flow.
//
//   POST /api/accounts/:id/login        → launch; 202 Accepted, body { login }
//   GET  /api/accounts/:id/login/status → poll; 200, body { login }
//   POST /api/accounts/:id/login/2fa    → submit { code }; 200, body { login }
//
// EVERY endpoint wraps the view under a `login` key: { login: LoginSessionView }.
// Status codes the UI accounts for: launch 202 (success); concurrent launch 409
// (already running); no stored password 400; bad/empty 2FA code 422; 2fa when not
// awaiting a code 409. All non-2xx normalize to ApiError; the screen maps 409 via
// ApiError.isConflict and surfaces the rest as a clean message.
//
// SECURITY: the stored Facebook password NEVER rides this surface — the server
// already holds password_enc (set via the account editor's write-only field). The
// 2FA code is transient: typed, POSTed once, never persisted client-side.

/**
 * Login lifecycle for one account.
 *   idle        — no session started yet (or never launched).
 *   running     — the login is driving the browser; keep polling.
 *   needs_2fa   — parked awaiting a 2FA/SMS code from the operator (reveal input).
 *   needs_manual — a HEADED browser is open and the operator must finish login in
 *                  it (authenticator OTP, QR scan, or push-approve). Resolves when
 *                  the browser reaches a logged-in state — no code is relayed.
 *   ok          — logged in; the session file is now valid.
 *   failed      — the attempt failed (see `detail` for the reason).
 */
export type LoginStatus = 'idle' | 'running' | 'needs_2fa' | 'needs_manual' | 'ok' | 'failed';

/** How a login flow is being driven (mirrors the server's LoginSession mode). */
export type LoginMode = 'auto' | 'manual';

/**
 * Secret-free public session view (server: LoginSession.toPublic()). The control
 * layer exposes ONLY these fields — never email, password, or the 2FA code.
 * `started_at` / `finished_at` are epoch milliseconds (null until set).
 */
export interface LoginSessionView {
  account_name: string;
  status: LoginStatus;
  detail: string | null;
  /** Flow shape of the active/last session; null for the never-launched idle view. */
  mode: LoginMode | null;
  /** Epoch ms the login launched; null before the first launch. */
  started_at: number | null;
  /** Epoch ms the login reached a terminal state (ok|failed); null while active. */
  finished_at: number | null;
}

/** Every login endpoint wraps the view under `login`. */
export interface LoginEnvelope {
  login: LoginSessionView;
}

/** POST /login launch response — 202 Accepted; wrapped view. */
export type LoginLaunchResponse = LoginEnvelope;

/** GET /login/status response — 200; wrapped view. */
export type LoginStatusResponse = LoginEnvelope;

/** POST /login/2fa response — 200; wrapped view (status after the code is applied). */
export type Login2faResponse = LoginEnvelope;
