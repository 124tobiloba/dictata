// Unit tests for the SSE parser.
const test = require('node:test');
const assert = require('node:assert');
const { SseParser } = require('../src/main/sse');

test('parses complete data lines', () => {
  const p = new SseParser();
  const out = p.push('data: {"a":1}\ndata: {"b":2}\n');
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

test('buffers a line split across chunks', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: {"a"'), []);
  assert.deepEqual(p.push(':1}\n'), ['{"a":1}']);
});

test('ignores non-data lines and comments', () => {
  const p = new SseParser();
  const out = p.push('event: message\n: keep-alive\ndata: {"a":1}\n\n');
  assert.deepEqual(out, ['{"a":1}']);
});

test('ignores the [DONE] sentinel', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: [DONE]\n'), []);
});

test('flush returns the trailing payload without a newline', () => {
  const p = new SseParser();
  p.push('data: {"a":1}\ndata: {"b":2}');
  assert.deepEqual(p.flush(), ['{"b":2}']);
  assert.deepEqual(p.flush(), []);
});

test('handles CRLF line endings', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: {"a":1}\r\n'), ['{"a":1}']);
});
