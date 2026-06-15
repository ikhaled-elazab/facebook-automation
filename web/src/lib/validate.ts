/*
 * validate.ts — client-side validation mirroring server/schemas.js (zod).
 *
 * This is a UX convenience for instant feedback — the SERVER remains the source
 * of truth and the form ALSO surfaces server 422 details[]. We intentionally
 * mirror the same bounds (lengths, ranges, url/email shape) so a value that
 * passes here passes there too, and the user rarely sees a server rejection.
 *
 * Returns a map of fieldPath → message; empty map = valid.
 */

export type Errors = Record<string, string>;

const URL_MAX = 2048;

function isUrl(v: string): boolean {
  try {
    // Mirror server/schemas.js optionalUrl: parseable URL AND http(s) scheme only.
    // SECURITY: reject javascript:/data:/vbscript: etc. — those render into <a href>
    // and React does NOT strip a javascript: href (stored-XSS vector).
    return /^https?:$/i.test(new URL(v).protocol);
  } catch {
    return false;
  }
}

function isEmail(v: string): boolean {
  // Pragmatic mirror of zod .email() — the server is authoritative.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export function required(errors: Errors, key: string, value: string, label: string): void {
  if (!value.trim()) errors[key] = `${label} is required.`;
}

export function maxLen(
  errors: Errors,
  key: string,
  value: string,
  max: number,
  label: string
): void {
  if (value.length > max && !errors[key]) errors[key] = `${label} must be ≤ ${max} characters.`;
}

export function urlField(
  errors: Errors,
  key: string,
  value: string,
  label: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {}
): void {
  if (!value.trim()) {
    if (!allowEmpty) errors[key] = `${label} is required.`;
    return;
  }
  if (!isUrl(value.trim())) errors[key] = `${label} must be a valid URL (https://…).`;
  else if (value.length > URL_MAX) errors[key] = `${label} must be ≤ ${URL_MAX} characters.`;
}

export function emailField(errors: Errors, key: string, value: string): void {
  if (!value.trim()) {
    errors[key] = 'Email is required.';
    return;
  }
  if (!isEmail(value.trim())) errors[key] = 'Enter a valid email address.';
  else if (value.length > 320) errors[key] = 'Email must be ≤ 320 characters.';
}

export function intRange(
  errors: Errors,
  key: string,
  value: number | null,
  min: number,
  max: number,
  label: string,
  { allowNull = false }: { allowNull?: boolean } = {}
): void {
  if (value == null) {
    if (!allowNull) errors[key] = `${label} is required.`;
    return;
  }
  if (!Number.isInteger(value)) errors[key] = `${label} must be a whole number.`;
  else if (value < min || value > max) errors[key] = `${label} must be between ${min} and ${max}.`;
}
