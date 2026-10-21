// Persistent settings, dictionary and transcript history (JSON in userData).
//
// The Gemini API key is stored encrypted (Electron safeStorage → DPAPI on
// Windows) instead of as plain text. Older files that stored it in the
// clear are still readable and get re-encrypted on the next save.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

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
  },
  dictionary: [],               // [{ term, note? }]
  replacements: [],             // [{ from, to }]
  history: [],                  // newest first
  stats: { words: 0, sessions: 0, msSpoken: 0 },
};

const HISTORY_LIMIT = 500;
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
    stats: { ...DEFAULTS.stats, ...(src.stats || {}) },
  };
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'voice-flow.json');
    this.data = this._load();
    this._decrypted = false;
    this._writeTimer = null;
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
    this._ensureDecrypted();
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => {
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
    }, 150);
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
    this.data.settings = next;
    this._save();
    return next;
  }

  setDictionary(list) { this.data.dictionary = list; this._save(); }
  setReplacements(list) { this.data.replacements = list; this._save(); }

  addHistory(entry) {
    this.data.history.unshift(entry);
    if (this.data.history.length > HISTORY_LIMIT) this.data.history.length = HISTORY_LIMIT;
    const words = (entry.cleaned || '').trim().split(/\s+/).filter(Boolean).length;
    this.data.stats.words += words;
    this.data.stats.sessions += 1;
    this.data.stats.msSpoken += entry.durationMs || 0;
    this._save();
  }

  deleteHistory(id) {
    this.data.history = this.data.history.filter((h) => h.id !== id);
    this._save();
  }

  clearHistory() { this.data.history = []; this._save(); }

  snapshot() {
    this._ensureDecrypted();
    return structuredClone(this.data);
  }
}

module.exports = { Store, DEFAULTS, mergeDefaults, encryptSecret, decryptSecret };
