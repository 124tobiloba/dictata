// Unit tests for relocatable storage (COMP-02, D-14).
//
// These run against real temp directories: the properties that matter are
// filesystem properties (one verified copy at every crash point, no directory
// ever removed, a partial target discarded and retryable), not return values.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStorage, samePath } = require('../src/main/storage');

// ── Fixtures ──────────────────────────────────────────────────────────────────
function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dictata-storage-'));
}

function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* Windows can hold a handle briefly; the OS cleans temp eventually */ }
}

function writeStore(dir, history = []) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dictata.json'), JSON.stringify({ settings: {}, history }, null, 2));
}

function writeLedger(dir, rows = []) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'dictata-audit.ndjson'),
    rows.map((row) => JSON.stringify(row) + '\n').join(''),
  );
}

function writePointer(root, pointer) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'storage.json'), JSON.stringify(pointer, null, 2));
}

function readPointerFile(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'storage.json'), 'utf8'));
}

/** A root with `appdata` (the pointer + default store) and `moved` siblings. */
function fixture() {
  const root = tempRoot();
  const userData = path.join(root, 'appdata');
  const target = path.join(root, 'moved');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  return { root, userData, target };
}

// ── samePath ──────────────────────────────────────────────────────────────────
test('samePath compares resolved directories, never a string prefix', () => {
  assert.equal(samePath(path.join('a', 'b'), path.join('a', '.', 'b')), true);
  assert.equal(samePath('C:\\Data\\Dictata', 'C:\\Data\\Dictata\\Archive'), false);
  assert.equal(samePath('C:\\Data', 'D:\\Data'), false);
  // Windows paths are case-insensitive; other platforms are not.
  assert.equal(
    samePath('C:\\Data\\Dictata', 'c:\\data\\dictata'),
    process.platform === 'win32',
  );
});

// ── Resolution ────────────────────────────────────────────────────────────────
test('resolves to the app data folder when no pointer exists', () => {
  const { root, userData } = fixture();
  try {
    const storage = createStorage({ userDataDir: userData });
    assert.ok(samePath(storage.resolveStoreDir(), userData));
    assert.ok(samePath(storage.currentDir(), userData));
  } finally {
    removeTree(root);
  }
});

test('a corrupt pointer falls back to the default instead of aborting launch', () => {
  const { root, userData } = fixture();
  try {
    writePointer(userData, 'this is not json');
    const storage = createStorage({ userDataDir: userData });
    assert.ok(samePath(storage.resolveStoreDir(), userData));
  } finally {
    removeTree(root);
  }
});

test('a pointer missing pendingDelete and move is normalised', () => {
  const { root, target } = fixture();
  try {
    writePointer(root, { version: 1, dir: target });
    const storage = createStorage({ userDataDir: root });
    const pointer = storage.readPointer();
    assert.deepEqual(pointer.pendingDelete, []);
    assert.equal(pointer.move, null);
    assert.ok(samePath(pointer.dir, target));
  } finally {
    removeTree(root);
  }
});

// ── A complete move ───────────────────────────────────────────────────────────
test('moveTo copies the store and ledger, commits the pointer and removes the originals', () => {
  const { root, userData, target } = fixture();
  try {
    writeStore(userData, [{ id: 'a', cleaned: 'hello world' }]);
    writeLedger(userData, [{ ts: 1, id: 'a', outcome: 'pasted' }]);

    const storage = createStorage({ userDataDir: userData });
    const result = storage.moveTo(target);

    assert.equal(result.moved, true, result.message);
    assert.ok(samePath(result.dir, target));
    assert.ok(fs.existsSync(path.join(target, 'dictata.json')));
    assert.ok(fs.existsSync(path.join(target, 'dictata-audit.ndjson')));

    // D-14: no silent second copy.
    assert.equal(fs.existsSync(path.join(userData, 'dictata.json')), false);
    assert.equal(fs.existsSync(path.join(userData, 'dictata-audit.ndjson')), false);

    const pointer = readPointerFile(userData);
    assert.ok(samePath(pointer.dir, target));
    assert.deepEqual(pointer.pendingDelete, []);
    assert.equal(pointer.move, null);
    assert.ok(samePath(storage.currentDir(), target));

    // It reads back as the record.
    const copied = JSON.parse(fs.readFileSync(path.join(target, 'dictata.json'), 'utf8'));
    assert.equal(copied.history.length, 1);
  } finally {
    removeTree(root);
  }
});

