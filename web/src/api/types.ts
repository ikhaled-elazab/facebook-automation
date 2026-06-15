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

// ── Accounts ────────────────────────────────────────────────────────────────

/** Safe account projection (no secrets — has_* booleans instead). */
export interface Account {
  id: number;
  name: string;
  email: string;
  session_file: string;
  target_page_url: string;
  own_profile_url: string | null;
  dm_as_page_url: string | null;
  user_agent: string | null;
  locale: string;
  timezone_id: string;
  check_interval_minutes: number;
  proxy_server: string | null;
  proxy_username: string | null;
  daily_action_cap: number | null;
  created_at: string;
  updated_at: string;
  // Boolean columns (server coerces 0/1 → bool).
  send_dm_to_commenters: boolean;
  enabled: boolean;
  // Derived "secret is set" booleans — the ciphertext never leaves the server.
  has_password: boolean;
  has_proxy_password: boolean;
}

export interface AccountChildren {
  comments: string[];
  replies: string[];
  dm_messages: string[];
  groups: string[];
}

export type AccountWithChildren = Account & AccountChildren;

export interface AccountsListResponse {
  accounts: Account[];
}

export interface AccountResponse {
  account: AccountWithChildren;
}

export interface DeleteAccountResponse {
  ok: true;
  id: number;
}

/**
 * Writable account payload (create/update). Mirrors server/schemas.js exactly.
 * Secrets (password, proxy_password) are WRITE-ONLY plaintext inputs; they are
 * never read back. Omitting a secret leaves the stored one unchanged.
 */
export interface AccountWritable {
  name: string;
  email: string;
  session_file: string;
  target_page_url: string;
  own_profile_url: string | null;
  send_dm_to_commenters: boolean;
  dm_as_page_url: string | null;
  user_agent: string | null;
  locale: string;
  timezone_id: string;
  check_interval_minutes: number;
  proxy_server: string | null;
  proxy_username: string | null;
  daily_action_cap: number | null;
  enabled: boolean;
  // Write-only secrets — only sent when (re)setting them.
  password?: string;
  proxy_password?: string;
  // Child collections — replaced wholesale when present.
  comments?: string[];
  replies?: string[];
  dm_messages?: string[];
  groups?: string[];
}

/** Create requires the four core fields; the rest fall back to DB defaults. */
export type AccountCreateInput = Partial<AccountWritable> &
  Pick<AccountWritable, 'name' | 'email' | 'session_file' | 'target_page_url'>;

/** Update is a partial patch (at least one field). */
export type AccountUpdateInput = Partial<AccountWritable>;

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

export interface StatusAccountSummary {
  id: number;
  name: string;
  enabled: boolean;
  actions_today: number;
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
  before?: number;
}
