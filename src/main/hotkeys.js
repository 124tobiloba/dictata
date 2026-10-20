/**
 * hotkeys.js — Global shortcuts via Electron's built-in globalShortcut API
 *
 * No native add-ons needed. Uses Electron accelerator strings which work
 * system-wide even when the app window has no focus.
 *
 * The push-to-talk / hands-free interaction rules live in ./ptt.js (pure
 * and unit-tested); this module only translates key presses into actions.
 *
 * Actions emitted on 'action':
 *   'start' | 'lock' | 'start-lock' | 'stop' | 'cancel'
 */

const { globalShortcut } = require('electron');
const { EventEmitter } = require('events');
const { PttState, DEFAULT_DOUBLE_TAP_MS } = require('./ptt');

/**
 * Convert our simple chord format (['Ctrl','Shift','Space'])
 * to Electron accelerator string ('CommandOrControl+Shift+Space').
 */
function toAccelerator(chord) {
  if (!chord || chord.length === 0) return null;
  return chord
    .map((k) => {
      if (k === 'Ctrl' || k === 'Control') return 'CommandOrControl';
      if (k === 'Meta' || k === 'Win')     return 'Super';
      return k; // Shift, Alt, Space, F1..F12, Escape, etc.
    })
    .join('+');
}

class HotkeyService extends EventEmitter {
  constructor(store) {
    super();
    this._store = store;
    // Live config so a settings change takes effect without a restart.
    this._config = { doubleTapLocks: store.settings.doubleTapLocks };
    this._ptt = new PttState({ config: this._config, doubleTapMs: DEFAULT_DOUBLE_TAP_MS });
    this._registered = [];
  }

  start() {
    this._register();
  }

  stop() {
    globalShortcut.unregisterAll();
    this._registered = [];
  }

  _register() {
    // Unregister any previous bindings first
    globalShortcut.unregisterAll();
    this._registered = [];

    const s = this._store.settings.shortcuts;

    // ── Push-to-talk (toggle) ─────────────────────────────────────────────────
    this._try(s.pushToTalk, () => this._emit(this._ptt.press()));

    // ── Hands-free toggle ─────────────────────────────────────────────────────
    this._try(s.handsFree, () => this._emit(this._ptt.toggleHandsFree()));

    // ── Cancel ────────────────────────────────────────────────────────────────
    this._try(s.cancel, () => {
      const action = this._ptt.cancel();
      if (action) this._emit(action);
    });

    // ── Paste last ────────────────────────────────────────────────────────────
    this._try(s.pasteLast, () => {
      this.emit('paste-last');
    });
  }

  _emit(action) {
    this.emit('action', action);
  }

  _try(chord, handler) {
    const acc = toAccelerator(chord);
    if (!acc) return;
    try {
      const ok = globalShortcut.register(acc, handler);
      if (ok) {
        this._registered.push(acc);
      } else {
        console.warn(`[hotkeys] Could not register accelerator: ${acc} (already taken by another app?)`);
      }
    } catch (e) {
      console.warn(`[hotkeys] Error registering ${acc}:`, e.message);
    }
  }

  /** Call after settings change to re-register with new chords. */
  reload() {
    this._config.doubleTapLocks = !!this._store.settings.doubleTapLocks;
    this._register();
  }

  /** Forget any in-flight interaction state (e.g. after an error). */
  reset() {
    this._ptt.reset();
  }
}

module.exports = { HotkeyService, toAccelerator };
