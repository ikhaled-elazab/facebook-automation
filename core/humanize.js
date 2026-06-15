'use strict';

/**
 * core/humanize.js — human-like timing & input primitives.
 *
 * In the legacy monolith these lived inline in index.js and read their bounds
 * from `config.delays.*` as module-load default parameters. That baked the
 * timing into the module at require() time, which is wrong once timing comes
 * from a per-run DB settings snapshot.
 *
 * Here we expose a factory, createHumanizer(settings), that closes over a
 * settings object and returns the primitives bound to it. Each account worker
 * builds its own humanizer from the settings it loaded, so there is no global
 * mutable timing state and the whole thing is trivially unit-testable by
 * passing a fake settings object.
 *
 * `settings` is the snake_case row shape returned by db.getSettings():
 *   { min_action_ms, max_action_ms, min_typing_ms, max_typing_ms, ... }
 *
 * randInt / pickRandom are pure and stateless, so they are also exported
 * directly for callers (and tests) that don't need a settings snapshot.
 */

/**
 * Inclusive integer in [min, max]. Identical to the legacy index.js randInt.
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Pick a uniformly-random element from a non-empty array.
 * Returns undefined for an empty/absent array (legacy parity: legacy callers
 * always guarded length before calling, so undefined never reached FB).
 * @template T
 * @param {T[]} arr
 * @returns {T|undefined}
 */
function pickRandom(arr) {
  if (!arr || !arr.length) return undefined;
  return arr[randInt(0, arr.length - 1)];
}

/**
 * Promisified setTimeout. Identical to the legacy index.js sleep.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the humanization primitives bound to a settings snapshot.
 * @param {object} settings db.getSettings() row (snake_case columns)
 * @returns {{
 *   randInt: typeof randInt,
 *   pickRandom: typeof pickRandom,
 *   sleep: typeof sleep,
 *   randomDelay: (minMs?: number, maxMs?: number) => Promise<void>,
 *   typeText: (page: import('playwright').Page, text: string) => Promise<void>,
 * }}
 */
function createHumanizer(settings) {
  const s = settings || {};
  const minAction = numberOr(s.min_action_ms, 2000);
  const maxAction = numberOr(s.max_action_ms, 5000);
  const minTyping = numberOr(s.min_typing_ms, 220);
  const maxTyping = numberOr(s.max_typing_ms, 500);

  /**
   * Random pause between actions. Defaults to the settings action bounds, but
   * callers may pass explicit bounds (the legacy code does this constantly,
   * e.g. randomDelay(4000, 7000) for page loads).
   */
  function randomDelay(minMs = minAction, maxMs = maxAction) {
    return sleep(randInt(minMs, maxMs));
  }

  /**
   * Type a string character-by-character with per-keystroke jitter, exactly as
   * the legacy comment/reply/dm flows did:
   *   for (const char of text) { keyboard.type(char); sleep(randInt(minT, maxT)); }
   * The composer/box must already be focused by the caller (legacy parity).
   */
  async function typeText(page, text) {
    for (const char of String(text)) {
      await page.keyboard.type(char);
      await sleep(randInt(minTyping, maxTyping));
    }
  }

  return { randInt, pickRandom, sleep, randomDelay, typeText };
}

/** Coerce to a finite number, else fall back. Guards NULL/undefined DB cells. */
function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { createHumanizer, randInt, pickRandom, sleep };
