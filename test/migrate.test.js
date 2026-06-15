'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

let workDir;
let dbFile;

// Build a synthetic legacy project (config.json, accounts.json, state/*) in a
// temp dir, then run migrate.js with cwd=workDir and DB_PATH=temp db.
before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbmig-'));
  dbFile = path.join(workDir, 'fb-bot.db');

  fs.writeFileSync(
    path.join(workDir, 'config.json'),
    JSON.stringify({
      headless: false,
      useProxy: false,
      useAI: true,
      useVision: true,
      visionModel: 'gpt-4o-mini',
      delays: { minActionMs: 1111, maxActionMs: 2222, minTypingMs: 100, maxTypingMs: 200 },
      accountStaggerMs: 33000,
      enableDmToCommenters: true,
    })
  );

  fs.writeFileSync(
    path.join(workDir, 'accounts.json'),
    JSON.stringify([
      {
        name: 'acctA',
        email: 'a@x.com',
        password: 'secretA',
        sessionFile: 'sessions/acctA.json',
        lastPostFile: 'state/acctA_last_post.txt',
        targetPageUrl: 'https://fb.com/pageA',
        ownProfileUrl: 'https://fb.com/me',
        checkIntervalMinutes: 5,
        comments: ['ca1', 'ca2'],
        replies: ['ra1'],
        dmMessages: ['da1', 'da2', 'da3'],
        groups: ['https://fb.com/groups/1', 'https://fb.com/groups/2'],
        sendDmToCommenters: true,
        dmAsPageUrl: 'https://fb.com/page-identity',
        proxy: { server: 'http://p:1', username: 'pu', password: 'ppw' },
      },
    ])
  );

  // Legacy state files
  fs.mkdirSync(path.join(workDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'state', 'acctA_last_post.txt'), 'lastpost999\n');
  fs.writeFileSync(
    path.join(workDir, 'state', 'acctA_shared_posts.json'),
    JSON.stringify(['https://fb.com/shared/1'])
  );
  fs.writeFileSync(
    path.join(workDir, 'state', 'acctA_dm_sent.json'),
    JSON.stringify(['https://fb.com/u/aa', 'https://fb.com/u/bb'])
  );
  fs.writeFileSync(
    path.join(workDir, 'state', 'acctA_seen_comments_abc123.json'),
    JSON.stringify(['cmtA', 'cmtB', 'cmtC'])
  );
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function runMigrate(extraArgs = []) {
  return execFileSync('node', [path.join(PROJECT_ROOT, 'migrate.js'), ...extraArgs], {
    cwd: workDir,
    env: { ...process.env, APP_ENCRYPTION_KEY: KEY, DB_PATH: dbFile },
    encoding: 'utf8',
  });
}

// Open the migrated DB via the db layer (pointed at the temp file).
function openDb() {
  // Fresh require with DB_PATH set to the temp file.
  delete require.cache[require.resolve('../db')];
  process.env.DB_PATH = dbFile;
  process.env.APP_ENCRYPTION_KEY = KEY;
  return require('../db');
}

test('migration is lossless (settings + account + children + state)', () => {
  runMigrate();
  const db = openDb();

  const s = db.getSettings();
  assert.strictEqual(s.use_ai, 1);
  assert.strictEqual(s.min_action_ms, 1111);
  assert.strictEqual(s.account_stagger_ms, 33000);
  assert.strictEqual(s.enable_dm_to_commenters, 1);

  const a = db.getAccountByName('acctA');
  assert.ok(a, 'account migrated');
  assert.strictEqual(a.email, 'a@x.com');
  assert.strictEqual(a.check_interval_minutes, 5);
  assert.strictEqual(a.send_dm_to_commenters, 1);
  assert.strictEqual(a.dm_as_page_url, 'https://fb.com/page-identity');

  // Password encrypted (not plaintext) and decryptable.
  assert.ok(a.password_enc && a.password_enc !== 'secretA', 'password stored encrypted');
  const { decrypt } = require('../crypto');
  assert.strictEqual(decrypt(a.password_enc), 'secretA', 'password decrypts losslessly');
  assert.strictEqual(decrypt(a.proxy_password_enc), 'ppw', 'proxy password encrypted+lossless');

  assert.deepStrictEqual(db.getAccountComments(a.id), ['ca1', 'ca2']);
  assert.deepStrictEqual(db.getAccountReplies(a.id), ['ra1']);
  assert.deepStrictEqual(db.getAccountDmMessages(a.id), ['da1', 'da2', 'da3']);
  assert.deepStrictEqual(db.getAccountGroups(a.id), [
    'https://fb.com/groups/1',
    'https://fb.com/groups/2',
  ]);

  assert.strictEqual(db.getAccountState(a.id).last_post_id, 'lastpost999');
  assert.deepStrictEqual(db.getSharedPosts(a.id), ['https://fb.com/shared/1']);
  assert.strictEqual(db.getDmSent(a.id).size, 2);

  // seen_comments preserved (under synthetic legacy: key)
  const total = db
    .getDb()
    .prepare('SELECT COUNT(*) AS n FROM seen_comments WHERE account_id = ?')
    .get(a.id).n;
  assert.strictEqual(total, 3, 'all seen-comment ids preserved');

  db.closeDb();
});

test('migration is idempotent (re-run yields same counts, no duplicates)', () => {
  runMigrate(); // second run
  const db = openDb();

  const accounts = db.listAccounts();
  assert.strictEqual(accounts.length, 1, 'no duplicate account on re-run');

  const a = db.getAccountByName('acctA');
  assert.deepStrictEqual(db.getAccountComments(a.id), ['ca1', 'ca2'], 'children replaced, not doubled');
  assert.deepStrictEqual(db.getAccountDmMessages(a.id), ['da1', 'da2', 'da3']);

  assert.strictEqual(db.getDmSent(a.id).size, 2, 'dm_sent deduped on re-run');
  const seen = db
    .getDb()
    .prepare('SELECT COUNT(*) AS n FROM seen_comments WHERE account_id = ?')
    .get(a.id).n;
  assert.strictEqual(seen, 3, 'seen_comments deduped on re-run');

  db.closeDb();
});

test('dry-run writes nothing new', () => {
  const out = runMigrate(['--dry-run']);
  assert.match(out, /DRY RUN/);
  const db = openDb();
  assert.strictEqual(db.listAccounts().length, 1, 'dry-run did not add accounts');
  db.closeDb();
});
