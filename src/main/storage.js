/**
 * storage.js — relocatable transcript storage (COMP-02, D-14)
 *
 * The record (dictata.json plus the dictata-audit.ndjson sidecar) normally
 * lives in the app-data folder. This module owns a small pointer file,
 * storage.json, that lets the user point the app at another folder — a second
 * drive, a mapped share — and moves the record there.
 *
 * The crash-safety contract (T-01-13), which must not be reordered:
 *
 *   1. The journal is written BEFORE anything is copied. It records the
 *      intended pair in `move` and leaves `dir` on the SOURCE. `pendingDelete`
 *      is populated only by the commit — a journal that named the source in
 *      `pendingDelete` while `dir` still pointed at it would verify the source
 *      against itself and then delete it.
 *   2. Authority moves in exactly one atomic pointer write — the commit — and
 *      only after the copy at the target verified (parse + byte length +
 *      history count + ledger line count, all carried in the journal so
 *      verification still works after a crash).
 *   3. The source files are deleted only after the commit and only after
 *      re-checking that the source is no longer the resolved directory.
 *   4. Recovery never deletes the directory the pointer resolves to, and never
 *      deletes a `from` it has not proved is superseded.
 *   5. A partial target is disposable: the move refuses to start when the
 *      target already holds a dictata.json, so any dictata.json at `move.to`
 *      that fails verification was written by this move and can be removed.
 *
 * `fs.renameSync` is never used to move a file between directories — it fails
 * with EXDEV across volumes and shares, which are explicit targets. Copy with
 * COPYFILE_EXCL, verify, commit, then delete. Rename is used only inside one
 * directory, to publish the pointer atomically.
 *
 * fs/path only — no Electron — so `node --test` can exercise it against temp
 * directories.
 */

const fs = require('fs');
const path = require('path');

const POINTER_NAME = 'storage.json';
const STORE_NAME = 'dictata.json';
const LEDGER_NAME = 'dictata-audit.ndjson';
const PROBE_NAME = '.dictata-probe';

/** Files a failed or interrupted copy could have written at the target. */
const MOVE_FILES = [STORE_NAME, LEDGER_NAME, `${STORE_NAME}.moving`, `${LEDGER_NAME}.moving`];

/**
 * Compare two directory strings as paths, not as text.
 *
 * `path.resolve` makes relative inputs absolute and removes `.`/trailing
 * separators; Windows paths are additionally case-insensitive. A string-prefix
 * comparison would call `...\Dictata` and `...\Dictata\Archive` the same path,
 * which is exactly the bug that must not decide a deletion.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  let left = path.resolve(a);
  let right = path.resolve(b);
  if (process.platform === 'win32') {
    left = left.toLowerCase();
    right = right.toLowerCase();
  }
  return left === right;
}

/**
 * Count the complete lines in a file. A trailing unterminated line is a partial
 * write, not a row. Missing/unreadable file → 0. Matches ledger.countRows.
 *
 * @param {string} file
 * @returns {number}
 */
function countLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text) return 0;
    const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
    return complete.split('\n').filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

