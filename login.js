/**
 * login.js — DB-backed headless login for one or all accounts. Works on a VPS
 * (no display needed). Phase 3.5: accounts + settings now come from the SQLite DB
 * (db.js), NOT accounts.json/config.json. Credentials are stored ENCRYPTED
 * (accounts.password_enc) and DECRYPTED at login time via crypto.decrypt().
 *
 * Usage:
 *   node login.js                        → shows account list, prompts which to login
 *   node login.js --account account1     → login specific account by name
 *   node login.js --all                  → loop through every account sequentially
 *
 * Credential FALLBACKS (used only when the DB has no stored password_enc):
 *   FB_EMAIL="x@x.com" FB_PASS="secret" node login.js --account account1
 *   (and an interactive prompt if neither the DB nor env supply a value).
 *
 * SECURITY: the plaintext password is decrypted into a local, handed to the login
 * flow for a single field-fill, and allowed to go out of scope. It is NEVER
 * logged and NEVER written back to disk. The only on-disk artifact is the
 * Playwright storageState session file (cookies only, no credentials).
 */

'use strict';

const readline = require('readline');

const db = require('./db');
const { decrypt } = require('./crypto');
const { accountEnvelope } = require('./worker/loadConfig');
const { LoginSession, LOGIN_STATES, defaultLaunchBrowser } = require('./login-flow');

// ─── Terminal helpers ─────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    // askHidden may be called when stdin is not a TTY (e.g. piped). Fall back gracefully.
    if (!stdin.isTTY) {
      let buf = '';
      stdin.once('data', (d) => {
        buf = d.toString().trim();
        resolve(buf);
      });
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    stdin.on('data', function handler(ch) {
      if (ch === '\n' || ch === '\r' || ch === '') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '') {
        process.exit();
      } else if (ch === '') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(question + '*'.repeat(input.length));
        }
      } else {
        input += ch;
        process.stdout.write('*');
      }
    });
  });
}

// ─── Credential resolution (DB → env → interactive) ────────────────────────────

/**
 * Resolve the plaintext password for an account, in priority order:
 *   1. DB: decrypt(account.password_enc) — the Model A canonical path.
 *   2. env: FB_PASS — operator override / first-time login before a password is stored.
 *   3. interactive: hidden terminal prompt — last resort.
 * The decrypted value is returned to the caller, used once, then released. It is
 * NEVER logged. A decrypt failure (tampered/corrupt ciphertext, missing key) is
 * surfaced as a clear message and falls through to the env/prompt fallbacks so a
 * single bad row does not strand the operator.
 * @param {object} env account envelope (carries passwordEnc)
 * @param {boolean} interactive whether to allow a terminal prompt fallback
 * @returns {Promise<string>} the plaintext password (may be '' if none available)
 */
async function resolvePassword(env, interactive) {
  if (env.passwordEnc) {
    try {
      const pw = decrypt(env.passwordEnc);
      if (pw) return pw;
    } catch (err) {
      // Never log the ciphertext or any secret — only the failure reason.
      console.error(
        `[LOGIN:${env.name}] Stored password could not be decrypted (${err.message}). ` +
          'Falling back to FB_PASS / prompt.'
      );
    }
  }
  if (process.env.FB_PASS) return process.env.FB_PASS;
  if (interactive) return askHidden(`[LOGIN:${env.name}] Password: `);
  return '';
}

/**
 * Resolve the proxy plaintext password (DB only — no env/prompt fallback; the
 * proxy password is non-interactive). Returns undefined when absent or undecryptable.
 * @param {object} env account envelope (carries proxy.passwordEnc)
 * @returns {string|undefined}
 */
function resolveProxyPassword(env) {
  const enc = env.proxy && env.proxy.passwordEnc;
  if (!enc) return undefined;
  try {
    return decrypt(enc) || undefined;
  } catch (err) {
    console.warn(
      `[LOGIN:${env.name}] Proxy password decrypt failed (${err.message}) — proceeding without proxy auth.`
    );
    return undefined;
  }
}

// ─── Login one account (CLI path) ──────────────────────────────────────────────

