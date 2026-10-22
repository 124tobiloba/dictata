// Unit tests for the settings merge logic and the record's mutation path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  mergeDefaults,
  DEFAULTS,
  Store,
  decryptSecret,
  purgeEntryData,
  clearAllData,
  purgeExpiredData,
  pruneEventsData,
} = require('../src/main/store');

/** A store document shaped like the one on disk. */
function doc(over = {}) {
  return {
    settings: { model: 'gemini-2.5-flash', apiKey: '' },
    dictionary: [{ term: 'npm' }],
    replacements: [{ from: 'a', to: 'b' }],
    dashboardToken: 'token-123',
    history: [
      { id: 'b', cleaned: 'b b', raw: 'b b', words: 2, durationMs: 2000, at: 2 },
      { id: 'a', cleaned: 'a', raw: 'a', words: 1, durationMs: 1000, at: 1 },
    ],
    events: [
      { id: 'mhqk3z1a-0', type: 'error', message: 'Audio is silent', ts: 3 },
      { id: 'b', type: 'dictation', ts: 2 },
    ],
    stats: { words: 99, sessions: 9, msSpoken: 99999 },
    ...over,
  };
}

/** A throwaway store directory, removed whatever the test does. */
function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictata-store-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

test('the dashboard token survives a restart', () => {
  // A rotating token silently breaks every open browser tab, so it has to
  // be stored.
  const stored = mergeDefaults({ dashboardToken: 'abc123' });
  assert.equal(stored.dashboardToken, 'abc123');
  assert.equal(mergeDefaults({}).dashboardToken, '');
});

test('purging one id removes the dictation row and its persisted event', () => {
  const data = doc();
  const result = purgeEntryData(data, 'b');

  assert.deepEqual(result, { removed: 2, wasLast: true, ids: ['b'] });
  assert.deepEqual(data.history.map((h) => h.id), ['a']);
  assert.deepEqual(data.events.map((e) => e.id), ['mhqk3z1a-0']);

  // Stats describe the survivors, never the old counter minus a guess.
  assert.deepEqual(data.stats, { words: 1, sessions: 1, msSpoken: 1000 });
});

test('purging a failed attempt by its bus id leaves the history alone', () => {
  const data = doc();
  const result = purgeEntryData(data, 'mhqk3z1a-0');

  assert.deepEqual(result, { removed: 1, wasLast: false, ids: ['mhqk3z1a-0'] });
  assert.deepEqual(data.history.map((h) => h.id), ['b', 'a']);
  assert.deepEqual(data.events.map((e) => e.id), ['b']);
  assert.deepEqual(data.stats, { words: 3, sessions: 2, msSpoken: 3000 });
});

test('purging never touches settings, the token, the dictionary or replacements', () => {
  const data = doc();
  purgeEntryData(data, 'b');
  assert.deepEqual(data.settings, { model: 'gemini-2.5-flash', apiKey: '' });
  assert.equal(data.dashboardToken, 'token-123');
  assert.deepEqual(data.dictionary, [{ term: 'npm' }]);
  assert.deepEqual(data.replacements, [{ from: 'a', to: 'b' }]);
});

test('an unknown id removes nothing and reports nothing', () => {
  const data = doc();
  const result = purgeEntryData(data, 'not-here');
  assert.equal(result.removed, 0);
  assert.equal(result.wasLast, false);
  assert.deepEqual(result.ids, []);
  assert.equal(data.history.length, 2);
});

test('a purge is on disk before the call returns', () => {
  withTempDir((dir) => {
    const store = new Store({ dir });
    const row = {
      id: 'e2e-row',
      raw: 'hello there',
      cleaned: 'Hello there',
      durationMs: 1200,
      words: 2,
      at: Date.now(),
    };
    store.addHistory(row);
    assert.equal(store.purgeEntry(row.id).removed, 1);

    // Read synchronously — no timer wait. A quit here must not resurrect it.
    const onDisk = fs.readFileSync(path.join(dir, 'dictata.json'), 'utf8');
    assert.equal(onDisk.includes('e2e-row'), false);

    // A fresh Store on the same file agrees with the deleted state.
    const reopened = new Store({ dir });
    assert.deepEqual(reopened.snapshot().history, []);
    assert.deepEqual(reopened.snapshot().stats, { words: 0, sessions: 0, msSpoken: 0 });
  });
});

