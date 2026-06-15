'use strict';

/**
 * server/set-password.js — generate a bcrypt hash for the admin password.
 *
 * The control plane never stores a plaintext admin password. You generate a
 * bcrypt hash here and paste it into .env as ADMIN_PASSWORD_HASH.
 *
 * Usage:
 *   npm run set-password -- "your-strong-password"
 *   node server/set-password.js "your-strong-password"
 *
 * If no password is given as an argument, it is read from stdin (so it does not
 * land in shell history). The plaintext is never logged — only the hash is printed.
 */

const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 12; // strong default; ~250ms/hash on modern hardware
const MIN_LEN = 8;

function printHashAndExit(password) {
  if (typeof password !== 'string' || password.length < MIN_LEN) {
    console.error(`Password must be at least ${MIN_LEN} characters.`);
    process.exit(1);
    return;
  }
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  // Print ONLY the hash (no plaintext echo) so it is safe to copy into .env.
  console.log(hash);
  process.exit(0);
}

function main() {
  const argPassword = process.argv[2];
  if (argPassword !== undefined) {
    printHashAndExit(argPassword);
    return;
  }

  // No arg — read a single line from stdin (keeps the secret out of `ps`/history).
  if (process.stdin.isTTY) {
    process.stderr.write('Enter admin password (input visible): ');
  }
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
  });
  process.stdin.on('end', () => {
    printHashAndExit(buf.replace(/\r?\n$/, ''));
  });
}

if (require.main === module) {
  main();
}

module.exports = { BCRYPT_ROUNDS };
