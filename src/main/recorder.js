/**
 * recorder.js — Audio recorder (main-process side)
 *
 * Coordinates with the status-window renderer which owns the
 * getUserMedia + AudioWorklet. Main ↔ renderer via IPC:
 *   main → renderer: 'rec:start', 'rec:stop'
 *   renderer → main: 'rec:chunk' (Float32Array), 'rec:done'
 *
 * Encodes the final PCM buffer as a 16-bit 16 kHz mono WAV and
 * emits { wav: Buffer, durationMs: number } when done.
 */

const { EventEmitter } = require('events');
const { ipcMain } = require('electron');

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 640;   // 40 ms per worklet chunk

class Recorder extends EventEmitter {
  constructor() {
    super();
    this._statusWindow = null;
    this._chunks = [];          // Float32Array[]
    this._recording = false;
    this._registered = false;
    this._startedAt = 0;
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
      this.emit('error', new Error(msg));
    });
  }

  start() {
    if (this._recording) return;
    this._recording = true;
    this._chunks = [];
    this._startedAt = Date.now();
    this._statusWindow?.webContents.send('rec:start');
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
    this.emit('done', { wav, durationMs });
  }

  /** Cancel immediately without transcribing. */
  cancel() {
    if (!this._recording) return;
    clearTimeout(this._stopTimer);
    this._recording = false;
    this._chunks = [];
    this._statusWindow?.webContents.send('rec:cancel');
  }

  // ── WAV encoding ──────────────────────────────────────────────────────────

  _buildWav() {
    const totalSamples = this._chunks.reduce((s, c) => s + c.length, 0);
    const byteLen = totalSamples * 2;                    // 16-bit = 2 bytes/sample
    const buf = Buffer.allocUnsafe(44 + byteLen);

    // RIFF header
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + byteLen, 4);
    buf.write('WAVE', 8);
    // fmt chunk
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);           // chunk size
    buf.writeUInt16LE(1, 20);            // PCM
    buf.writeUInt16LE(1, 22);            // channels
    buf.writeUInt32LE(SAMPLE_RATE, 24);  // sample rate
    buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
    buf.writeUInt16LE(2, 32);            // block align
    buf.writeUInt16LE(16, 34);           // bits per sample
    // data chunk
    buf.write('data', 36);
    buf.writeUInt32LE(byteLen, 40);

    let offset = 44;
    for (const chunk of this._chunks) {
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, offset);
        offset += 2;
      }
    }
    return buf;
  }
}

module.exports = { Recorder };