// ── Refusals ──────────────────────────────────────────────────────────────────
test('a target that already holds a record is refused and the source is untouched', () => {
  const { root, userData, target } = fixture();
  try {
    writeStore(userData, [{ id: 'source', cleaned: 'keep me' }]);
    writeStore(target, [{ id: 'someone-else', cleaned: 'never overwrite' }]);
    writePointer(userData, { version: 1, dir: userData, pendingDelete: [], move: null });
    const before = fs.readFileSync(path.join(userData, 'dictata.json'), 'utf8');
    const pointerBefore = fs.readFileSync(path.join(userData, 'storage.json'), 'utf8');

    const storage = createStorage({ userDataDir: userData });
    const result = storage.moveTo(target);

    assert.equal(result.moved, false);
    assert.match(result.message, /already contains/i);
    assert.equal(fs.readFileSync(path.join(userData, 'dictata.json'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(userData, 'storage.json'), 'utf8'), pointerBefore);
    // The other record was not touched either.
    assert.ok(fs.existsSync(path.join(target, 'dictata.json')));
  } finally {
    removeTree(root);
  }
});

test('a target inside the app data folder is refused', () => {
  const { root, userData } = fixture();
  try {
    const inside = path.join(userData, 'archive');
    fs.mkdirSync(inside);
    writeStore(userData, []);

    const storage = createStorage({ userDataDir: userData });
    const result = storage.moveTo(inside);

    assert.equal(result.moved, false);
    assert.match(result.message, /app data folder/i);
    assert.ok(fs.existsSync(path.join(userData, 'dictata.json')));
  } finally {
    removeTree(root);
  }
});

test('a relative target is refused', () => {
  const { root, userData } = fixture();
  try {
    writeStore(userData, []);
    const storage = createStorage({ userDataDir: userData });
    const result = storage.moveTo(path.join('relative', 'folder'));
    assert.equal(result.moved, false);
    assert.match(result.message, /absolute/i);
  } finally {
    removeTree(root);
  }
});

test('a file is refused as a destination, whether by type or by extension', () => {
  const { root, userData } = fixture();
  try {
    writeStore(userData, []);
    const storage = createStorage({ userDataDir: userData });

    const asJson = path.join(root, 'a-record.json');
    fs.writeFileSync(asJson, '{}');
    const byExtension = storage.moveTo(asJson);
    assert.equal(byExtension.moved, false);
    assert.match(byExtension.message, /file, not a folder/i);

    const plainFile = path.join(root, 'plain');
    fs.writeFileSync(plainFile, 'x');
    const byType = storage.moveTo(plainFile);
    assert.equal(byType.moved, false);
    assert.match(byType.message, /file, not a folder/i);
  } finally {
    removeTree(root);
  }
});

test('a target that cannot be created leaves the source readable and the journal clear', () => {
  const { root, userData } = fixture();
  try {
    writeStore(userData, [{ id: 'a', cleaned: 'still here' }]);
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'not a folder');

    const storage = createStorage({ userDataDir: userData });
    const result = storage.moveTo(path.join(blocker, 'child'));

    assert.equal(result.moved, false);
    assert.ok(fs.existsSync(path.join(userData, 'dictata.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'dictata.json'), 'utf8')).history.length, 1);
    assert.equal(storage.readPointer().move, null);
  } finally {
    removeTree(root);
  }
});

// ── Crash windows (the required properties) ───────────────────────────────────
test('recovery never deletes the directory the pointer resolves to', () => {
  const { root, userData } = fixture();
  try {
    writeStore(userData, [{ id: 'a', cleaned: 'the record' }]);
    // The shape an incorrect journal produces — dir and pendingDelete agree.
    writePointer(userData, { version: 1, dir: userData, pendingDelete: [userData], move: null });

    const storage = createStorage({ userDataDir: userData });
    const resolved = storage.resolveStoreDir();

    assert.ok(samePath(resolved, userData));
    assert.ok(fs.existsSync(path.join(userData, 'dictata.json')), 'the source must survive');
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'dictata.json'), 'utf8')).history.length, 1);
    assert.deepEqual(readPointerFile(userData).pendingDelete, []);
  } finally {
    removeTree(root);
  }
});

