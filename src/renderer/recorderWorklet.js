/**
 * recorderWorklet.js — AudioWorklet processor (renderer-side, 16 kHz mono)
 * Posts each 40 ms Float32Array together with the RMS of the chunk, so the
 * dashboard can animate with the real voice level.
 * Posts "done" on stop.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.recording = false;
    this.chunkSize = 640;
    this.buffer = new Float32Array(this.chunkSize);
    this.bufferIndex = 0;

    this.port.onmessage = (e) => {
      if (e.data === 'start') {
        this.bufferIndex = 0;
        this.recording = true;
      } else if (e.data === 'stop') {
        this.recording = false;
        if (this.bufferIndex > 0) {
          this.port.postMessage({
            pcm: this.buffer.slice(0, this.bufferIndex).buffer,
            level: this._rms(this.buffer, 0, this.bufferIndex),
          });
          this.bufferIndex = 0;
        }
        this.port.postMessage('done');
      }
    };
  }

  /** Root mean square of a slice — the loudness of the chunk. */
  _rms(buffer, from, to) {
    let sum = 0;
    for (let i = from; i < to; i++) sum += buffer[i] * buffer[i];
    const n = to - from;
    return n > 0 ? Math.sqrt(sum / n) : 0;
  }

  process(inputs) {
    if (!this.recording) return true;
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this.buffer[this.bufferIndex++] = ch[i];
      if (this.bufferIndex >= this.chunkSize) {
        this.port.postMessage({
          pcm: this.buffer.slice().buffer,
          level: this._rms(this.buffer, 0, this.bufferIndex),
        });
        this.bufferIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