/** `resolved` lies inside `parent` (or is the same directory). */
function isInside(resolved, parent) {
  const rel = path.relative(parent, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve a path that may not exist yet, without inventing a different one. */
function realOrResolve(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Build the storage controller over one app-data folder.
 *
 * @param {object} opts
 * @param {string} opts.userDataDir  where storage.json lives
 * @returns {object}
 */
function createStorage(opts = {}) {
  const userDataDir = realOrResolve(opts.userDataDir);
  const pointerFile = path.join(userDataDir, POINTER_NAME);
  const defaultDir = userDataDir;

  /** The pointer a fresh install (or an unreadable file) gets. */
  function defaultPointer() {
    return { version: 1, dir: defaultDir, pendingDelete: [], move: null };
  }

  /**
   * Keep a pointer usable: one bad field must never abort launch.
   * A move is kept only when both ends are absolute strings.
   */
  function normalizePointer(raw) {
    if (!raw || typeof raw !== 'object') return defaultPointer();
    if (typeof raw.dir !== 'string' || !path.isAbsolute(raw.dir)) return defaultPointer();

    let move = null;
    if (raw.move && typeof raw.move === 'object'
      && typeof raw.move.from === 'string' && path.isAbsolute(raw.move.from)
      && typeof raw.move.to === 'string' && path.isAbsolute(raw.move.to)) {
      move = {
        from: path.resolve(raw.move.from),
        to: path.resolve(raw.move.to),
        bytes: Number(raw.move.bytes) || 0,
        historyCount: Number(raw.move.historyCount) || 0,
        ledgerLines: Number(raw.move.ledgerLines) || 0,
      };
    }

    return {
      version: 1,
      dir: path.resolve(raw.dir),
      pendingDelete: Array.isArray(raw.pendingDelete)
        ? raw.pendingDelete.filter((d) => typeof d === 'string' && path.isAbsolute(d)).map((d) => path.resolve(d))
        : [],
      move,
    };
  }

  /**
   * Read the pointer, falling back to the default on any error. Never throws.
   *
   * @returns {{version: number, dir: string, pendingDelete: string[], move: object|null}}
   */
  function readPointer() {
    try {
      return normalizePointer(JSON.parse(fs.readFileSync(pointerFile, 'utf8')));
    } catch {
      return defaultPointer();
    }
  }

  /**
   * Publish a pointer atomically (tmp + rename inside one directory).
   *
   * Every write in this module goes through here — the journal, the commit,
   * the recovery rewrite and the cleanup rewrite. A torn recovery write would
   * otherwise hit readPointer's default fallback while the record lives
   * elsewhere.
   */
  function writePointer(pointer) {
    fs.mkdirSync(userDataDir, { recursive: true });
    const tmp = `${pointerFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1,
      dir: pointer.dir,
      pendingDelete: Array.isArray(pointer.pendingDelete) ? pointer.pendingDelete : [],
      move: pointer.move || null,
    }, null, 2));
    fs.renameSync(tmp, pointerFile);   // same directory — atomic, no EXDEV
  }

  /** The directory the record is read from now. */
  function currentDir() {
    return readPointer().dir;
  }

  /**
   * True only when the copied record is complete and readable.
   *
   * All three expectations come from the journal so this still works after a
   * crash, when the in-memory values are gone.
   *
   * @param {object|null} move
   * @returns {boolean}
   */
  function verifyCopy(move) {
    if (!move || typeof move !== 'object') return false;
    const file = path.join(move.to, STORE_NAME);
    try {
      if (!fs.existsSync(file)) return false;
      if (fs.statSync(file).size !== move.bytes) return false;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || typeof data !== 'object' || !Array.isArray(data.history)) return false;
      if (data.history.length !== move.historyCount) return false;
      return countLines(path.join(move.to, LEDGER_NAME)) === move.ledgerLines;
    } catch {
      return false;
    }
  }

  /**
   * Delete only the files a move could have written at a target. Files only —
   * never a directory, and never through a symlinked-looking path.
   */
  function removeMoveFiles(dir) {
    for (const name of MOVE_FILES) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch { /* a file that cannot be removed is not a reason to abort */ }
    }
  }

  /**
   * Decide what an interrupted journal means, and write the answer.
   *
   * - Verifying target → the copy won: commit to it and queue the source for
   *   deletion. The caller runs finishPendingDelete next, which deletes the
   *   source only after re-verifying the target.
   * - Anything else → the target is a partial copy this move created. Delete
   *   those files (unless the target IS the resolved directory) and keep
   *   `dir` on the source. The source is the record; never delete it here.
   *
   * @param {object} pointer
   * @returns {object}  the pointer now in force
   */
  function recoverMove(pointer) {
    const move = pointer.move;
    if (!move) return pointer;

    if (verifyCopy(move)) {
      const committed = {
        version: 1,
        dir: move.to,
        pendingDelete: [move.from],
        move: null,
      };
      writePointer(committed);
      return committed;
    }

    if (!samePath(move.to, pointer.dir)) removeMoveFiles(move.to);
    const cleared = { ...pointer, move: null };
    writePointer(cleared);
    return cleared;
  }

  /**
   * Delete superseded copies — but only when the resolved store verified.
   *
   * Never deletes the directory the pointer resolves to, never deletes a
   * directory, and treats an already-absent file as a no-op so a crash between
   * the delete and this rewrite cannot make the next launch throw.
   *
   * @param {object} pointer
   * @returns {object}  the pointer now in force
   */
  function finishPendingDelete(pointer) {
    const pending = pointer.pendingDelete || [];
    if (!pending.length) return pointer;

    // Nothing has proved the new copy is usable → keep every old file.
    let verified = false;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(pointer.dir, STORE_NAME), 'utf8'));
      verified = !!data && typeof data === 'object' && Array.isArray(data.history);
    } catch {
      verified = false;
    }
    if (!verified) return pointer;

    let remainingDirs = null;
    for (const dir of pending) {
      if (samePath(dir, pointer.dir)) continue;   // the live store, not a copy
      let removed = true;
      for (const name of [STORE_NAME, LEDGER_NAME]) {
        try {
          fs.rmSync(path.join(dir, name), { force: true });
        } catch {
          removed = false;   // keep the entry so the next launch retries it
        }
      }
      if (removed) continue;
      if (!remainingDirs) remainingDirs = [];
      remainingDirs.push(dir);
    }

    const next = remainingDirs
      ? { ...pointer, pendingDelete: remainingDirs }
      : { ...pointer, pendingDelete: [] };
    writePointer(next);
    return next;
  }

  /**
   * Resolve the directory the record lives in, finishing or discarding an
   * interrupted move first.
   *
   * @returns {string}
   */
  function resolveStoreDir() {
    let pointer = readPointer();
    if (pointer.move) pointer = recoverMove(pointer);
    pointer = finishPendingDelete(pointer);
    return pointer.dir;
  }

  /**
   * Move the record to another folder: copy → verify → commit → delete.
   *
   * Every rejection lives here (T-01-12), so the IPC handler does not invent a
   * second validation path. Order matters; see the module header.
   *
   * @param {string} targetDir  a folder chosen in the native picker
   * @returns {{moved: boolean, dir?: string, message: string}}
   */
  function moveTo(targetDir) {
    const refusal = (message) => ({ moved: false, message });

    // ── Validate the destination as untrusted input ──────────────────────────
    if (typeof targetDir !== 'string' || !targetDir.trim() || !path.isAbsolute(targetDir)) {
      return refusal('Choose an absolute folder path — a relative path cannot be used.');
    }

    let resolvedTarget;
    try {
      resolvedTarget = fs.realpathSync(targetDir);
    } catch {
      return refusal('That folder does not exist — create it first, then choose it.');
    }

    let targetStat;
    try {
      targetStat = fs.statSync(resolvedTarget);
    } catch {
      return refusal('That folder could not be read — choose another folder.');
    }
    if (!targetStat.isDirectory()) {
      return refusal('That is a file, not a folder — choose a folder for your dictations.');
    }

    const ext = path.extname(resolvedTarget).toLowerCase();
    if (ext === '.json' || ext === '.ndjson' || ext === '.tmp') {
      return refusal('That looks like a file, not a folder — choose a folder for your dictations.');
    }

    const pointer = readPointer();
    const oldDir = pointer.dir;
    if (isInside(resolvedTarget, userDataDir) || isInside(resolvedTarget, oldDir)) {
      return refusal('Choose a folder outside the app data folder and outside the current one — otherwise the copy would sit inside the record it is replacing.');
    }
    // The reverse containment: the record must not end up above the pointer
    // and logs folder, where the "logs stay in app data" promise gets muddy.
    if (isInside(userDataDir, resolvedTarget)) {
      return refusal('Choose a folder that does not contain the app data folder — otherwise the record would mix with the app\'s own files.');
    }
    if (samePath(resolvedTarget, oldDir)) {
      return refusal('That is the folder your dictations are already in — choose a different folder.');
    }
    if (fs.existsSync(path.join(resolvedTarget, STORE_NAME))) {
      return refusal('That folder already contains a Dictata record — choose an empty folder so nothing is ever overwritten.');
    }

    // ── Prove it is writable before journalling anything ─────────────────────
    const probe = path.join(resolvedTarget, PROBE_NAME);
    try {
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
    } catch {
      return refusal('That folder is not writable — choose another folder.');
    }

    // ── Read what the move has to reproduce exactly ──────────────────────────
    const oldStoreFile = path.join(oldDir, STORE_NAME);
    const oldLedgerFile = path.join(oldDir, LEDGER_NAME);
    let bytes;
    let historyCount;
    try {
      bytes = fs.statSync(oldStoreFile).size;
      const parsed = JSON.parse(fs.readFileSync(oldStoreFile, 'utf8'));
      historyCount = Array.isArray(parsed.history) ? parsed.history.length : 0;
    } catch {
      return refusal('The current record could not be read — nothing was moved. Restart Dictata and try again.');
    }
    const ledgerLines = countLines(oldLedgerFile);

    // ── Journal → copy → verify → commit (one try: every failure is safe) ────
    const move = { from: oldDir, to: resolvedTarget, bytes, historyCount, ledgerLines };
    const created = [];
    try {
      // dir and pendingDelete are unchanged: the source is still authoritative.
      writePointer({ version: 1, dir: pointer.dir, pendingDelete: pointer.pendingDelete, move });

      fs.copyFileSync(oldStoreFile, path.join(resolvedTarget, STORE_NAME), fs.constants.COPYFILE_EXCL);
      created.push(STORE_NAME);
      if (fs.existsSync(oldLedgerFile)) {
        fs.copyFileSync(oldLedgerFile, path.join(resolvedTarget, LEDGER_NAME), fs.constants.COPYFILE_EXCL);
        created.push(LEDGER_NAME);
      }

      if (!verifyCopy(move)) throw new Error('copy did not read back');

      // The only write that moves authority.
      writePointer({ version: 1, dir: resolvedTarget, pendingDelete: [oldDir], move: null });
    } catch (e) {
      console.warn('[storage] move failed:', e.message);
      for (const name of created) {
        try {
          fs.rmSync(path.join(resolvedTarget, name), { force: true });
        } catch { /* the unverified target is disposable */ }
      }
      try {
        writePointer({ ...pointer, move: null });
      } catch { /* the pre-move pointer is what a retry needs; the source is intact */ }
      return refusal('The move could not be completed — your record is still in its original folder. Try again or choose another folder.');
    }

    // ── Delete the superseded copy, then clear the journal ───────────────────
    let deleted = true;
    if (!samePath(oldDir, readPointer().dir)) {
      for (const name of [STORE_NAME, LEDGER_NAME]) {
        try {
          fs.rmSync(path.join(oldDir, name), { force: true });
        } catch {
          deleted = false;   // keep pendingDelete so the next launch retries
        }
      }
    }
    try {
      writePointer({ version: 1, dir: resolvedTarget, pendingDelete: deleted ? [] : [oldDir], move: null });
    } catch { /* the commit is already durable; a leftover pendingDelete is retried */ }

    return { moved: true, dir: resolvedTarget, message: 'Dictations now save in the new folder.' };
  }

  return {
    userDataDir,
    pointerFile,
    defaultDir,
    readPointer,
    currentDir,
    resolveStoreDir,
    recoverMove,
    verifyCopy,
    moveTo,
    finishPendingDelete,
  };
}

module.exports = {
  createStorage,
  samePath,
  countLines,
  POINTER_NAME,
  STORE_NAME,
  LEDGER_NAME,
};
