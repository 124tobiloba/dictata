// Unit tests for the settings merge logic.
const test = require('node:test');
const assert = require('node:assert');
const { mergeDefaults, DEFAULTS } = require('../src/main/store');

test('an empty file yields the defaults', () => {
  const s = mergeDefaults({});
  assert.equal(s.settings.model, DEFAULTS.settings.model);
  assert.equal(s.settings.style, DEFAULTS.settings.style);
  assert.deepEqual(s.settings.shortcuts, DEFAULTS.settings.shortcuts);
  assert.deepEqual(s.history, []);
  assert.equal(s.stats.words, 0);
});

test('a missing file yields the defaults', () => {
  const s = mergeDefaults(null);
  assert.equal(s.settings.doubleTapLocks, DEFAULTS.settings.doubleTapLocks);
});

test('stored values win over the defaults', () => {
  const s = mergeDefaults({ settings: { style: 'verbatim', sounds: false } });
  assert.equal(s.settings.style, 'verbatim');
  assert.equal(s.settings.sounds, false);
  // untouched keys keep their default
  assert.equal(s.settings.language, DEFAULTS.settings.language);
});

test('shortcuts are merged, not replaced', () => {
  const s = mergeDefaults({ settings: { shortcuts: { pushToTalk: ['Ctrl', 'K'] } } });
  assert.deepEqual(s.settings.shortcuts.pushToTalk, ['Ctrl', 'K']);
  assert.deepEqual(s.settings.shortcuts.cancel, DEFAULTS.settings.shortcuts.cancel);
});

test('collections and stats are restored', () => {
  const s = mergeDefaults({
    dictionary: [{ term: 'npm' }],
    replacements: [{ from: 'a', to: 'b' }],
    history: [{ id: '1' }],
    stats: { words: 42, sessions: 3, msSpoken: 9000 },
  });
  assert.deepEqual(s.dictionary, [{ term: 'npm' }]);
  assert.deepEqual(s.replacements, [{ from: 'a', to: 'b' }]);
  assert.equal(s.history.length, 1);
  assert.equal(s.stats.words, 42);
  assert.equal(s.stats.sessions, 3);
});
