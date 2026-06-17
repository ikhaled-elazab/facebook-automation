import { request, ensureCsrfToken, clearCsrfToken } from './http';
import type {
  Account,
  AccountCreateInput,
  AccountResponse,
  AccountUpdateInput,
  AccountsListResponse,
  Branch,
  BranchCreateInput,
  BranchResponse,
  BranchUpdateInput,
  BranchWithChildren,
  BranchesListResponse,
  DeleteAccountResponse,
  DeleteBranchResponse,
  EventsQuery,
  EventsResponse,
  Login2faResponse,
  LoginLaunchResponse,
  LoginMode,
  LoginResponse,
  LoginSessionView,
  LoginStatusResponse,
  MeResponse,
  Settings,
  SettingsResponse,
  SettingsUpdateInput,
  StatusResponse,
  WorkerActionResponse,
  WorkerStatus,
} from './types';

/*
 * client.ts — the typed API surface every screen calls.
 *
 * One function per endpoint. All requests go through `request()` which handles
 * credentials, CSRF, error normalization, and the 403-retry/401-redirect logic.
 * Snake_case is preserved end-to-end (no translation layer to drift).
 */

export const api = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  auth: {
    /** Pre-fetch a CSRF token + establish the bootstrap session (call before login). */
    csrf: (): Promise<string> => ensureCsrfToken(true),

    me: (): Promise<MeResponse> => request<MeResponse>('/api/auth/me'),

    async login(username: string, password: string): Promise<LoginResponse> {
      // The session id rotates on successful login (server regenerates it), which
      // invalidates the bootstrap CSRF token. Ensure we hold a token bound to the
      // CURRENT (pre-login) session for the login POST itself...
      await ensureCsrfToken();
      const res = await request<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      // ...then drop it so the next mutation fetches one bound to the NEW session.
      clearCsrfToken();
      return res;
    },

    async logout(): Promise<void> {
      try {
        await request<{ ok: true }>('/api/auth/logout', { method: 'POST' });
      } finally {
        clearCsrfToken();
      }
    },
  },

  // ── Accounts (v2: envelope only — targeting/content live on branches) ───────
  accounts: {
    list: (): Promise<Account[]> =>
      request<AccountsListResponse>('/api/accounts').then((r) => r.accounts),

    get: (id: number): Promise<Account> =>
      request<AccountResponse>(`/api/accounts/${id}`).then((r) => r.account),

    create: (input: AccountCreateInput): Promise<Account> =>
      request<AccountResponse>('/api/accounts', { method: 'POST', body: input }).then(
        (r) => r.account
      ),

    update: (id: number, patch: AccountUpdateInput): Promise<Account> =>
      request<AccountResponse>(`/api/accounts/${id}`, { method: 'PATCH', body: patch }).then(
        (r) => r.account
      ),

    remove: (id: number): Promise<DeleteAccountResponse> =>
      request<DeleteAccountResponse>(`/api/accounts/${id}`, { method: 'DELETE' }),
  },

  // ── Branches (v2: nested under an account) ──────────────────────────────────
  //
  // Routes mirror the account client one level deeper:
  //   GET    /api/accounts/:accountId/branches               → list (no children)
  //   GET    /api/accounts/:accountId/branches/:id           → one (with children)
  //   POST   /api/accounts/:accountId/branches               → create
  //   PATCH  /api/accounts/:accountId/branches/:id           → update (partial)
  //   DELETE /api/accounts/:accountId/branches/:id           → delete
  //   POST   /api/accounts/:accountId/branches/:id/default   → set as default
  // The set-default endpoint enforces the exactly-one-default invariant server-side
  // (it clears the prior default in the same transaction).
  branches: {
    list: (accountId: number): Promise<Branch[]> =>
      request<BranchesListResponse>(`/api/accounts/${accountId}/branches`).then(
        (r) => r.branches
      ),

    get: (accountId: number, branchId: number): Promise<BranchWithChildren> =>
      request<BranchResponse>(`/api/accounts/${accountId}/branches/${branchId}`).then(
        (r) => r.branch
      ),

    create: (accountId: number, input: BranchCreateInput): Promise<BranchWithChildren> =>
      request<BranchResponse>(`/api/accounts/${accountId}/branches`, {
        method: 'POST',
        body: input,
      }).then((r) => r.branch),

    update: (
      accountId: number,
      branchId: number,
      patch: BranchUpdateInput
    ): Promise<BranchWithChildren> =>
      request<BranchResponse>(`/api/accounts/${accountId}/branches/${branchId}`, {
        method: 'PATCH',
        body: patch,
      }).then((r) => r.branch),

    remove: (accountId: number, branchId: number): Promise<DeleteBranchResponse> =>
      request<DeleteBranchResponse>(`/api/accounts/${accountId}/branches/${branchId}`, {
        method: 'DELETE',
      }),

    setDefault: (accountId: number, branchId: number): Promise<BranchWithChildren> =>
      request<BranchResponse>(`/api/accounts/${accountId}/branches/${branchId}/default`, {
        method: 'POST',
      }).then((r) => r.branch),
  },

  // ── Per-account login control (Model A) ─────────────────────────────────────
  //
  // Account-level Facebook login with mid-flow 2FA relay. Mirrors
  // server/routes/login-control.js. Every endpoint wraps the public view under a
  // `login` key ({ login: LoginSessionView }); these methods UNWRAP it so callers
  // receive a bare LoginSessionView.
  //   POST /api/accounts/:id/login        → launch (202 Accepted, treated as success)
  //   GET  /api/accounts/:id/login/status → poll (running | needs_2fa)
  //   POST /api/accounts/:id/login/2fa    → submit the 2FA code
  // A concurrent launch returns 409 (one session per account) — the caller surfaces
  // it via ApiError.isConflict. The stored password is never sent here; the server
  // reads password_enc set via the account editor.
  login: {
    // `mode` is optional and back-compatible: omit it (or pass 'auto') for the
    // headless form login; pass 'manual' to open a headed browser the operator
    // drives through an OTP / QR / push challenge. An absent mode sends no body.
    launch: (accountId: number, mode?: LoginMode): Promise<LoginSessionView> =>
      request<LoginLaunchResponse>(`/api/accounts/${accountId}/login`, {
        method: 'POST',
        body: mode ? { mode } : undefined,
      }).then((r) => r.login),

    status: (accountId: number): Promise<LoginSessionView> =>
      request<LoginStatusResponse>(`/api/accounts/${accountId}/login/status`).then(
        (r) => r.login
      ),

    submit2fa: (accountId: number, code: string): Promise<LoginSessionView> =>
      request<Login2faResponse>(`/api/accounts/${accountId}/login/2fa`, {
        method: 'POST',
        body: { code },
      }).then((r) => r.login),
  },

  // ── Settings ──────────────────────────────────────────────────────────────
  settings: {
    get: (): Promise<Settings> =>
      request<SettingsResponse>('/api/settings').then((r) => r.settings),

    update: (patch: SettingsUpdateInput): Promise<Settings> =>
      request<SettingsResponse>('/api/settings', { method: 'PATCH', body: patch }).then(
        (r) => r.settings
      ),
  },

  // ── Worker ─────────────────────────────────────────────────────────────--
  worker: {
    status: (): Promise<WorkerStatus> => request<WorkerStatus>('/api/worker/status'),
    start: (): Promise<WorkerActionResponse> =>
      request<WorkerActionResponse>('/api/worker/start', { method: 'POST' }),
    stop: (): Promise<WorkerActionResponse> =>
      request<WorkerActionResponse>('/api/worker/stop', { method: 'POST' }),
  },

  // ── Status / feed ─────────────────────────────────────────────────────────
  status: {
    overview: (): Promise<StatusResponse> => request<StatusResponse>('/api/status'),
    events: (query: EventsQuery = {}): Promise<EventsResponse> =>
      request<EventsResponse>('/api/status/events', { query }),
  },
};
