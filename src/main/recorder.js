/**
 * recorder.js — Audio recorder (main-process side)
 *
 * Coordinates with the status-window renderer which owns the
 * getUserMedia + AudioWorklet. Main ↔ renderer via IPC:
 *   main → renderer: 'rec:start', 'rec:stop'
 *   renderer → main: 'rec:chunk' (Float32Array), 'rec:done'
 *
 * Encodes the final PCM buffer as a 16-bit 16 kHz mono WAV and
 * emits { wav: Buffer, durationMs: number, timedOut: boolean } when done.
 */

const { EventEmitter } = require('events');
const { ipcMain } = require('electron');
const { encodeWav } = require('./wav');

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 640;   // 40 ms per worklet chunk
const DEFAULT_MAX_MS = 5 * 60 * 1000;   // hard cap on one dictation

class Recorder extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._statusWindow = null;
    this._chunks = [];          // Float32Array[]
    this._recording = false;
    this._registered = false;
    this._startedAt = 0;
    this._timedOut = false;
    this._maxTimer = null;
    this.maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  }

  /** Called once the status window is created. */
  attach(statusWindow) {
    this._statusWindow = statusWindow;
    if (this._registered) return;
    this._registered = true;

    ipcMain.on('rec:chunk', (_e, transferable) => {
      if (!this._recording) return;
      // renderer sends the raw ArrayBuffer of a Float32Array
      this._chunks.push(new Float32Array(transferable));
    });

    ipcMain.on('rec:done', () => this._finish('renderer'));

    ipcMain.on('rec:error', (_e, msg) => {
      this._recording = false;
      this._chunks = [];
      clearTimeout(this._maxTimer);
      this.emit('error', new Error(msg));
    });
  }

  setMaxMs(ms) {
    this.maxMs = Number(ms) > 0 ? Number(ms) : DEFAULT_MAX_MS;
  }

  start() {
    if (this._recording) return;
    this._recording = true;
    this._chunks = [];
    this._timedOut = false;
    this._startedAt = Date.now();
    this._statusWindow?.webContents.send('rec:start');

    // Hard cap: a dictation can never grow without bound. Past this the
    // audio would exceed what the model accepts in a single request.
    clearTimeout(this._maxTimer);
    this._maxTimer = setTimeout(() => {
      if (!this._recording) return;
      this._timedOut = true;
      console.warn(`[recorder] max length reached (${this.maxMs} ms) — stopping`);
      this.stop();
    }, this.maxMs);
  }

  stop() {
    if (!this._recording) return;
    this._statusWindow?.webContents.send('rec:stop');
    // 'rec:done' normally arrives in a few ms; never wait forever.
    clearTimeout(this._stopTimer);
    this._stopTimer = setTimeout(() => this._finish('watchdog'), 1500);
  }

  _finish(source) {
    clearTimeout(this._stopTimer);
    clearTimeout(this._maxTimer);
    if (!this._recording) return;
    this._recording = false;
    const durationMs = Date.now() - this._startedAt;
    const samples = this._chunks.reduce((s, c) => s + c.length, 0);
    console.log(`[recorder] finished via ${source}: ${this._chunks.length} chunks, ${(samples / SAMPLE_RATE).toFixed(1)}s audio`);
    if (samples < SAMPLE_RATE * 0.3) {
      this._chunks = [];
      this.emit('error', new Error(samples === 0
        ? 'No audio from microphone — check Windows mic permission'
        : 'Recording too short'));
      return;
    }
    const wav = this._buildWav();
    this._chunks = [];
    this.emit('done', { wav, durationMs, timedOut: this._timedOut });
  }

  /** Cancel immediately without transcribing. */
  cancel() {
    if (!this._recording) return;
    clearTimeout(this._stopTimer);
    clearTimeout(this._maxTimer);
    this._recording = false;
    this._chunks = [];
    this._statusWindow?.webContents.send('rec:cancel');
  }

  // ── WAV encoding ──────────────────────────────────────────────────────────

  _buildWav() {
    return encodeWav(this._chunks, SAMPLE_RATE);
  }
}

module.exports = { Recorder, SAMPLE_RATE, DEFAULT_MAX_MS };
