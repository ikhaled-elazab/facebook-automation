import { ApiError } from './ApiError';
import type { ApiErrorBody } from './types';

/*
 * http.ts — the central, security-aware fetch wrapper.
 *
 * RESPONSIBILITIES (so no screen reimplements these):
 *   1. Same-origin requests with credentials (session cookie rides automatically).
 *   2. CSRF lifecycle: fetch + cache the token; attach `x-csrf-token` on every
 *      mutating method (POST/PATCH/DELETE/PUT); on a 403 CSRF failure, refetch the
 *      token ONCE and retry the original request (the session id can rotate on
 *      login, which invalidates an old token).
 *   3. Error normalization: every non-2xx becomes a typed ApiError; transport
 *      failures become ApiError(0,'NETWORK',...).
 *   4. A 401 surfaces as ApiError.isAuth so a single place (AuthProvider) can
 *      redirect to /login — without a global hard reload that would lose state.
 *
 * SECURITY: the auth credential is the httpOnly session cookie set by the server;
 * this client NEVER reads or stores it, and NEVER stores the user's password. The
 * CSRF token is a non-secret double-submit value held only in memory.
 */

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** In-memory CSRF token cache (non-secret; safe to hold in JS memory). */
let csrfToken: string | null = null;

/** A single in-flight token fetch shared by concurrent callers (no thundering herd). */
let csrfInFlight: Promise<string> | null = null;

/** Optional hook the AuthProvider installs to react to a global 401. */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/** Drop the cached token (e.g. after logout, so the next mutation refetches). */
export function clearCsrfToken(): void {
  csrfToken = null;
  csrfInFlight = null;
}

/**
 * Fetch (and cache) a fresh CSRF token. Concurrent callers share one request.
 * Forcing (force=true) bypasses the cache — used by the 403 retry path and on
 * login (the session id rotates, invalidating any prior token).
 */
export async function ensureCsrfToken(force = false): Promise<string> {
  if (csrfToken && !force) return csrfToken;
  if (csrfInFlight && !force) return csrfInFlight;

  csrfInFlight = (async () => {
    const res = await rawFetch('/api/auth/csrf', { method: 'GET' });
    const body = (await res.json()) as { csrf_token?: string };
    if (!res.ok || !body.csrf_token) {
      throw new ApiError(res.status || 0, 'CSRF_FETCH_FAILED', 'Could not obtain a CSRF token.');
    }
    csrfToken = body.csrf_token;
    return csrfToken;
  })();

  try {
    return await csrfInFlight;
  } finally {
    csrfInFlight = null;
  }
}

/** Low-level fetch with same-origin credentials. Throws only on transport failure. */
async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch {
    // Transport failure (server down, DNS, abort). Never surface raw text —
    // give a stable, user-readable NETWORK error.
    throw new ApiError(0, 'NETWORK', 'Cannot reach the control plane. Is it running?');
  }
}

type QueryValue = string | number | undefined;

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Query params; accepts any object of serializable values (no index sig needed). */
  query?: Readonly<Record<string, QueryValue>> | object;
  /** Internal: prevents infinite retry recursion on the CSRF retry path. */
  _isRetry?: boolean;
}

/**
 * Perform an API request and return the parsed JSON body (typed by the caller).
 * Mutating methods auto-attach the CSRF token and auto-retry once on 403.
 */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = (opts.method ?? 'GET').toUpperCase();
  const url = opts.query ? path + buildQuery(opts.query) : path;

  const headers: Record<string, string> = {};
  let bodyInit: BodyInit | undefined;

  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyInit = JSON.stringify(opts.body);
  }

  if (MUTATING.has(method)) {
    headers['x-csrf-token'] = await ensureCsrfToken();
  }

  const res = await rawFetch(url, { method, headers, body: bodyInit });

  // 204/empty handling: some endpoints could return no body. Read text first.
  const text = await res.text();
  const parsed: unknown = text ? safeJson(text) : null;

  if (res.ok) {
    return parsed as T;
  }

  const apiErr = toApiError(res.status, parsed);

  // CSRF token went stale (session rotated/expired) — refetch once and retry the
  // SAME mutation. Guard against loops with _isRetry.
  if (apiErr.isCsrf && MUTATING.has(method) && !opts._isRetry) {
    await ensureCsrfToken(true);
    return request<T>(path, { ...opts, _isRetry: true });
  }

  // Global 401 hook: let the AuthProvider redirect to login (soft, not a reload).
  if (apiErr.isAuth && onUnauthorized) {
    onUnauthorized();
  }

  throw apiErr;
}

// ── helpers ───────────────────────────────────────────────────────────────--

function buildQuery(query: object): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Coerce a parsed error body into a typed ApiError, with sane fallbacks. */
function toApiError(status: number, parsed: unknown): ApiError {
  if (isApiErrorBody(parsed)) {
    const { code, message, details } = parsed.error;
    return new ApiError(status, code, message, details);
  }
  // Non-conforming error body — still give a stable, status-derived error.
  return new ApiError(status, codeForStatus(status), messageForStatus(status));
}

function isApiErrorBody(v: unknown): v is ApiErrorBody {
  return (
    typeof v === 'object' &&
    v !== null &&
    'error' in v &&
    typeof (v as { error: unknown }).error === 'object' &&
    (v as { error: unknown }).error !== null
  );
}

function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 422:
      return 'VALIDATION_ERROR';
    case 429:
      return 'TOO_MANY_REQUESTS';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
  }
}

function messageForStatus(status: number): string {
  if (status >= 500) return 'The server encountered an error. Please try again.';
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 429) return 'Too many requests. Please wait a moment and retry.';
  return 'The request could not be completed.';
}