test('pendingDelete is swept only when the resolved store verifies', () => {
  const { root, userData } = fixture();
  try {
    const other = path.join(root, 'old-copy');
    writeStore(userData, [{ id: 'new', cleaned: 'authoritative' }]);
    writeStore(other, [{ id: 'old', cleaned: 'superseded' }]);
    writeLedger(other, [{ ts: 1, id: 'old', outcome: 'pasted' }]);
    writePointer(userData, { version: 1, dir: userData, pendingDelete: [other], move: null });

    let storage = createStorage({ userDataDir: userData });
    assert.ok(samePath(storage.resolveStoreDir(), userData));
    assert.equal(fs.existsSync(path.join(other, 'dictata.json')), false);
    assert.equal(fs.existsSync(path.join(other, 'dictata-audit.ndjson')), false);
    assert.deepEqual(readPointerFile(userData).pendingDelete, []);

    // ...and the same journal with an unreadable resolved store keeps it.
    const second = path.join(root, 'old-copy-2');
    writeStore(second, [{ id: 'old', cleaned: 'keep' }]);
    fs.writeFileSync(path.join(userData, 'dictata.json'), '{ broken');
    writePointer(userData, { version: 1, dir: userData, pendingDelete: [second], move: null });

    storage = createStorage({ userDataDir: userData });
    assert.ok(samePath(storage.resolveStoreDir(), userData));
    assert.ok(fs.existsSync(path.join(second, 'dictata.json')), 'nothing proved the new copy is usable');
    assert.deepEqual(readPointerFile(userData).pendingDelete, [second]);
  } finally {
    removeTree(root);
  }
});

test('a truncated target is discarded, the source kept, and the same folder can be retried', () => {
  const { root, userData, target } = fixture();
  try {
    writeStore(userData, [{ id: 'a', cleaned: 'source record' }]);
    writeLedger(userData, [{ ts: 1, id: 'a', outcome: 'pasted' }]);
    // A crash mid-copy left a partial file at the target.
    fs.writeFileSync(path.join(target, 'dictata.json'), '{"history": [');
    writePointer(userData, {
      version: 1,
      dir: userData,
      pendingDelete: [],
      move: { from: userData, to: target, bytes: 99999, historyCount: 1, ledgerLines: 1 },
    });

    const storage = createStorage({ userDataDir: userData });
    const resolved = storage.resolveStoreDir();

    assert.ok(samePath(resolved, userData), 'an unverified copy must not become authoritative');
    assert.ok(fs.existsSync(path.join(userData, 'dictata.json')), 'the source is the record');
    assert.equal(fs.existsSync(path.join(target, 'dictata.json')), false, 'the partial copy is discarded');
    assert.equal(storage.readPointer().move, null);

    // The partial file must not make the same folder permanently unusable.
    const retry = storage.moveTo(target);
    assert.equal(retry.moved, true, retry.message);
    assert.ok(fs.existsSync(path.join(target, 'dictata.json')));
  } finally {
    removeTree(root);
  }
});

