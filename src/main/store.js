// Persistent settings, dictionary and transcript history (JSON in userData).
//
// The Gemini API key is stored encrypted (Electron safeStorage → DPAPI on
// Windows) instead of as plain text. Older files that stored it in the
// clear are still readable and get re-encrypted on the next save.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { computeStats } = require('./analytics');
const { normalizeRetentionDays } = require('./retention');

const DEFAULTS = {
  settings: {
    // Shortcut chords use Electron accelerator key names (see hotkeys.js).
    shortcuts: {
      pushToTalk: ['Alt', 'Shift', 'D'],   // D = Dictate — press to talk
      handsFree:  ['Alt', 'Shift', 'F'],   // F = Free — toggle hands-free lock
      cancel:     ['Alt', 'Shift', 'C'],   // C = Cancel — abort current recording
      pasteLast:  ['Alt', 'Shift', 'V'],   // V = Voice-paste — re-paste last text
    },
    doubleTapLocks: true,       // double-tap push-to-talk => hands-free
    model: 'gemini-2.5-flash',
    style: 'polished',          // polished | casual | verbatim
    appAwareStyle: true,        // adapt tone to the focused app
    language: 'auto',
    sounds: true,
    restoreClipboard: true,
    pasteMethod: 'ctrl-v',      // ctrl-v | shift-insert
    userName: '',
    microphoneId: 'default',
    apiKey: '',                 // Gemini key, entered once in Settings
    launchAtLogin: true,        // start with Windows
    maxRecordingSec: 300,       // hard cap per dictation (seconds)
    dashboardEnabled: true,     // local web dashboard on http://127.0.0.1
    dashboardPort: 7788,
    retentionDays: 0,           // 0 = keep forever (the upgrade default)
  },
  dictionary: [],               // [{ term, note? }]
  replacements: [],             // [{ from, to }]
  history: [],                  // newest first
  events: [],                   // persisted activity log (newest first)
  // Access token for the local dashboard. It is stable across restarts so
  // that a bookmarked dashboard URL keeps working.
  dashboardToken: '',
  stats: { words: 0, sessions: 0, msSpoken: 0 },
};

const HISTORY_LIMIT = 500;
const EVENT_LIMIT = 500;
const SECRET_PREFIX = 'enc:';

/** Encrypt a secret for storage. Falls back to plain text if unavailable. */
function encryptSecret(plain) {
  if (!plain) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return SECRET_PREFIX + safeStorage.encryptString(plain).toString('base64');
    }
  } catch (e) {
    console.warn('[store] safeStorage unavailable:', e.message);
  }
  return plain;
}

/** Decrypt a stored secret. Plain-text values are returned unchanged. */
function decryptSecret(stored) {
  if (!stored) return '';
  if (!stored.startsWith(SECRET_PREFIX)) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(SECRET_PREFIX.length), 'base64'));
  } catch (e) {
    console.warn('[store] could not decrypt the API key:', e.message);
    return '';
  }
}

/** Merge a stored file over the defaults. Pure — unit-tested. */
function mergeDefaults(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    ...DEFAULTS,
    ...src,
    settings: {
      ...DEFAULTS.settings,
      ...(src.settings || {}),
      shortcuts: { ...DEFAULTS.settings.shortcuts, ...((src.settings || {}).shortcuts || {}) },
    },
    dictionary: src.dictionary || [],
    replacements: src.replacements || [],
    history: src.history || [],
    events: src.events || [],
    dashboardToken: src.dashboardToken || '',
    stats: { ...DEFAULTS.stats, ...(src.stats || {}) },
  };
}

/**
 * Remove one id from both stored collections. Pure — unit-tested.
 *
 * `removed` counts rows across both arrays because a dictation appears in
 * `history` and (via the bus) in `events`, while a failed attempt only ever
 * exists as an event. Stats are recomputed from the survivors, never
 * subtracted, so the cap and a delete cannot make the totals drift.
 *
 * @param {object} data  a store document
 * @param {string} id
 * @returns {{removed: number, wasLast: boolean, ids: string[]}}
 */