/**
 * Log in one account using the DB envelope + DB settings, driving the resumable
 * LoginSession with the terminal 2FA prompt as the CLI fallback.
 * @param {object} acctRow a db.getAccountById/listAccounts row (snake_case)
 * @param {object} settings db.getSettings() row
 * @returns {Promise<boolean>} true on success
 */
async function loginAccount(acctRow, settings) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`[LOGIN] Account: ${acctRow.name}`);

  // Build the camelCase envelope (the single shared snake→camel mapping, reused
  // from the worker's loadConfig so login + worker never drift).
  const env = accountEnvelope(acctRow);

  // Email: DB → env → prompt. Password: DB(decrypt) → env → hidden prompt.
  let email = env.email || process.env.FB_EMAIL || '';
  if (!email) email = await ask(`[LOGIN:${env.name}] Facebook email / phone: `);

  let password = await resolvePassword(env, true);
  if (!password) {
    // resolvePassword already prompts when interactive, so an empty here means
    // the operator entered nothing — fail loudly rather than submit a blank.
    console.error(`[LOGIN:${env.name}] No password available (DB/env/prompt all empty). Aborting.`);
    return false;
  }

  const proxyPassword = resolveProxyPassword(env);

  console.log(`[LOGIN:${env.name}] Launching ${settings.headless ? 'headless ' : ''}browser...`);

  const session = new LoginSession(
    { account: env, email, password, settings, proxyPassword },
    {
      launchBrowser: () => defaultLaunchBrowser(settings),
      logger: (msg) => console.log(msg),
    }
  );
  // Release our local plaintext reference immediately — the session holds its own
  // copy which IT clears after the field-fill.
  password = null;

  const finalState = await session.run({
    interactiveAsk: (q) => ask(q), // CLI 2FA fallback: block on the terminal prompt
  });

  if (finalState === LOGIN_STATES.OK) {
    console.log(`[LOGIN:${env.name}] ✓ Login OK.`);
    return true;
  }
  console.error(`[LOGIN:${env.name}] ✗ Login ${finalState}: ${session.detail || ''}`);
  return false;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flagAll = args.includes('--all');
  const nameIdx = args.indexOf('--account');
  const targetName = nameIdx !== -1 ? args[nameIdx + 1] : null;

  const settings = db.getSettings();
  const accounts = db.listAccounts(); // all accounts (CLI can log in disabled ones too)

  if (accounts.length === 0) {
    console.error('[LOGIN] No accounts in the database. Add one via the control-plane UI first.');
    rl.close();
    process.exit(1);
  }

  let targets = [];

  if (flagAll) {
    targets = accounts;
  } else if (targetName) {
    const found = db.getAccountByName(targetName);
    if (!found) {
      console.error(`[LOGIN] No account named "${targetName}" found in the database.`);
      console.error(`[LOGIN] Available: ${accounts.map((a) => a.name).join(', ')}`);
      rl.close();
      process.exit(1);
    }
    targets = [found];
  } else {
    // Interactive: show list and let user pick.
    console.log('\n[LOGIN] Available accounts:');
    accounts.forEach((a, i) => console.log(`  [${i + 1}] ${a.name}  (${a.session_file})`));
    console.log('  [0] Login ALL accounts');

    const choice = await ask('\n[LOGIN] Enter number: ');
    const idx = parseInt(choice, 10);

    if (idx === 0) {
      targets = accounts;
    } else if (idx >= 1 && idx <= accounts.length) {
      targets = [accounts[idx - 1]];
    } else {
      console.error('[LOGIN] Invalid choice.');
      rl.close();
      process.exit(1);
    }
  }

  for (const account of targets) {
    await loginAccount(account, settings);
  }

  console.log('\n[LOGIN] Done. Run "npm start" to launch the bot.');
  rl.close();
}

// Only run the CLI when invoked directly (require()-safe for tests).
if (require.main === module) {
  main().catch((err) => {
    console.error('[LOGIN] Fatal:', err.message);
    rl.close();
    process.exit(1);
  });
}

module.exports = { loginAccount, resolvePassword, resolveProxyPassword };
