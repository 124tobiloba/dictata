/**
 * recorderWorklet.js — AudioWorklet processor (renderer-side, 16 kHz mono)
 * Identical design to Wispr Flow's recorder-processor:
 *   chunkSize=640 samples = 40 ms at 16 kHz.
 * Posts each 40 ms Float32Array keyed by stream index.
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
          this.port.postMessage({ pcm: this.buffer.slice(0, this.bufferIndex).buffer });
          this.bufferIndex = 0;
        }
        this.port.postMessage('done');
      }
    };
  }

  process(inputs) {
    if (!this.recording) return true;
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this.buffer[this.bufferIndex++] = ch[i];
      if (this.bufferIndex >= this.chunkSize) {
        this.port.postMessage({ pcm: this.buffer.slice().buffer });
        this.bufferIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
