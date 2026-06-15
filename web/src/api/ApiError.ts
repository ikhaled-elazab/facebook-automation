import type { ApiErrorDetail } from './types';

/*
 * ApiError — the single error type every API call rejects with.
 *
 * It normalizes the server's stable shape `{ error: { code, message, details? } }`
 * into a typed object the UI can branch on:
 *   - `status`  : HTTP status (0 for network/transport failures).
 *   - `code`    : stable machine code (e.g. 'VALIDATION_ERROR', 'CONFLICT',
 *                 'UNAUTHORIZED', 'CSRF_INVALID', 'NETWORK', 'TOO_MANY_REQUESTS').
 *   - `details` : field-level issues for 422, used to paint form errors.
 *
 * Screens never parse raw responses — they catch ApiError and read these fields.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: ApiErrorDetail[];

  constructor(status: number, code: string, message: string, details?: ApiErrorDetail[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }

  /** True when the user is not authenticated (drives redirect-to-login). */
  get isAuth(): boolean {
    return this.status === 401 || this.code === 'UNAUTHORIZED';
  }

  /** True for a stale/invalid CSRF token (drives a token refetch + one retry). */
  get isCsrf(): boolean {
    return this.code === 'CSRF_INVALID' || this.status === 403;
  }

  /** True for field-level validation failures (422). */
  get isValidation(): boolean {
    return this.status === 422 || this.code === 'VALIDATION_ERROR';
  }

  /** True for a name-uniqueness style conflict (409). */
  get isConflict(): boolean {
    return this.status === 409 || this.code === 'CONFLICT';
  }

  /** True for rate-limit (429). */
  get isRateLimited(): boolean {
    return this.status === 429 || this.code === 'TOO_MANY_REQUESTS';
  }

  /** True for a transport-level failure (server unreachable, DNS, abort). */
  get isNetwork(): boolean {
    return this.status === 0 || this.code === 'NETWORK';
  }

  /**
   * Build a map of fieldPath → first message, for painting inline form errors.
   * Root-level issues are keyed under '(root)'.
   */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const issue of this.details ?? []) {
      if (!(issue.path in out)) out[issue.path] = issue.message;
    }
    return out;
  }
}