test('flushing twice leaves the API key readable', () => {
  withTempDir((dir) => {
    const store = new Store({ dir });
    store.updateSettings({ apiKey: 'test-key-123' });
    store.flush();
    store.flush();

    const reopened = new Store({ dir });
    assert.equal(decryptSecret(reopened.data.settings.apiKey), 'test-key-123');
  });
});

test('clearAllData empties the record but keeps identity and settings', () => {
  const data = doc();
  const removed = clearAllData(data);

  assert.equal(removed, 2);
  assert.deepEqual(data.history, []);
  assert.deepEqual(data.events, []);
  assert.deepEqual(data.stats, { words: 0, sessions: 0, msSpoken: 0 });

  // Nothing else may be rebuilt from the defaults.
  assert.deepEqual(data.settings, { model: 'gemini-2.5-flash', apiKey: '' });
  assert.equal(data.dashboardToken, 'token-123');
  assert.deepEqual(data.dictionary, [{ term: 'npm' }]);
  assert.deepEqual(data.replacements, [{ from: 'a', to: 'b' }]);
});

test('a clear-all is on disk before the call returns', () => {
  withTempDir((dir) => {
    const store = new Store({ dir });
    store.addHistory({ id: 'row-1', cleaned: 'one', raw: 'one', words: 1, durationMs: 500, at: 1 });
    store.addHistory({ id: 'row-2', cleaned: 'two', raw: 'two', words: 1, durationMs: 500, at: 2 });
    store.setDictionary([{ term: 'npm' }]);

    assert.equal(store.clearAll(), 2);

    // No timer wait: the file is rewritten inside the mutation.
    const onDisk = fs.readFileSync(path.join(dir, 'dictata.json'), 'utf8');
    assert.equal(onDisk.includes('row-1'), false);
    assert.equal(onDisk.includes('row-2'), false);

    const snap = new Store({ dir }).snapshot();
    assert.deepEqual(snap.history, []);
    assert.deepEqual(snap.events, []);
    assert.deepEqual(snap.stats, { words: 0, sessions: 0, msSpoken: 0 });
    assert.deepEqual(snap.dictionary, [{ term: 'npm' }]);
  });
});

test('an existing install upgrades with retention set to keep forever', () => {
  // A settings file written before retention existed must not start deleting
  // anything: the missing key resolves to 0, which sweeps nothing.
  const upgraded = mergeDefaults({ settings: { model: 'gemini-2.5-flash' } });
  assert.equal(DEFAULTS.settings.retentionDays, 0);
  assert.equal(upgraded.settings.retentionDays, 0);
  assert.equal(upgraded.history.length, 0);
});

test('purging expired rows recomputes stats and touches nothing else', () => {
  const data = doc();
  const removed = purgeExpiredData(data, ['a']);

  assert.equal(removed, 1);
  assert.deepEqual(data.history.map((h) => h.id), ['b']);
  assert.deepEqual(data.stats, { words: 2, sessions: 1, msSpoken: 2000 });
  // The caller prunes events separately; this helper leaves them alone.
  assert.deepEqual(data.events.map((e) => e.id), ['mhqk3z1a-0', 'b']);
  assert.deepEqual(data.settings, { model: 'gemini-2.5-flash', apiKey: '' });
  assert.equal(data.dashboardToken, 'token-123');
  assert.deepEqual(data.dictionary, [{ term: 'npm' }]);
  assert.deepEqual(data.replacements, [{ from: 'a', to: 'b' }]);
});

test('purging an unknown expired id removes nothing', () => {
  const data = doc();
  assert.equal(purgeExpiredData(data, ['nope']), 0);
  assert.equal(data.history.length, 2);
});

test('pruning persisted events cuts by timestamp and keeps the rest', () => {
  const data = doc();
  const removed = pruneEventsData(data, 4);

  assert.equal(removed, 2);
  assert.deepEqual(data.events, []);
  // The transcript is not this helper's business.
  assert.equal(data.history.length, 2);
  assert.deepEqual(data.settings, { model: 'gemini-2.5-flash', apiKey: '' });
});

test('pruning events re-applies the 500-entry cap', () => {
  // Persisted events are newest-first, so the cap must drop the tail.
  const events = [];
  for (let i = 509; i >= 0; i--) events.push({ id: `e-${i}`, type: 'info', message: 'kept', ts: 5000 + i });
  const data = doc({ events });

  pruneEventsData(data, 0);
  assert.equal(data.events.length, 500);
  assert.equal(data.events[0].id, 'e-509');
  assert.equal(data.events.at(-1).id, 'e-10');
});

