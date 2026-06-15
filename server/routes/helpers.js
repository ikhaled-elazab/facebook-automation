'use strict';

/**
 * server/routes/helpers.js — shared route plumbing.
 *   - asyncHandler: forwards async rejections to the error middleware (explicit
 *     even though Express 5 does this; keeps intent clear and version-portable).
 *   - validate*: parse req.body / req.params / req.query with a zod schema and
 *     surface a structured ValidationError (422) on failure.
 */

const { ValidationError } = require('../errors');

/**
 * Wrap an async handler so rejected promises reach Express's error pipeline.
 * @param {import('express').RequestHandler} fn
 * @returns {import('express').RequestHandler}
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Run a zod schema against a value; throw ValidationError(422) with field issues
 * on failure, else return the parsed (typed, coerced) data.
 * @template T
 * @param {import('zod').ZodType<T>} schema
 * @param {unknown} value
 * @returns {T}
 */
function parseOrThrow(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    }));
    throw new ValidationError(issues);
  }
  return result.data;
}

module.exports = { asyncHandler, parseOrThrow };
