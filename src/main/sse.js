/**
 * sse.js — minimal Server-Sent Events parser (pure, no Electron).
 *
 * Gemini's :streamGenerateContent?alt=sse endpoint emits one
 * `data: {json}` line per chunk. The parser buffers partial lines
 * across network chunks and returns the complete payloads.
 */

class SseParser {
  constructor() {
    this.buffer = '';
  }

  /**
   * Feed a chunk of text, get back the complete `data:` payloads it contains.
   * @param {string} text
   * @returns {string[]} raw JSON payloads (without the `data:` prefix)
   */
  push(text) {
    this.buffer += text;
    const out = [];
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';        // keep the incomplete tail
    for (const line of lines) {
      const payload = this._extract(line);
      if (payload !== null) out.push(payload);
    }
    return out;
  }

  /** Return whatever is left in the buffer (used when the stream ends). */
  flush() {
    const rest = this.buffer;
    this.buffer = '';
    const payload = this._extract(rest.replace(/\r$/, ''));
    return payload === null ? [] : [payload];
  }

  _extract(line) {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.startsWith('data:')) return null;
    const payload = trimmed.slice(5).trimStart();
    if (payload === '' || payload === '[DONE]') return null;
    return payload;
  }
}

module.exports = { SseParser };
