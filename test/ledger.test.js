// Unit tests for the metadata-only audit ledger and the D-11 invariant.
//   node --test test/ledger.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LEDGER_FIELDS, OUTCOMES, sanitizeRow, createLedger } = require('../src/main/ledger');
const { purgeEntryData } = require('../src/main/store');

/** A throwaway ledger directory, removed whatever the test does. */
function withLedger(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictata-ledger-'));
  try {
    return fn(path.join(dir, 'dictata-audit.ndjson'), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A row shaped like one the pipeline appends. */
function row(over = {}) {
  return {
    ts: 1700000000000,
    id: 'row-1',
    outcome: 'pasted',
    targetApp: 'notepad.exe',
    durationMs: 1200,
    words: 4,
    model: 'gemini-2.5-flash',
    ...over,
  };
}

test('the outcome vocabulary is exactly pasted or failed', () => {
  assert.deepEqual(OUTCOMES, ['pasted', 'failed']);
  assert.deepEqual(LEDGER_FIELDS, [
    'ts', 'id', 'outcome', 'targetApp', 'durationMs', 'words', 'model', 'errorKind',
  ]);
});

test('an unknown outcome is clamped to failed', () => {
  assert.equal(sanitizeRow({ outcome: 'cancelled' }).outcome, 'failed');
  // `copied` is not a legal value — the paste distinction lives in errorKind.
  assert.equal(sanitizeRow({ outcome: 'copied' }).outcome, 'failed');
  assert.equal(sanitizeRow({}).outcome, 'failed');
  assert.equal(sanitizeRow({ outcome: 'pasted' }).outcome, 'pasted');
  assert.equal(sanitizeRow({ outcome: 'failed', errorKind: 'paste' }).errorKind, 'paste');
});

test('sanitizeRow keeps the allow-list only and drops undefined values', () => {
  const safe = sanitizeRow({
    ...row(),
    raw: 'transcript text',
    cleaned: 'cleaned text',
    text: 'more text',
    errorKind: undefined,
  });

  assert.deepEqual(Object.keys(safe).sort(), [
    'durationMs', 'id', 'model', 'outcome', 'targetApp', 'ts', 'words',
  ]);
  assert.equal('errorKind' in safe, false);   // a pasted row has no error kind
});

test('append and read round-trip', () => withLedger(async (file) => {
  const ledger = createLedger({ file });
  assert.equal(ledger.append(row({ id: 'a' })), true);
  assert.equal(ledger.append(row({ id: 'b', outcome: 'failed', errorKind: 'paste' })), true);

  const rows = ledger.read();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'a');
  assert.equal(rows[1].errorKind, 'paste');
}));

test('a persisted row never carries transcript text', () => withLedger(async (file) => {
  const ledger = createLedger({ file });
  ledger.append({
    ...row(),
    raw: 'the patient has no allergies',
    cleaned: 'The patient has no allergies.',
    text: 'partial text',
  });

  const [persisted] = ledger.read();
  assert.equal('raw' in persisted, false);
  assert.equal('cleaned' in persisted, false);
  assert.equal('text' in persisted, false);
  // Neither the row nor the raw file may contain the sentence.
  assert.equal(fs.readFileSync(file, 'utf8').includes('allergies'), false);
}));

test('a trailing partial line is ignored', () => withLedger(async (file) => {
  fs.writeFileSync(file, JSON.stringify(row({ id: 'complete' })) + '\n' + '{"ts":17000');
  const ledger = createLedger({ file });

  assert.deepEqual(ledger.read().map((r) => r.id), ['complete']);
  // The partial write is not a complete row, so it is not counted either.
  assert.equal(ledger.count(), 1);
}));

test('a corrupt line is skipped, not thrown', () => withLedger(async (file) => {
  fs.writeFileSync(
    file,
    JSON.stringify(row({ id: 'a' })) + '\nnot json\n' + JSON.stringify(row({ id: 'b' })) + '\n'
  );
  const ledger = createLedger({ file });

  assert.deepEqual(ledger.read().map((r) => r.id), ['a', 'b']);
}));

test('a missing file reads as an empty ledger', () => withLedger(async (file) => {
  const ledger = createLedger({ file });
  assert.deepEqual(ledger.read(), []);
  assert.equal(ledger.count(), 0);
}));

test('clear leaves zero rows and zeroes the count', () => withLedger(async (file) => {
  const ledger = createLedger({ file });
  ledger.append(row({ id: 'a' }));
  ledger.append(row({ id: 'b' }));

  assert.equal(ledger.clear(), true);
  assert.deepEqual(ledger.read(), []);
  assert.equal(ledger.count(), 0);
}));

test('the count is cached, not re-read from the file', () => withLedger(async (file) => {
  const ledger = createLedger({ file });
  assert.equal(ledger.count(), 0);
  ledger.append(row({ id: 'a' }));
  assert.equal(ledger.count(), 1);
  ledger.append(row({ id: 'b' }));
  assert.equal(ledger.count(), 2);

  // Truncate behind the ledger's back: a count() that re-reads would return 0.
  fs.writeFileSync(file, '');
  assert.equal(ledger.count(), 2);
}));

test('setFile recomputes the count from the new location', () => withLedger(async (file, dir) => {
  const ledger = createLedger({ file });
  ledger.append(row({ id: 'a' }));

  const moved = path.join(dir, 'moved', 'dictata-audit.ndjson');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.copyFileSync(file, moved);

  ledger.setFile(moved);
  assert.equal(ledger.file, moved);
  assert.equal(ledger.count(), 1);
}));

test('a failing write is swallowed and does not inflate the count', () => withLedger(async (_file, dir) => {
  // A directory where the file should be makes appendFileSync throw.
  const ledger = createLedger({ file: dir });
  assert.equal(ledger.append(row()), false);
  assert.equal(ledger.count(), 0);
}));

test('D-11 invariant: a purged transcript leaves no text, the audit row survives', () => withLedger(async (file) => {
  const transcript = 'the patient has no known drug allergies';
  const id = 'shared-id';
  const data = {
    settings: { retentionDays: 0, model: 'gemini-2.5-flash' },
    history: [{
      id,
      raw: transcript,
      cleaned: transcript,
      words: 7,
      durationMs: 2400,
      at: 1700000000000,
    }],
    events: [],
    stats: { words: 7, sessions: 1, msSpoken: 2400 },
  };

  const ledger = createLedger({ file });
  ledger.append({
    ts: 1700000000000,
    id,
    outcome: 'pasted',
    targetApp: 'notepad.exe',
    durationMs: 2400,
    words: 7,
    model: 'gemini-2.5-flash',
  });

  purgeEntryData(data, id);

  // Zero characters of the transcript remain in the persisted record.
  assert.equal(JSON.stringify(data).includes(transcript), false);
  assert.equal(JSON.stringify(data).includes('allergies'), false);

  // The audit fact is untouched: one row, still keyed to the same id.
  const rows = ledger.read().filter((r) => r.id === id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'pasted');
  assert.equal(ledger.count(), 1);
  // And the ledger never held the text in the first place.
  assert.equal(fs.readFileSync(file, 'utf8').includes('allergies'), false);
}));
