'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config.json');

const LOG_DIR = path.resolve(config.logDir || 'logs');
const SCREENSHOT_DIR = path.join(LOG_DIR, 'screenshots');

// Create directories at module load
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function logFilePath() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `automation_${date}.log`);
}

function formatLine(level, account, category, msg) {
  const ts = new Date().toISOString();
  const acct = account ? `[${account.toUpperCase()}]` : '[SYSTEM]';
  return `[${ts}] ${acct} [${category}] ${msg}`;
}

function append(line) {
  try {
    fs.appendFileSync(logFilePath(), line + '\n', 'utf8');
  } catch {
    // silently ignore file write errors — console output still works
  }
}

function log(account, category, msg) {
  const line = formatLine('INFO', account, category, msg);
  console.log(line);
  append(line);
}

function warn(account, category, msg) {
  const line = formatLine('WARN', account, category, msg);
  console.warn(line);
  append(line);
}

function error(account, category, msg) {
  const line = formatLine('ERROR', account, category, msg);
  console.error(line);
  append(line);
}

function logError(account, category, err) {
  const msg = err && err.stack ? err.stack : (err && err.message ? err.message : String(err));
  const line = formatLine('ERROR', account, category, msg);
  console.error(line);
  append(line);
}

module.exports = { log, warn, error, logError, LOG_DIR, SCREENSHOT_DIR };
