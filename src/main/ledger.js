/**
 * ledger.js — the metadata-only audit ledger (append-only NDJSON sidecar)
 *
 * Privacy invariant: a ledger row carries no transcript text, no raw audio and
 * no partial text — only the keys in LEDGER_FIELDS are ever persisted.
 *
 * The ledger is deliberately separate from store.js (D-11): an audit fact
 * outlives the transcript it describes. Every delete, clear-all and retention
 * path is physically unable to open this file, so the guarantee is structural
 * rather than enforced by a runtime guard; test/ledger.test.js proves it with
 * the cross-path invariant test.
 *
 * fs/path only — no Electron, so it is unit-testable without a display. Every
 * method swallows its own I/O errors: auditing must never break dictation
 * (the same rule logger.write follows).
 */

const fs = require('fs');
const path = require('path');

/** The only keys a persisted row may contain (allow-list, T-01-08). */
const LEDGER_FIELDS = ['ts', 'id', 'outcome', 'targetApp', 'durationMs', 'words', 'model', 'errorKind'];

/** D-11's closed vocabulary: a dictation either pasted or it failed. */
const OUTCOMES = ['pasted', 'failed'];

/**
 * Keep only allow-listed fields, drop undefined values, and clamp the outcome.
 *
 * A row without a recognised outcome becomes `failed` — never a third value.
 * The distinction between "pasted" and "transcribed but not pasted" is carried
 * by `errorKind` (`paste`), not by the outcome.
 *
 * @param {object} [row]
 * @returns {object}  a row safe to persist
 */
function sanitizeRow(row) {
  const src = row || {};
  const safe = {};
  for (const key of LEDGER_FIELDS) {
    if (src[key] !== undefined) safe[key] = src[key];
  }
  safe.outcome = OUTCOMES.includes(safe.outcome) ? safe.outcome : 'failed';
  return safe;
}

/**
 * Count the complete lines in a file. A trailing unterminated line is a partial
 * write, not a row, so it is not counted. Missing/unreadable file → 0.
 *
 * @param {string} file
 * @returns {number}
 */
function countRows(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text) return 0;
    // Only newline-terminated segments are complete rows.
    const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
    return complete.split('\n').filter((line) => line.trim()).length;
  } catch {
    return 0;   // missing file: a fresh ledger starts at zero
  }
}

/**
 * Create the audit ledger over a file. The file is created lazily by append.
 *
 * `count()` is cached in memory: the ledger is unbounded and may live on a
 * network share, so /api/state must never parse it. Construction reads the file
 * once; `append` increments, `clear` zeroes, `setFile` recomputes.
 *
 * @param {object} opts
 * @param {string} opts.file  full path to the .ndjson sidecar
 * @returns {{file: string, append: Function, read: Function, count: Function, clear: Function, setFile: Function}}
 */
function createLedger(opts = {}) {
  const ledger = {
    file: opts.file,
    _count: countRows(opts.file),

    /**
     * Append one sanitised row. The cached count moves only after the write
     * returned, so a failed write cannot inflate the number the UI shows.
     *
     * @param {object} row
     * @returns {boolean}  whether the row reached the file
     */
    append(row) {
      try {
        const dir = path.dirname(ledger.file);
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(ledger.file, JSON.stringify(sanitizeRow(row)) + '\n');
        ledger._count += 1;
        return true;
      } catch (e) {
        // Auditing must never break dictation — the pipeline keeps going.
        console.warn('[ledger] append failed:', e.message);
        return false;
      }
    },

    /**
     * Parse the ledger for export only — never a hot path.
     *
     * Skips a trailing partial line and any unparseable line, so one corrupt
     * row cannot hide the rest. A missing file reads as an empty ledger.
     *
     * @returns {object[]}
     */
    read() {
      let text;
      try {
        text = fs.readFileSync(ledger.file, 'utf8');
      } catch {
        return [];   // no file yet: nothing was audited
      }
      // A trailing unterminated segment is a partial write — ignore it.
      const body = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
      const rows = [];
      for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          rows.push(JSON.parse(trimmed));
        } catch {
          continue;   // one corrupt line must not poison the export
        }
      }
      return rows;
    },

    /** The cached number of audit rows. O(1) — never reads the file. */
    count() {
      return ledger._count;
    },

    /** Truncate the ledger — the only action that shrinks it (T-01-09). */
    clear() {
      try {
        fs.mkdirSync(path.dirname(ledger.file), { recursive: true });
        fs.writeFileSync(ledger.file, '');
        ledger._count = 0;
        return true;
      } catch (e) {
        console.warn('[ledger] clear failed:', e.message);
        return false;
      }
    },

    /**
     * Point the ledger at a new file after a storage move, and recompute the
     * cached count from that file.
     *
     * @param {string} nextFile
     */
    setFile(nextFile) {
      ledger.file = nextFile;
      ledger._count = countRows(nextFile);
    },
  };

  return ledger;
}

module.exports = {
  LEDGER_FIELDS,
  OUTCOMES,
  sanitizeRow,
  createLedger,
};
