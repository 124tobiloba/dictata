// Unit tests for the retention window rules.
//   node --test test/retention.test.js
const test = require('node:test');
const assert = require('node:assert');

const {
  RETENTION_CHOICES,
  normalizeRetentionDays,
  cutoffFor,
  splitExpired,
  splitExpiredEvents,
} = require('../src/main/retention');

/** A row shaped like a stored history entry. */
function entry(id, at, over = {}) {
  return { id, at, cleaned: `${id} text`, raw: `${id} text`, words: 2, durationMs: 1000, ...over };
}

test('only the four offered windows are legal', () => {
  assert.deepEqual(RETENTION_CHOICES, [0, 30, 90, 365]);
});

test('keep forever is the fallback for anything unrecognised', () => {
  assert.equal(normalizeRetentionDays(0), 0);
  assert.equal(normalizeRetentionDays(7), 0);
  assert.equal(normalizeRetentionDays('forever'), 0);
  assert.equal(normalizeRetentionDays(null), 0);
  assert.equal(normalizeRetentionDays(undefined), 0);
  assert.equal(normalizeRetentionDays(-30), 0);
  // The offered windows survive, including the string a <select> hands over.
  assert.equal(normalizeRetentionDays(30), 30);
  assert.equal(normalizeRetentionDays('365'), 365);
});

test('keep forever has no cutoff, so a sweep removes nothing', () => {
  assert.equal(cutoffFor(0, Date.now()), null);
  assert.equal(cutoffFor(-1, Date.now()), null);
});

test('a 30-day window at a fixed clock', () => {
  // Mid-June: no DST transition sits in the preceding 30 days in either
  // hemisphere, so the cutoff is exactly 30 calendar days earlier.
  const now = new Date(2026, 5, 15, 12, 0, 0, 0).getTime();
  const cutoff = cutoffFor(30, now);
  assert.equal(cutoff, new Date(2026, 4, 16, 12, 0, 0, 0).getTime());
});

test('a cutoff keeps the local clock time across a DST change', () => {
  // Both the European (late Oct) and US (early Nov) switches fall between
  // Nov 10 and Oct 11. Calendar arithmetic keeps the local hour; subtracting
  // milliseconds would drift it.
  const now = new Date(2026, 10, 10, 12, 0, 0, 0).getTime();
  const cutoff = new Date(cutoffFor(30, now));
  assert.equal(cutoff.getMonth(), 9);
  assert.equal(cutoff.getDate(), 11);
  assert.equal(cutoff.getHours(), 12);
  assert.equal(cutoff.getMinutes(), 0);
});

test('splitExpired keeps a row stamped exactly at the cutoff', () => {
  const cutoff = 1000;
  const { keep, expiredIds } = splitExpired([entry('new', 1500), entry('edge', cutoff), entry('old', 999)], cutoff);
  assert.deepEqual(keep.map((h) => h.id), ['new', 'edge']);
  assert.deepEqual(expiredIds, ['old']);
});

test('a row without a timestamp expires rather than staying forever', () => {
  const { keep, expiredIds } = splitExpired([entry('no-ts', undefined), entry('ok', 5000)], 1000);
  assert.deepEqual(keep.map((h) => h.id), ['ok']);
  assert.deepEqual(expiredIds, ['no-ts']);
});

test('an empty or missing history splits cleanly', () => {
  assert.deepEqual(splitExpired([], 1000), { keep: [], expiredIds: [] });
  assert.deepEqual(splitExpired(undefined, 1000), { keep: [], expiredIds: [] });
});

test('splitExpiredEvents expires an old event and keeps a boundary-equal one', () => {
  const events = [
    { id: 'mhqk3z1a-0', type: 'error', message: 'Audio is silent', ts: 900 },
    { id: 'mhqk3z1a-1', type: 'error', message: 'Network error', ts: 1000 },
    { id: 'mhqk3z1a-2', type: 'info', message: 'Note', ts: 2000 },
  ];
  const { keep, expiredIds } = splitExpiredEvents(events, 1000);
  assert.deepEqual(keep.map((e) => e.id), ['mhqk3z1a-1', 'mhqk3z1a-2']);
  assert.deepEqual(expiredIds, ['mhqk3z1a-0']);
});
