/**
 * logger.js — tiny file logger for the main process.
 *
 * Everything that goes through console.* is mirrored into
 * %APPDATA%/voice-flow/logs/voice-flow.log (rotated at 512 KB) so that
 * failures can be diagnosed after the fact — the app has no UI of its own
 * for reporting errors.
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 512 * 1024;

let logFile = null;
let originals = null;

function init(app) {
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'voice-flow.log');
  } catch (e) {
    logFile = null;
  }

  originals = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
  };

  console.log = (...args) => { originals.log(...args); write('INFO', args); };
  console.error = (...args) => { originals.error(...args); write('ERROR', args); };
  console.warn = (...args) => { originals.warn(...args); write('WARN', args); };

  return logFile;
}

function write(level, args) {
  if (!logFile) return;
  try {
    const line = `[${new Date().toISOString()}] ${level} ${args.map(fmt).join(' ')}`;
    rotate();
    fs.appendFileSync(logFile, line + '\n');
  } catch { /* logging must never throw */ }
}

function rotate() {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size < MAX_BYTES) return;
    const old = `${logFile}.1`;
    try { fs.unlinkSync(old); } catch { /* ignore */ }
    fs.renameSync(logFile, old);
  } catch { /* no file yet */ }
}

function fmt(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

module.exports = { init, write };