test('an expired sweep is on disk before the call returns', () => {
  withTempDir((dir) => {
    const store = new Store({ dir });
    store.addHistory({ id: 'old-row', cleaned: 'old', raw: 'old', words: 1, durationMs: 500, at: 1 });
    store.addHistory({ id: 'new-row', cleaned: 'new', raw: 'new', words: 1, durationMs: 500, at: 2 });

    assert.equal(store.purgeExpired(['old-row']), 1);

    const onDisk = fs.readFileSync(path.join(dir, 'dictata.json'), 'utf8');
    assert.equal(onDisk.includes('old-row'), false);

    const snap = new Store({ dir }).snapshot();
    assert.deepEqual(snap.history.map((h) => h.id), ['new-row']);
    assert.deepEqual(snap.stats, { words: 1, sessions: 1, msSpoken: 500 });
  });
});

// ── CR-01: an unavailable relocated store must never be written ──────────────
test('an unavailable relocated store never writes an empty record', () => {
  // A user moved the record to a USB drive, then launched with the drive
  // unplugged. The empty default must not be written over the real record
  // when the drive returns.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictata-missing-'));
  try {
    const appData = path.join(root, 'appdata');
    const moved = path.join(root, 'moved');
    fs.mkdirSync(appData, { recursive: true });
    fs.mkdirSync(moved, { recursive: true });

    const store = new Store({ dir: moved, userDataDir: appData, defaultDir: appData });
    assert.equal(store.readonly, true, 'a missing record at a relocated folder is read-only');
    assert.equal(store.fileFound, false);

    // Every write path the review identified: token save, a dictation, a
    // settings change, and the unconditional before-quit flush.
    store.getOrCreateToken();
    store.addHistory({ id: 'ghost', cleaned: 'never written', raw: 'never written', words: 2, durationMs: 1, at: 1 });
    store.updateSettings({ model: 'gemini-2.5-flash' });
    store.flush();

    assert.equal(fs.existsSync(path.join(moved, 'dictata.json')), false, 'no empty record may appear');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a first run in the default app-data folder stays writable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictata-firstrun-'));
  try {
    const appData = path.join(root, 'appdata');
    fs.mkdirSync(appData, { recursive: true });

    const store = new Store({ dir: appData, userDataDir: appData, defaultDir: appData });
    assert.equal(store.readonly, false, 'the default folder may legitimately be empty');
    store.addHistory({ id: 'first', cleaned: 'first run', raw: 'first run', words: 2, durationMs: 1, at: 1 });
    store.flush();

    assert.ok(fs.existsSync(path.join(appData, 'dictata.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a reachable relocated store is writable and keeps the real record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictata-reachable-'));
  try {
    const appData = path.join(root, 'appdata');
    const moved = path.join(root, 'moved');
    fs.mkdirSync(appData, { recursive: true });
    fs.mkdirSync(moved, { recursive: true });
    fs.writeFileSync(path.join(moved, 'dictata.json'), JSON.stringify({
      settings: {},
      history: [{ id: 'real', cleaned: 'the real record', raw: 'the real record', words: 3, durationMs: 1, at: 1 }],
    }));

    const store = new Store({ dir: moved, userDataDir: appData, defaultDir: appData });
    assert.equal(store.readonly, false);
    assert.equal(store.snapshot().history[0].id, 'real');

    store.addHistory({ id: 'new', cleaned: 'second', raw: 'second', words: 1, durationMs: 1, at: 2 });
    store.flush();
    assert.ok(fs.existsSync(path.join(moved, 'dictata.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setFile points the record at the moved folder and writes there', () => {
  withTempDir((dir) => {
    const moved = path.join(dir, 'moved');
    fs.mkdirSync(moved, { recursive: true });
    const store = new Store({ dir });
    store.addHistory({ id: 'row', cleaned: 'kept', raw: 'kept', words: 1, durationMs: 500, at: 1 });

    store.setFile(path.join(moved, 'dictata.json'));
    assert.equal(store.dir, moved);
    store.flush();

    assert.ok(fs.existsSync(path.join(moved, 'dictata.json')));
    // Nothing is left behind in the folder the record came from.
    assert.equal(fs.existsSync(path.join(dir, 'dictata.json')), false);
    assert.deepEqual(new Store({ dir: moved }).snapshot().history.map((h) => h.id), ['row']);
  });
});
