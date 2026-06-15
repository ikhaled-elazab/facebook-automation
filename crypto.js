'use strict';

/**
 * crypto.js — AES-256-GCM encryption for credentials at rest.
 *
 * Security design (deep-reviewer discipline):
 *   - Algorithm: AES-256-GCM (authenticated encryption — detects tampering).
 *   - Key: 32 bytes from env APP_ENCRYPTION_KEY, provided as 64 hex chars.
 *     Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   - IV: 12 random bytes per encryption (GCM standard; never reused).
 *   - Output format: base64(iv) : base64(authTag) : base64(ciphertext)
 *   - No plaintext fallback. If the key is missing/invalid we throw, so a
 *     misconfigured deploy fails loudly instead of silently storing plaintext.
 *   - decrypt() verifies the auth tag; tampered/corrupt data throws.
 *
 * The encryption key lives ONLY in .env (gitignored). Losing it makes stored
 * credentials unrecoverable — that is intentional (no backdoor).
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Resolve and validate the encryption key from the environment.
 * Throws a clear error if missing or wrong length.
 * @returns {Buffer} 32-byte key
 */
function getKey() {
  const hex = process.env.APP_ENCRYPTION_KEY;
  if (!hex || typeof hex !== 'string') {
    throw new Error(
      'APP_ENCRYPTION_KEY is not set. Add a 64-hex-char key to .env. ' +
        'Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      `APP_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes); got ${trimmed.length} chars.`
    );
  }
  return Buffer.from(trimmed, 'hex');
}

/**
 * Encrypt a UTF-8 string. Returns "iv:tag:ciphertext" (each base64).
 * Returns null/undefined unchanged so callers can encrypt optional fields.
 * @param {string|null|undefined} plaintext
 * @returns {string|null|undefined}
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  const str = String(plaintext);
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a value produced by encrypt(). Verifies the GCM auth tag.
 * Returns null/undefined unchanged. Throws on tampering/corruption.
 * @param {string|null|undefined} payload "iv:tag:ciphertext"
 * @returns {string|null|undefined}
 */
function decrypt(payload) {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload !== 'string') {
    throw new Error('decrypt() expects a string payload.');
  }
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed ciphertext: expected "iv:tag:ciphertext".');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES) {
    throw new Error(`Malformed ciphertext: IV must be ${IV_BYTES} bytes.`);
  }
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * True if APP_ENCRYPTION_KEY is present and valid (without throwing).
 * Useful for startup checks / health endpoints.
 * @returns {boolean}
 */
function isKeyConfigured() {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Convenience: generate a fresh 64-hex-char key (for setup docs/scripts).
 * @returns {string}
 */
function generateKey() {
  return crypto.randomBytes(KEY_BYTES).toString('hex');
}

module.exports = { encrypt, decrypt, isKeyConfigured, generateKey };
