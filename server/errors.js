'use strict';

/**
 * server/errors.js — typed HTTP errors + a consistent client-facing error shape.
 *
 * Design:
 *   - All operational (expected) failures throw an ApiError with an HTTP status,
 *     a stable machine-readable `code`, and a safe `message`.
 *   - The central error handler (see app.js) maps ApiError -> its status/code and
 *     maps everything else -> 500 with a generic message, NEVER leaking the stack
 *     or internal error text to the client. Stacks go to the server log only.
 *   - Stable error shape:  { error: { code, message, details? } }
 *     `details` is only populated for validation errors (field-level), never for
 *     internal failures.
 */

/** Base class for expected, client-facing errors. */
class ApiError extends Error {
  /**
   * @param {number} status   HTTP status code
   * @param {string} code     stable machine code, e.g. 'NOT_FOUND'
   * @param {string} message  safe, human-readable message (no secrets/internals)
   * @param {unknown} [details] optional structured details (validation only)
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    // ApiError is operational by definition — distinguishes from bugs.
    this.expose = true;
  }
}

class BadRequestError extends ApiError {
  constructor(message = 'Bad request', details) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

class ValidationError extends ApiError {
  /** @param {Array<{path:string,message:string}>} issues */
  constructor(issues, message = 'Validation failed') {
    super(422, 'VALIDATION_ERROR', message, issues);
  }
}

class UnauthorizedError extends ApiError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', message);
  }
}

class NotFoundError extends ApiError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

class ConflictError extends ApiError {
  constructor(message = 'Conflict') {
    super(409, 'CONFLICT', message);
  }
}

class TooManyRequestsError extends ApiError {
  constructor(message = 'Too many requests') {
    super(429, 'TOO_MANY_REQUESTS', message);
  }
}

class ServiceUnavailableError extends ApiError {
  constructor(message = 'Service unavailable', details) {
    super(503, 'SERVICE_UNAVAILABLE', message, details);
  }
}

/**
 * Serialize an error to the stable client shape.
 * @param {unknown} err
 * @returns {{status:number, body:{error:{code:string,message:string,details?:unknown}}}}
 */
function toErrorResponse(err) {
  if (err instanceof ApiError) {
    const error = { code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    return { status: err.status, body: { error } };
  }
  // Unexpected error: do not leak internals.
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
  };
}

module.exports = {
  ApiError,
  BadRequestError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  TooManyRequestsError,
  ServiceUnavailableError,
  toErrorResponse,
};
