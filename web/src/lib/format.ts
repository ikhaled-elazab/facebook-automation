/*
 * format.ts — small pure formatting helpers used across screens.
 */
import { ApiError } from '../api/ApiError';

/** Extract a user-facing message from any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'An unexpected error occurred.';
}

/**
 * Return the URL ONLY if it is a safe http(s) link, else null.
 *
 * SECURITY (defense-in-depth): the API now rejects non-http(s) schemes at write
 * time, but pre-existing rows or a future bypass could still carry a
 * `javascript:`/`data:` URL. React does NOT strip a javascript: href, so any code
 * rendering a stored URL into <a href> MUST gate it through this first and fall
 * back to plain text when it returns null. Never pass a raw stored URL to href.
 */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return /^https?:$/i.test(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}

/**
 * SQLite timestamps are 'YYYY-MM-DD HH:MM:SS' in UTC (no 'Z'). Parse as UTC.
 * Returns null for empty/invalid input.
 */
export function parseUtc(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const ms = Date.parse(String(ts).replace(' ', 'T') + (ts.includes('Z') ? '' : 'Z'));
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** Human relative time, e.g. "12s ago", "3m ago", "2h ago", "5d ago". */
export function relativeTime(ts: string | null | undefined, now: number = Date.now()): string {
  const d = parseUtc(ts);
  if (!d) return '—';
  const diff = Math.max(0, now - d.getTime());
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

/** Absolute local datetime, for tooltips / detail. */
export function absoluteTime(ts: string | null | undefined): string {
  const d = parseUtc(ts);
  return d ? d.toLocaleString() : '—';
}

/** Format milliseconds as a compact human duration ("1.5s", "850ms", "2m"). */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s % 1 === 0 ? s : s.toFixed(1)}s`;
  const m = s / 60;
  return `${m % 1 === 0 ? m : m.toFixed(1)}m`;
}

/** Pretty integer with thousands separators. */
export function formatInt(n: number): string {
  return n.toLocaleString();
}

/**
 * Structural equality for plain, JSON-serializable form state (primitives,
 * string arrays, nested plain objects — no class instances, functions, or
 * cycles). Used for unsaved-changes dirty-tracking by comparing the live form to
 * its initial snapshot. Order-sensitive for arrays (child-list order matters).
 */
export function isEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => isEqualJson(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      isEqualJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    );
  }
  return false;
}
