/**
 * hotkeys.js — Global shortcuts via Electron's built-in globalShortcut API
 *
 * No native add-ons needed. Uses Electron accelerator strings which work
 * system-wide even when the app window has no focus.
 *
 * PTT behaviour (toggle mode, like Wispr's "click to talk"):
 *   • First press of pushToTalk → emit 'ptt-start'
 *   • Second press of pushToTalk → emit 'ptt-stop'
 *   • Press pushToTalk twice within 400 ms (double-tap) → emit 'handsfree', true
 *
 * Hands-free is also available as a dedicated shortcut.
 * Cancel (Escape) aborts the current recording.
 * pasteLast re-pastes the previous transcript.
 */

const { globalShortcut } = require('electron');
const { EventEmitter } = require('events');

const DOUBLE_TAP_MS = 400;

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
    this._pttActive = false;
    this._lastPttTap = 0;
    this._handsFreeActive = false;
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
    this._try(s.pushToTalk, () => {
      const now = Date.now();
      const doubleTap = this._store.settings.doubleTapLocks &&
                        (now - this._lastPttTap) < DOUBLE_TAP_MS;
      this._lastPttTap = now;

      if (doubleTap && !this._pttActive) {
        this._handsFreeActive = true;
        this.emit('handsfree', true);
        return;
      }

      if (!this._pttActive) {
        this._pttActive = true;
        this.emit('ptt-start');
      } else {
        this._pttActive = false;
        this.emit('ptt-stop');
      }
    });

    // ── Hands-free toggle ─────────────────────────────────────────────────────
    this._try(s.handsFree, () => {
      this._handsFreeActive = !this._handsFreeActive;
      if (this._handsFreeActive && !this._pttActive) {
        this._pttActive = true;
        this.emit('ptt-start');
      } else if (!this._handsFreeActive && this._pttActive) {
        this._pttActive = false;
        this.emit('ptt-stop');
      }
      this.emit('handsfree', this._handsFreeActive);
    });

    // ── Cancel ────────────────────────────────────────────────────────────────
    this._try(s.cancel, () => {
      if (this._pttActive) {
        this._pttActive = false;
        this._handsFreeActive = false;
        this.emit('cancel');
      }
    });

    // ── Paste last ────────────────────────────────────────────────────────────
    this._try(s.pasteLast, () => {
      this.emit('paste-last');
    });
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
    this._register();
  }

  endHandsFree() {
    this._handsFreeActive = false;
    this._pttActive = false;
    this.emit('handsfree', false);
  }

  setHandsFree(v) {
    this._handsFreeActive = v;
  }
}

module.exports = { HotkeyService };