test('a fully copied, verifying target is committed and the source removed', () => {
  const { root, userData, target } = fixture();
  try {
    writeStore(userData, [{ id: 'a', cleaned: 'the record' }, { id: 'b', cleaned: 'second' }]);
    writeLedger(userData, [
      { ts: 1, id: 'a', outcome: 'pasted' },
      { ts: 2, id: 'b', outcome: 'failed' },
    ]);
    // A crash after the copy but before the commit leaves both copies.
    fs.copyFileSync(path.join(userData, 'dictata.json'), path.join(target, 'dictata.json'));
    fs.copyFileSync(path.join(userData, 'dictata-audit.ndjson'), path.join(target, 'dictata-audit.ndjson'));
    const bytes = fs.statSync(path.join(target, 'dictata.json')).size;
    writePointer(userData, {
      version: 1,
      dir: userData,
      pendingDelete: [],
      move: { from: userData, to: target, bytes, historyCount: 2, ledgerLines: 2 },
    });

    const storage = createStorage({ userDataDir: userData });
    const resolved = storage.resolveStoreDir();

    assert.ok(samePath(resolved, target), 'a verified target becomes authoritative');
    assert.ok(fs.existsSync(path.join(target, 'dictata.json')));
    assert.equal(fs.existsSync(path.join(userData, 'dictata.json')), false);
    assert.equal(fs.existsSync(path.join(userData, 'dictata-audit.ndjson')), false);

    const pointer = readPointerFile(userData);
    assert.ok(samePath(pointer.dir, target));
    assert.deepEqual(pointer.pendingDelete, []);
    assert.equal(pointer.move, null);
  } finally {
    removeTree(root);
  }
});

// ── WR-01: a partial target must never block the retry ───────────────────────
test('a mid-copy failure discards the partial target and lets the same folder be retried', () => {
  const { root, userData, target } = fixture();
  const realCopy = fs.copyFileSync;
  try {
    writeStore(userData, [{ id: 'a', cleaned: 'source record' }]);
    writeLedger(userData, [{ ts: 1, id: 'a', outcome: 'pasted' }]);
    const storage = createStorage({ userDataDir: userData });

    // Simulate a copy that dies after writing part of the destination:
    // full disk, dropped share, or an antivirus lock.
    fs.copyFileSync = (from, to) => {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, '{"history": [');
      throw new Error('simulated mid-copy failure');
    };
    let failed;
    try {
      failed = storage.moveTo(target);
    } finally {
      fs.copyFileSync = realCopy;
    }

    assert.equal(failed.moved, false);
    assert.equal(storage.readPointer().move, null);
    assert.equal(
      fs.existsSync(path.join(target, 'dictata.json')),
      false,
      'the partial file this call wrote must be discarded',
    );

    // The folder must not be refused forever by the "already contains a
    // record" guard: the same folder is retryable.
    const retry = storage.moveTo(target);
    assert.equal(retry.moved, true, retry.message);
    assert.ok(fs.existsSync(path.join(target, 'dictata.json')));
  } finally {
    fs.copyFileSync = realCopy;
    removeTree(root);
  }
});

test('a cleanup that cannot remove the partial copy keeps the journal for a retry', () => {
  const { root, userData, target } = fixture();
  const realRm = fs.rmSync;
  try {
    writeStore(userData, [{ id: 'a', cleaned: 'source record' }]);
    const partial = path.join(target, 'dictata.json');
    fs.writeFileSync(partial, '{"history": [');
    writePointer(userData, {
      version: 1,
      dir: userData,
      pendingDelete: [],
      move: { from: userData, to: target, bytes: 99999, historyCount: 1, ledgerLines: 0 },
    });

    // The share is offline: removing the partial file fails.
    fs.rmSync = (file, opts) => {
      if (path.resolve(String(file)) === path.resolve(partial)) throw new Error('share offline');
      return realRm(file, opts);
    };
    let storage;
    try {
      storage = createStorage({ userDataDir: userData });
      assert.ok(samePath(storage.resolveStoreDir(), userData));
    } finally {
      fs.rmSync = realRm;
    }

    assert.ok(fs.existsSync(partial), 'the debris is still there');
    assert.notEqual(storage.readPointer().move, null, 'the journal is kept so the next launch retries');
  } finally {
    fs.rmSync = realRm;
    removeTree(root);
  }
});

test('a pendingDelete whose files are already gone does not throw and is cleared', () => {
  const { root, userData } = fixture();
  try {
    const gone = path.join(root, 'already-cleaned');
    fs.mkdirSync(gone, { recursive: true });
    writeStore(userData, [{ id: 'a', cleaned: 'the record' }]);
    writePointer(userData, { version: 1, dir: userData, pendingDelete: [gone], move: null });

    const storage = createStorage({ userDataDir: userData });
    assert.ok(samePath(storage.resolveStoreDir(), userData));
    assert.deepEqual(readPointerFile(userData).pendingDelete, []);
  } finally {
    removeTree(root);
  }
});
