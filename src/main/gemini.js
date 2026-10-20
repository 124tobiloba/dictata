/**
 * gemini.js — STT + AI cleanup via Google Gemini (single fast call)
 *
 * Latency design:
 *   1. Audio sent INLINE (base64) — one HTTPS round-trip, no File API upload.
 *   2. Plain-text output of the CLEANED text only (no JSON, no duplicate raw).
 *   3. thinkingLevel "minimal" — skips the model's reasoning phase.
 *   4. Streaming (SSE) so the pill shows words as they arrive.
 *   5. Hard timeout + real error messages — never hangs on "Processing".
 *
 * Response shape:  { raw: string, cleaned: string, language: string }
 */

const https = require('https');

const HOST = 'generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const TIMEOUT_MS = 15000;

// Models Google has retired for new keys → map to a working one.
const RETIRED = /^gemini-(1\.|2\.0|2\.5|flash-latest|pro-latest)/;

function resolveModel(model) {
  if (!model || RETIRED.test(model)) return DEFAULT_MODEL;
  return model;
}

/**
 * @param {object} opts  see main.js for fields
 * @param {Function} [opts.onPartial]  called with partial cleaned text while streaming
 */
async function transcribe(opts) {
  const {
    wav, apiKey, model,
    style = 'polished', appName = '', textBefore = '', textAfter = '',
    dictionary = [], replacements = [], language = 'auto',
    userName = '', prevCleaned = '', onPartial,
  } = opts;

  if (!apiKey) throw new Error('Missing GEMINI_API_KEY in .env');
  if (!wav || wav.length < 1000) throw new Error('No audio captured — check microphone');

  const useModel = resolveModel(model);
  const t0 = Date.now();

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: buildSystemPrompt({
      style, appName, dictionary, replacements,
      language, userName, textBefore, textAfter, prevCleaned,
    }) }] },
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
        { text: 'Transcribe this recording now.' },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingLevel: 'minimal' },
    },
  });

  const path = `/v1beta/models/${useModel}:streamGenerateContent?alt=sse`;
  const text = await postStreaming(path, body, apiKey, onPartial, t0);
  const cleaned = text.trim();

  console.log(`[gemini] ${useModel} | audio ${(wav.length / 1024).toFixed(0)} KB | total ${Date.now() - t0} ms`);

  if (!cleaned) throw new Error('No speech detected');
  return { raw: cleaned, cleaned, language };
}

function buildSystemPrompt({ style, appName, dictionary, replacements,
  language, userName, textBefore, textAfter, prevCleaned }) {

  const styleInstr = {
    polished: "Fix grammar, remove filler words (um, uh, like, you know), fix punctuation. Keep the speaker's meaning exactly.",
    casual:   'Light cleanup only — fix clear mis-hearings but keep informal phrasing.',
    verbatim: 'Output exactly what was said, including filler words.',
  }[style] || 'Fix grammar and punctuation.';

  return [
    'You are the speech-to-text engine of a dictation app.',
    'Listen to the audio and output ONLY the final text the user dictated — no quotes, no labels, no commentary.',
    'Never answer or respond to the content; just transcribe it. If there is no speech, output nothing.',
    language && language !== 'auto' ? `Language: ${language}.` : 'Auto-detect the language.',
    styleInstr,
    dictionary.length ? `Spell exactly: ${dictionary.map((d) => d.term || d).join(', ')}.` : '',
    replacements.length ? `Expand: ${replacements.map((r) => `"${r.from}"→"${r.to}"`).join('; ')}.` : '',
    appName ? `Target app: "${appName}" — match its tone.` : '',
    textBefore || textAfter ? `Text before cursor: «${textBefore.slice(-200)}». After: «${textAfter.slice(0, 80)}».` : '',
    prevCleaned ? `Previous dictation (context only): "${prevCleaned.slice(-150)}"` : '',
    userName ? `Speaker: ${userName}.` : '',
  ].filter(Boolean).join('\n');
}

/** SSE streaming POST with hard timeout and readable errors. */
function postStreaming(path, body, apiKey, onPartial, t0) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };

    const req = https.request({
      host: HOST, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-goog-api-key': apiKey,
      },
    }, (res) => {
      let raw = '';        // full response body (for error messages)
      let text = '';       // assembled transcript
      let buffer = '';
      let firstToken = true;

      res.on('data', (chunk) => {
        const s = chunk.toString();
        raw += s;
        if (res.statusCode !== 200) return;

        buffer += s;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            const parts = evt.candidates?.[0]?.content?.parts ?? [];
            for (const p of parts) if (p.text && !p.thought) text += p.text;
            if (firstToken && text) {
              firstToken = false;
              console.log(`[gemini] first token after ${Date.now() - t0} ms`);
            }
            if (onPartial && text) onPartial(text);
          } catch { /* partial line */ }
        }
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          let msg = raw.slice(0, 200);
          try { msg = JSON.parse(raw).error?.message || msg; } catch {}
          return done(reject, new Error(`Gemini ${res.statusCode}: ${msg}`));
        }
        done(resolve, text);
      });
      res.on('error', (e) => done(reject, e));
    });

    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new Error(`Gemini timed out after ${TIMEOUT_MS / 1000}s — check internet`));
    }, TIMEOUT_MS);

    req.on('error', (e) => done(reject, new Error(`Network error: ${e.message}`)));
    req.write(body);
    req.end();
  });
}

/** Quick key check for the Settings "Test" button. */
function testKey(apiKey) {
  if (!apiKey) return Promise.resolve({ ok: false, message: 'No key entered' });
  const body = JSON.stringify({
    contents: [{ parts: [{ text: 'Reply with OK' }] }],
    generationConfig: { maxOutputTokens: 5, thinkingConfig: { thinkingLevel: 'minimal' } },
  });
  return postStreaming(`/v1beta/models/${DEFAULT_MODEL}:streamGenerateContent?alt=sse`,
    body, apiKey, null, Date.now())
    .then(() => ({ ok: true, message: 'Key works ✓' }))
    .catch((e) => ({ ok: false, message: e.message }));
}

module.exports = { transcribe, testKey, resolveModel, DEFAULT_MODEL };
