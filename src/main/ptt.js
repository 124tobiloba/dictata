/**
 * ptt.js — push-to-talk / hands-free state machine (pure, no Electron).
 *
 * The hotkey layer used to toggle recording directly, which made the
 * double-tap-to-lock feature impossible: the second tap could only ever
 * *stop* the recording because the toggle had already been flipped.
 *
 * This module owns the interaction rules and returns explicit actions
 * that the app layer translates into recorder calls.
 *
 * Actions:
 *   'start'      — begin a normal (tap to toggle) recording
 *   'lock'       — convert the running recording into a hands-free lock
 *   'start-lock' — begin a recording already locked hands-free
 *   'stop'       — stop the recording
 *   'cancel'     — abort the recording
 */

const DEFAULT_DOUBLE_TAP_MS = 400;

class PttState {
  /**
   * @param {object} [opts]
   * @param {object} [opts.config]    live config, e.g. { doubleTapLocks: true }
   * @param {number} [opts.doubleTapMs]
   * @param {Function} [opts.now]      clock override (tests)
   */
  constructor(opts = {}) {
    this.config = opts.config || { doubleTapLocks: true };
    this.doubleTapMs = opts.doubleTapMs ?? DEFAULT_DOUBLE_TAP_MS;
    this.now = opts.now || (() => Date.now());
    this.reset();
  }

  reset() {
    this.active = false;      // recording started by a plain push-to-talk
    this.handsFree = false;   // recording locked hands-free
    this.lastTap = null;
  }

  get recording() { return this.active || this.handsFree; }

  /** Push-to-talk key pressed. */
  press() {
    const now = this.now();
    const isDoubleTap = this.config.doubleTapLocks &&
                        this.lastTap !== null &&
                        (now - this.lastTap) < this.doubleTapMs;
    this.lastTap = now;

    // Pressing PTT while locked hands-free stops and releases it.
    if (this.handsFree) {
      this.active = false;
      this.handsFree = false;
      return { action: 'stop', handsFree: false };
    }

    // Second tap in quick succession: keep recording, but release the
    // toggle so a later tap can stop it — i.e. hands-free lock.
    if (isDoubleTap) {
      if (this.active) {
        this.active = false;
        this.handsFree = true;
        return { action: 'lock', handsFree: true };
      }
      this.handsFree = true;
      return { action: 'start-lock', handsFree: true };
    }

    if (this.active) {
      this.active = false;
      return { action: 'stop', handsFree: false };
    }

    this.active = true;
    return { action: 'start', handsFree: false };
  }

  /** Dedicated hands-free key pressed (toggle). */
  toggleHandsFree() {
    if (this.handsFree) {
      this.active = false;
      this.handsFree = false;
      return { action: 'stop', handsFree: false };
    }
    this.active = false;
    this.handsFree = true;
    return { action: 'start-lock', handsFree: true };
  }

  /** Cancel key pressed. Returns null when nothing was running. */
  cancel() {
    if (!this.recording) return null;
    this.active = false;
    this.handsFree = false;
    return { action: 'cancel', handsFree: false };
  }
}

module.exports = { PttState, DEFAULT_DOUBLE_TAP_MS };
