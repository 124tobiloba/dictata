// Persistent settings, dictionary and transcript history (JSON in userData).
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  settings: {
    // Shortcut chords use normalized uiohook key names (see hotkeys.js).
    shortcuts: {
      pushToTalk: ['Alt', 'Shift', 'D'],   // D = Dictate — hold/press to talk
      handsFree:  ['Alt', 'Shift', 'F'],   // F = Free — toggle hands-free lock
      cancel:     ['Alt', 'Shift', 'C'],   // C = Cancel — abort current recording
      pasteLast:  ['Alt', 'Shift', 'V'],   // V = Voice-paste — re-paste last text
    },
    doubleTapLocks: true,       // double-tap push-to-talk => hands-free
    model: 'gemini-3.5-flash-lite',
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
  },
  dictionary: [],               // [{ term, note? }]
  replacements: [],             // [{ from, to }]
  history: [],                  // newest first
  stats: { words: 0, sessions: 0, msSpoken: 0 },
};

const HISTORY_LIMIT = 500;

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'voice-flow.json');
    this.data = this._load();
    this._writeTimer = null;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        ...DEFAULTS,
        ...raw,
        settings: {
          ...DEFAULTS.settings,
          ...(raw.settings || {}),
          shortcuts: { ...DEFAULTS.settings.shortcuts, ...((raw.settings || {}).shortcuts || {}) },
        },
        stats: { ...DEFAULTS.stats, ...(raw.stats || {}) },
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  _save() {
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    }, 150);
  }

  get settings() { return this.data.settings; }

  updateSettings(patch) {
    const next = { ...this.data.settings, ...patch };
    if (patch.shortcuts) next.shortcuts = { ...this.data.settings.shortcuts, ...patch.shortcuts };
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

  snapshot() { return structuredClone(this.data); }
}

module.exports = { Store, DEFAULTS };
