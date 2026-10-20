// Unit tests for the WAV encoder.
const test = require('node:test');
const assert = require('node:assert');
const { encodeWav, HEADER_BYTES } = require('../src/main/wav');

const RATE = 16000;

test('writes a valid RIFF/WAVE header', () => {
  const wav = encodeWav([new Float32Array(100)], RATE);
  assert.equal(wav.length, HEADER_BYTES + 200);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(4), 36 + 200);       // RIFF chunk size
  assert.equal(wav.readUInt32LE(16), 16);            // fmt chunk size
  assert.equal(wav.readUInt16LE(20), 1);             // PCM
  assert.equal(wav.readUInt16LE(22), 1);             // mono
  assert.equal(wav.readUInt32LE(24), RATE);          // sample rate
  assert.equal(wav.readUInt32LE(28), RATE * 2);      // byte rate
  assert.equal(wav.readUInt16LE(32), 2);             // block align
  assert.equal(wav.readUInt16LE(34), 16);            // bits per sample
  assert.equal(wav.readUInt32LE(40), 200);           // data chunk size
});

test('converts float samples to 16-bit PCM', () => {
  const samples = new Float32Array([0, 1, -1, 0.5]);
  const wav = encodeWav([samples], RATE);
  assert.equal(wav.readInt16LE(44), 0);
  assert.equal(wav.readInt16LE(46), 0x7fff);
  assert.equal(wav.readInt16LE(48), -0x8000);
  assert.equal(wav.readInt16LE(50), Math.round(0.5 * 0x7fff));
});

test('clamps out-of-range samples', () => {
  const wav = encodeWav([new Float32Array([2, -2])], RATE);
  assert.equal(wav.readInt16LE(44), 0x7fff);
  assert.equal(wav.readInt16LE(46), -0x8000);
});

test('joins multiple chunks in order', () => {
  const wav = encodeWav([new Float32Array([0.1]), new Float32Array([0.2])], RATE);
  assert.equal(wav.length, HEADER_BYTES + 4);
  assert.equal(wav.readInt16LE(44), Math.round(0.1 * 0x7fff));
  assert.equal(wav.readInt16LE(46), Math.round(0.2 * 0x7fff));
});

test('handles an empty recording', () => {
  const wav = encodeWav([], RATE);
  assert.equal(wav.length, HEADER_BYTES);
  assert.equal(wav.readUInt32LE(40), 0);
});
