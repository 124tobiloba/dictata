// Unit tests for the CSV / export shaping rules.
const test = require('node:test');
const assert = require('node:assert');

const {
  csvField,
  toCsv,
  historyRows,
  auditRows,
  HISTORY_COLUMNS,
  AUDIT_COLUMNS,
} = require('../src/main/exporter');

const AT = Date.UTC(2026, 9, 22, 9, 30, 0);

function entry(over = {}) {
  return {
    id: 'abc',
    raw: 'raw text here',
    cleaned: 'Raw text here',
    words: 3,
    durationMs: 5000,
    transcribeMs: 1200,
    pasteMs: 40,
    pasted: true,
    model: 'gemini-2.5-flash',
    at: AT,
    ...over,
  };
}

function auditRecord(over = {}) {
  return {
    ts: AT,
    id: 'abc',
    outcome: 'pasted',
    targetApp: 'notepad.exe',
    durationMs: 5000,
    words: 3,
    model: 'gemini-2.5-flash',
    ...over,
  };
}

test('a CSV document starts with the UTF-8 BOM', () => {
  const csv = toCsv([['a']]);
  assert.deepEqual(Buffer.from(csv, 'utf8').subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
});

test('rows are comma-separated and CRLF-terminated', () => {
  const csv = toCsv([['one', 'two'], ['three', 'four']]);
  assert.equal(csv, '\uFEFFone,two\r\nthree,four');
});

test('a comma, a quote and embedded newlines stay inside one quoted cell', () => {
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line 1\r\nline 2'), '"line 1\r\nline 2"');
  // One cell, so a row keeps its column count.
  assert.equal(toCsv([['head'], ['a,b', 'tail']]), '\uFEFFhead\r\n"a,b",tail');
});

test('a formula-leading cell gets a single-quote guard', () => {
  assert.equal(csvField('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvField('+1'), "'+1");
  assert.equal(csvField('-1'), "'-1");
  assert.equal(csvField('@cmd'), "'@cmd");
  assert.equal(csvField('\tindent'), "'\tindent");
  assert.equal(csvField('\rcr'), `"'\rcr"`);   // the CR also forces quoting
  // Ordinary prose is untouched.
  assert.equal(csvField('hello world'), 'hello world');
  assert.equal(csvField(''), '');
  assert.equal(csvField(null), '');
});

test('history rows are one per entry with an ISO timestamp', () => {
  const rows = historyRows([entry(), entry({ id: 'def', cleaned: 'second' })]);
  assert.equal(rows.length, 3, 'a header plus one row per entry');
  assert.deepEqual(rows[0], HISTORY_COLUMNS);
  assert.equal(rows[1][0], new Date(AT).toISOString());
  assert.equal(rows[1][1], 'Raw text here');
  assert.equal(rows[1][2], 'raw text here');
  assert.equal(rows[1][3], 3);
  assert.equal(rows[1][7], 'true');
  assert.equal(rows[2][1], 'second');
});

test('history words fall back to the stored count and then to the text', () => {
  const rows = historyRows([
    entry({ words: 7, cleaned: 'one two' }),
    entry({ words: undefined, cleaned: 'one two three four' }),
    entry({ words: undefined, cleaned: '', raw: '  five   six  ' }),
  ]);
  assert.equal(rows[1][3], 7, 'the stored count wins');
  assert.equal(rows[2][3], 4, 'otherwise the cleaned text is counted');
  assert.equal(rows[3][3], 2, 'raw text is the last resort');
});

test('an unparseable timestamp becomes an empty cell', () => {
  const rows = historyRows([entry({ at: undefined })]);
  assert.equal(rows[1][0], '');
});

test('an empty history still exports its header', () => {
  const rows = historyRows([]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], HISTORY_COLUMNS);
});

test('audit rows carry metadata only, never transcript text', () => {
  const rows = auditRows([
    auditRecord({ text: 'TOP SECRET dictated words', raw: 'TOP SECRET', cleaned: 'TOP SECRET' }),
  ]);
  assert.deepEqual(rows[0], AUDIT_COLUMNS);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], 'abc');
  assert.equal(rows[1][2], 'pasted');
  assert.equal(rows[1][3], 'notepad.exe');
  assert.equal(rows[1][6], 'gemini-2.5-flash');

  const serialised = JSON.stringify(rows);
  assert.equal(serialised.includes('TOP SECRET'), false);
  assert.equal(serialised.includes('text'), false);
  assert.equal(serialised.includes('raw'), false);
  assert.equal(serialised.includes('cleaned'), false);
});

test('audit rows keep the outcome vocabulary and error kind', () => {
  const rows = auditRows([auditRecord({ outcome: 'failed', errorKind: 'paste' })]);
  assert.equal(rows[1][2], 'failed');
  assert.equal(rows[1][7], 'paste');
  assert.equal(rows[1][4], 5000);
});
