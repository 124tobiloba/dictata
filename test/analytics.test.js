// Unit tests for the activity analytics.
const test = require('node:test');
const assert = require('node:assert');

const { summarize, computeStats, wordCount, normalizeError } = require('../src/main/analytics');

const HOUR = 3600000;
const DAY = 86400000;

function entry(over = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    raw: 'raw text here',
    cleaned: 'Raw text here',
    durationMs: 5000,
    transcribeMs: 1500,
    model: 'gemini-2.5-flash',
    at: Date.now(),
    ...over,
  };
}

test('counts words', () => {
  assert.equal(wordCount('one two three'), 3);
  assert.equal(wordCount('  spaced   out  '), 2);
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount(null), 0);
});

test('totals words, sessions and speaking time', () => {
  const s = summarize({
    history: [
      entry({ cleaned: 'one two three' }),
      entry({ cleaned: 'four five', durationMs: 10000 }),
    ],
  });
  assert.equal(s.totals.words, 5);
  assert.equal(s.totals.sessions, 2);
  assert.equal(s.totals.minutes, 0.3);
  assert.equal(s.totals.avgLatencyMs, 1500);
});

test('computes words per minute', () => {
  const s = summarize({
    history: [entry({ cleaned: 'a b c d e f g h i j', durationMs: 30000 })],
  });
  assert.equal(s.totals.wpm, 20);
});

test('computeStats agrees with the summary totals', () => {
  const history = [
    entry({ cleaned: 'one two three' }),
    entry({ cleaned: 'four five', durationMs: 10000, words: 2 }),
    entry({ cleaned: '', raw: 'six seven eight nine', durationMs: 1000 }),
  ];
  const stats = computeStats(history);

  // D-06: the stored record must equal the words the page shows.
  assert.equal(stats.words, summarize({ history }).totals.words);
  assert.equal(stats.words, 9);
  assert.equal(stats.sessions, 3);
  assert.equal(stats.msSpoken, 16000);
});

test('computeStats is empty and safe with no history', () => {
  assert.deepEqual(computeStats(), { words: 0, sessions: 0, msSpoken: 0 });
  assert.deepEqual(computeStats([null, undefined]), { words: 0, sessions: 0, msSpoken: 0 });
});

test('counts errors and the error rate', () => {
  const s = summarize({
    history: [entry(), entry()],
    events: [{ type: 'error', message: 'Gemini 429: busy', ts: Date.now() }],
  });
  assert.equal(s.totals.errors, 1);
  assert.equal(s.totals.errorRate, 33);
});

test('groups similar error messages', () => {
  const s = summarize({
    history: [],
    events: [
      { type: 'error', message: 'Gemini 429: Resource exhausted', ts: 1 },
      { type: 'error', message: 'Gemini 429: quota exceeded', ts: 2 },
      { type: 'error', message: 'No audio from microphone — check Windows mic permission', ts: 3 },
    ],
  });
  assert.equal(s.errorGroups.length, 2);
  assert.equal(s.errorGroups[0].message, 'Gemini 429');
  assert.equal(s.errorGroups[0].count, 2);
});

test('normalises the error messages it knows', () => {
  assert.equal(normalizeError('Gemini 503: high demand'), 'Gemini 503');
  assert.equal(normalizeError('Gemini timed out after 30s'), 'Request timed out');
  assert.equal(normalizeError('No speech detected'), 'No speech detected');
  assert.equal(normalizeError('No audio from microphone'), 'Microphone unavailable');
  assert.equal(normalizeError('Network error: ENOTFOUND'), 'Network error');
  assert.equal(normalizeError('something else entirely'), 'something else entirely');
});

test('builds seven days of word counts', () => {
  const s = summarize({ history: [entry({ at: Date.now() })] });
  assert.equal(s.days.length, 7);
  assert.equal(s.days[6].words, 3, 'today has the words');
  assert.equal(s.days[0].words, 0, 'six days ago is empty');
  assert.equal(s.days[6].sessions, 1);
});

test('splits the history into models and hours', () => {
  const s = summarize({
    history: [
      entry({ model: 'gemini-2.5-flash' }),
      entry({ model: 'gemini-2.5-flash' }),
      entry({ model: 'gemini-3.5-flash' }),
    ],
  });
  assert.equal(s.models[0].name, 'gemini-2.5-flash');
  assert.equal(s.models[0].count, 2);
  assert.equal(s.hours.length, 24);
  assert.equal(s.hours.reduce((a, b) => a + b, 0), 3);
});

test('keeps the latency series oldest first', () => {
  const now = Date.now();
  const s = summarize({
    history: [
      entry({ at: now, transcribeMs: 300 }),
      entry({ at: now - HOUR, transcribeMs: 100 }),
    ],
  });
  assert.equal(s.latency.length, 2);
  assert.equal(s.latency[0].ms, 100, 'the older entry comes first');
});

test('survives empty input', () => {
  const s = summarize();
  assert.equal(s.totals.words, 0);
  assert.equal(s.totals.sessions, 0);
  assert.equal(s.totals.avgLatencyMs, null);
  assert.equal(s.days.length, 7);
});
