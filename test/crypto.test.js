'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// Set a valid key BEFORE requiring crypto-dependent code.
process.env.APP_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { encrypt, decrypt, isKeyConfigured, generateKey } = require('../crypto');

test('round-trips a plaintext string', () => {
  const secret = 'Rana@aba1';
  const enc = encrypt(secret);
  assert.notStrictEqual(enc, secret, 'ciphertext must differ from plaintext');
  assert.match(enc, /^[^:]+:[^:]+:[^:]+$/, 'format is iv:tag:ciphertext');
  assert.strictEqual(decrypt(enc), secret);
});

test('produces different ciphertext each time (random IV)', () => {
  const a = encrypt('same-input');
  const b = encrypt('same-input');
  assert.notStrictEqual(a, b, 'IV randomization must change ciphertext');
  assert.strictEqual(decrypt(a), 'same-input');
  assert.strictEqual(decrypt(b), 'same-input');
});

test('passes through null/undefined unchanged', () => {
  assert.strictEqual(encrypt(null), null);
  assert.strictEqual(encrypt(undefined), undefined);
  assert.strictEqual(decrypt(null), null);
  assert.strictEqual(decrypt(undefined), undefined);
});

test('detects tampering (GCM auth tag)', () => {
  const enc = encrypt('integrity-protected');
  const parts = enc.split(':');
  // Flip a byte in the ciphertext segment.
  const ct = Buffer.from(parts[2], 'base64');
  ct[0] = ct[0] ^ 0xff;
  const tampered = [parts[0], parts[1], ct.toString('base64')].join(':');
  assert.throws(() => decrypt(tampered), /unable to authenticate|auth/i);
});

test('rejects malformed ciphertext', () => {
  assert.throws(() => decrypt('not-valid'), /Malformed/);
  assert.throws(() => decrypt('only:two'), /Malformed/);
});

test('isKeyConfigured reflects env validity', () => {
  assert.strictEqual(isKeyConfigured(), true);
});

test('rejects a wrong-length key', () => {
  const saved = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = 'tooshort';
  assert.throws(() => encrypt('x'), /64 hex/);
  process.env.APP_ENCRYPTION_KEY = saved;
});

test('generateKey returns 64 hex chars', () => {
  const k = generateKey();
  assert.match(k, /^[0-9a-f]{64}$/);
});
