/**
 * exporter.js — pure formatters for the history and audit exports.
 *
 * No Electron, no fs: the main process owns the native save dialog and the
 * write, while the shaping rules live here so `node --test` can prove them
 * without a display or a filesystem.
 *
 * Two rules protect the files a regulated user hands to someone else:
 *   - CSV is RFC 4180 quoted, CRLF-separated and BOM-prefixed, so Excel keeps
 *     accents and column positions instead of mojibake.
 *   - A cell that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is
 *     prefixed with a single quote, so dictated text can never run as a
 *     spreadsheet formula (T-01-11).
 *
 * The audit projection never reads `text`, `raw` or `cleaned`: metadata-only is
 * a structural property of the rows, not a filter applied afterwards.
 */

const BOM = '\uFEFF';
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;

const HISTORY_COLUMNS = [
  'timestamp (ISO)',
  'text',
  'raw',
  'words',
  'durationMs',
  'transcribeMs',
  'pasteMs',
  'pasted',
  'model',
];

const AUDIT_COLUMNS = [
  'timestamp (ISO)',
  'id',
  'outcome',
  'targetApp',
  'durationMs',
  'words',
  'model',
  'errorKind',
];

/**
 * ISO 8601 for every timestamp — never a locale format, so an exported file
 * sorts and reads the same on every machine.
 *
 * @param {number|string|Date} ts
 * @returns {string}  an ISO string, or '' when the value is not a date
 */
function isoStamp(ts) {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * Render one CSV cell: guard a formula-leading value, then quote it per
 * RFC 4180 (commas, quotes, CR and LF force quoting; inner quotes double).
 *
 * @param {*} value
 * @returns {string}
 */
function csvField(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (NEEDS_QUOTING.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Join rows into a CSV document. Fields are comma-separated, rows CRLF-separated
 * and the whole document starts with the UTF-8 BOM Excel needs.
 *
 * @param {Array<Array<*>>} rows
 * @returns {string}
 */
function toCsv(rows) {
  const body = (rows || []).map((row) => (row || []).map(csvField).join(',')).join('\r\n');
  return BOM + body;
}

/**
 * Words for one history row: the stored count when it exists (rows written
 * before `words` existed have none), otherwise the trimmed split count.
 *
 * @param {object} entry
 * @returns {number}
 */
function entryWords(entry) {
  if (entry && Number.isFinite(entry.words)) return entry.words;
  const text = (entry && (entry.cleaned || entry.raw)) || '';
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Project the transcript history into export rows: a header plus one row per
 * entry, newest first exactly as the store keeps it.
 *
 * @param {object[]} history
 * @returns {Array<Array<*>>}
 */
function historyRows(history) {
  const rows = [HISTORY_COLUMNS];
  for (const entry of history || []) {
    if (!entry) continue;
    rows.push([
      isoStamp(entry.at),
      entry.cleaned || '',
      entry.raw || '',
      entryWords(entry),
      entry.durationMs ?? '',
      entry.transcribeMs ?? '',
      entry.pasteMs ?? '',
      entry.pasted === true ? 'true' : entry.pasted === false ? 'false' : '',
      entry.model || '',
    ]);
  }
  return rows;
}

/**
 * Project audit-ledger records into export rows. Only allow-listed metadata is
 * read — a transcript field is never touched, so no text can reach the file.
 *
 * @param {object[]} records
 * @returns {Array<Array<*>>}
 */
function auditRows(records) {
  const rows = [AUDIT_COLUMNS];
  for (const record of records || []) {
    if (!record) continue;
    rows.push([
      isoStamp(record.ts),
      record.id || '',
      record.outcome || '',
      record.targetApp || '',
      record.durationMs ?? '',
      record.words ?? '',
      record.model || '',
      record.errorKind || '',
    ]);
  }
  return rows;
}

module.exports = {
  BOM,
  HISTORY_COLUMNS,
  AUDIT_COLUMNS,
  csvField,
  toCsv,
  historyRows,
  auditRows,
};