function purgeEntryData(data, id) {
  const history = Array.isArray(data.history) ? data.history : [];
  const events = Array.isArray(data.events) ? data.events : [];
  const wasLast = history.length > 0 && history[0]?.id === id;

  const ids = [];
  const remainingHistory = history.filter((h) => {
    if (!h || h.id !== id) return true;
    ids.push(h.id);
    return false;
  });
  const remainingEvents = events.filter((e) => {
    if (!e || e.id !== id) return true;
    if (!ids.includes(e.id)) ids.push(e.id);
    return false;
  });

  data.history = remainingHistory;
  data.events = remainingEvents;
  data.stats = computeStats(remainingHistory);

  return { removed: (history.length - remainingHistory.length) + (events.length - remainingEvents.length), wasLast, ids };
}

/**
 * Empty the transcript record only. Never rebuilds the document from the
 * defaults: settings, the API key, dictionary, replacements and the dashboard
 * token must survive a clear. Pure — unit-tested.
 *
 * @param {object} data  a store document
 * @returns {number}  how many history rows were removed
 */
/**
 * Empty the transcript record only. Never rebuilds the document from the
 * defaults: settings, the API key, dictionary, replacements and the dashboard
 * token must survive a clear. Pure — unit-tested.
 *
 * @param {object} data  a store document
 * @returns {number}  how many history rows were removed
 */
function clearAllData(data) {
  const removed = Array.isArray(data.history) ? data.history.length : 0;
  data.history = [];
  data.events = [];
  data.stats = { words: 0, sessions: 0, msSpoken: 0 };
  return removed;
}

/**
 * Drop the history rows a retention sweep has already classified as expired.
 * Pure — unit-tested.
 *
 * Stats are recomputed from the survivors with the same `computeStats` rule
 * plan 01 established, so an expiry cannot make the counters drift. Persisted
 * events are pruned separately by `pruneEventsData`: they carry their own
 * timestamps and a failed attempt has no history row at all.
 *
 * @param {object} data  a store document
 * @param {string[]} ids  expired history ids
 * @returns {number}  how many history rows were removed
 */
function purgeExpiredData(data, ids) {
  const expired = new Set(ids || []);
  const history = Array.isArray(data.history) ? data.history : [];
  const remaining = history.filter((h) => !h || !expired.has(h.id));

  data.history = remaining;
  data.stats = computeStats(remaining);

  return history.length - remaining.length;
}

/**
 * Drop persisted events older than the retention cutoff and re-apply the
 * event cap. Pure — unit-tested.
 *
 * The cap re-apply is deliberate: the durable list is the only place the cap
 * is enforced for rows written before this version, so a sweep keeps it honest
 * even when nothing has expired yet.
 *
 * @param {object} data  a store document
 * @param {number} cutoff
 * @returns {number}  how many events were removed
 */
function pruneEventsData(data, cutoff) {
  const events = Array.isArray(data.events) ? data.events : [];
  const kept = events.filter((e) => e && (e.ts || 0) >= cutoff);
  data.events = kept.slice(0, EVENT_LIMIT);
  return events.length - data.events.length;
}

