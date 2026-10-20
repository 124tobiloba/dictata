/**
 * wav.js — WAV encoding (pure, no Electron) so it can be unit-tested.
 *
 * Encodes Float32 PCM samples as a 16-bit PCM mono RIFF/WAVE buffer.
 */

const HEADER_BYTES = 44;

/**
 * @param {Float32Array[]} chunks  Float32 PCM, one array per captured chunk
 * @param {number} sampleRate       samples per second
 * @returns {Buffer} a complete .wav file
 */
function encodeWav(chunks, sampleRate) {
  const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
  const byteLen = totalSamples * 2;                 // 16-bit = 2 bytes/sample
  const buf = Buffer.allocUnsafe(HEADER_BYTES + byteLen);

  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + byteLen, 4);
  buf.write('WAVE', 8);
  // fmt chunk
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);                        // chunk size
  buf.writeUInt16LE(1, 20);                         // PCM
  buf.writeUInt16LE(1, 22);                         // channels
  buf.writeUInt32LE(sampleRate, 24);                // sample rate
  buf.writeUInt32LE(sampleRate * 2, 28);            // byte rate
  buf.writeUInt16LE(2, 32);                         // block align
  buf.writeUInt16LE(16, 34);                        // bits per sample
  // data chunk
  buf.write('data', 36);
  buf.writeUInt32LE(byteLen, 40);

  let offset = HEADER_BYTES;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      // Round (not truncate) so the quantisation error stays symmetric.
      buf.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), offset);
      offset += 2;
    }
  }
  return buf;
}

module.exports = { encodeWav, HEADER_BYTES };
