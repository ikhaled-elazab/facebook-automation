import { request, ensureCsrfToken, clearCsrfToken } from './http';
import type {
  Account,
  AccountCreateInput,
  AccountResponse,
  AccountUpdateInput,
  AccountsListResponse,
  AccountWithChildren,
  DeleteAccountResponse,
  EventsQuery,
  EventsResponse,
  LoginResponse,
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

  // ── Accounts ────────────────────────────────────────────────────────────--
  accounts: {
    list: (): Promise<Account[]> =>
      request<AccountsListResponse>('/api/accounts').then((r) => r.accounts),

    get: (id: number): Promise<AccountWithChildren> =>
      request<AccountResponse>(`/api/accounts/${id}`).then((r) => r.account),

    create: (input: AccountCreateInput): Promise<AccountWithChildren> =>
      request<AccountResponse>('/api/accounts', { method: 'POST', body: input }).then(
        (r) => r.account
      ),

    update: (id: number, patch: AccountUpdateInput): Promise<AccountWithChildren> =>
      request<AccountResponse>(`/api/accounts/${id}`, { method: 'PATCH', body: patch }).then(
        (r) => r.account
      ),

    remove: (id: number): Promise<DeleteAccountResponse> =>
      request<DeleteAccountResponse>(`/api/accounts/${id}`, { method: 'DELETE' }),
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