class Store {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dir]          directory holding dictata.json
   * @param {string} [opts.file]         full path override (tests)
   * @param {string} [opts.userDataDir]  where the pre-rename file lives
   */
  constructor(opts = {}) {
    this.dir = opts.dir || app.getPath('userData');
    this.file = opts.file || path.join(this.dir, 'dictata.json');
    // The legacy adoption is anchored at userData, never in a moved
    // directory. A test store passes `dir`, so there is no legacy file to
    // adopt and — importantly — no Electron `app` to ask.
    const legacyDir = opts.userDataDir || (opts.dir ? null : this.dir);
    try {
      if (legacyDir) {
        const legacy = path.join(legacyDir, 'voice-flow.json');
        if (!fs.existsSync(this.file) && fs.existsSync(legacy)) fs.copyFileSync(legacy, this.file);
      }
    } catch { /* start fresh rather than crash */ }
    this.data = this._load();
    this._decrypted = false;
    this._writeTimer = null;
    this._recomputeStats();
  }

  _load() {
    try {
      return mergeDefaults(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return mergeDefaults(null);
    }
  }

  _ensureDecrypted() {
    if (this._decrypted) return;
    this._decrypted = true;
    try {
      this.data.settings.apiKey = decryptSecret(this.data.settings.apiKey || '');
    } catch (e) {
      console.warn('[store]', e.message);
    }
  }

  _save() {
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => this._writeNow(), 150);
  }

  /**
   * Write the record now. Destructive mutations call this through `flush()`
   * so a quit inside the save debounce cannot bring a deleted row back.
   *
   * `_ensureDecrypted()` runs first because a flush can be the first thing
   * that touches the store after construction — encrypting an already
   * encrypted key would make it undecryptable on the next launch.
   */
  _writeNow() {
    this._ensureDecrypted();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const settings = { ...this.data.settings };
      settings.apiKey = encryptSecret(settings.apiKey || '');
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...this.data, settings }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] save failed:', e.message);
    }
  }

  /** Cancel the pending debounce and write the file immediately. */
  flush() {
    clearTimeout(this._writeTimer);
    this._writeTimer = null;
    this._writeNow();
  }

  /** Stats always describe the rows that are still in the record. */
  _recomputeStats() {
    this.data.stats = computeStats(this.data.history || []);
  }

  get settings() {
    this._ensureDecrypted();
    return this.data.settings;
  }

  updateSettings(patch) {
    const next = { ...this.settings, ...patch };
    if (patch.shortcuts) next.shortcuts = { ...this.settings.shortcuts, ...patch.shortcuts };
    if ('maxRecordingSec' in patch) {
      next.maxRecordingSec = Math.min(1800, Math.max(15, Number(patch.maxRecordingSec) || DEFAULTS.settings.maxRecordingSec));
    }
    if ('retentionDays' in patch) {
      next.retentionDays = normalizeRetentionDays(patch.retentionDays);
    }
    this.data.settings = next;
    this._save();
    return next;
  }

  setDictionary(list) { this.data.dictionary = list; this._save(); }
  setReplacements(list) { this.data.replacements = list; this._save(); }

  /**
   * The dashboard access token. It is created once and then kept, so the
   * dashboard URL survives an app restart — a rotating token silently
   * breaks every open browser tab.
   */
  getOrCreateToken() {
    if (this.data.dashboardToken) return this.data.dashboardToken;
    this.data.dashboardToken = crypto.randomBytes(16).toString('hex');
    this._save();
    return this.data.dashboardToken;
  }

  /** Persist an activity event (dictations, errors, info). */
  addEvent(entry) {
    this.data.events.unshift(entry);
    if (this.data.events.length > EVENT_LIMIT) this.data.events.length = EVENT_LIMIT;
    this._save();
  }

  addHistory(entry) {
    this.data.history.unshift(entry);
    if (this.data.history.length > HISTORY_LIMIT) this.data.history.length = HISTORY_LIMIT;
    this._recomputeStats();
    this._save();
  }

  /**
   * Delete one dictation or failed attempt. Writes the file before returning
   * so a quit straight after the click cannot resurrect the row.
   *
   * @param {string} id
   * @returns {{removed: number, wasLast: boolean, ids: string[]}}
   */
  purgeEntry(id) {
    const result = purgeEntryData(this.data, id);
    this.flush();
    return result;
  }

  /**
   * Delete every dictation and failed attempt, keeping settings and the
   * dashboard token. Writes the file before returning.
   *
   * @returns {number}  how many history rows were removed
   */
  clearAll() {
    const removed = clearAllData(this.data);
    this.flush();
    return removed;
  }

  /**
   * Remove history rows a retention sweep marked as expired. Writes the file
   * before returning, exactly like a delete: a quit straight after the sweep
   * cannot resurrect an expired row.
   *
   * @param {string[]} ids
   * @returns {number}  how many rows were removed
   */
  purgeExpired(ids) {
    const removed = purgeExpiredData(this.data, ids);
    this.flush();
    return removed;
  }

  /**
   * Remove persisted events older than the cutoff and re-apply the event cap.
   *
   * @param {number} cutoff
   * @returns {number}  how many events were removed
   */
  pruneEvents(cutoff) {
    const removed = pruneEventsData(this.data, cutoff);
    this.flush();
    return removed;
  }

  snapshot() {
    this._ensureDecrypted();
    return structuredClone(this.data);
  }
}

module.exports = {
  Store,
  DEFAULTS,
  mergeDefaults,
  encryptSecret,
  decryptSecret,
  purgeEntryData,
  clearAllData,
  purgeExpiredData,
  pruneEventsData,
};
