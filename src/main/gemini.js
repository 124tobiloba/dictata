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
 * Response shape:  { raw: string, cleaned: string, language: string, truncated: boolean }
 */

const https = require('https');
const { SseParser } = require('./sse');

const HOST = 'generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-3.5-flash';
// Tried in order when the preferred model fails (timeout / 5xx / 429).
// The "-lite" tier is noticeably faster but is often at capacity and can
// hang without ever answering — the chain guarantees a result.
const FALLBACK_MODELS = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-2.5-flash'];
const TIMEOUT_MS = 15000;        // per request
const TOTAL_BUDGET_MS = 28000;  // for the whole model chain
const MAX_OUTPUT_TOKENS = 4096;

// Models Google has retired for new keys → map to a working one.
const RETIRED = /^gemini-(1\.[0-9]|2\.0|pro-vision)/;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function resolveModel(model) {
  if (!model || RETIRED.test(model)) return DEFAULT_MODEL;
  return model;
}

/**
 * @param {object} opts  see main.js for fields
 * @param {Function} [opts.onPartial]  called with partial cleaned text while streaming
 * @param {AbortSignal} [opts.signal]  aborts the request (e.g. user pressed Cancel)
 */
async function transcribe(opts) {
  const {
    wav, apiKey, model,
    style = 'polished', appName = '', textBefore = '', textAfter = '',
    dictionary = [], replacements = [], language = 'auto',
    userName = '', prevCleaned = '', onPartial, signal,
  } = opts;

  if (!apiKey) throw new Error('Missing Gemini API key — add it in Settings');
  if (!wav || wav.length < 1000) throw new Error('No audio captured — check microphone');

  const useModel = resolveModel(model);
  const t0 = Date.now();

  const buildBody = () => JSON.stringify({
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
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingLevel: 'minimal' },
    },
  });

  // Try the preferred model first, then walk down the fallback chain.
  const chain = [useModel, ...FALLBACK_MODELS.filter((m) => m !== useModel)];
  let result = null;
  let lastErr = null;

  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    const remaining = TOTAL_BUDGET_MS - (Date.now() - t0);
    if (i > 0 && remaining < 4000) break;      // no time left for another try
    const timeout = Math.max(4000, Math.min(TIMEOUT_MS, remaining));

    try {
      const body = buildBody();
      const path = `/v1beta/models/${candidate}:streamGenerateContent?alt=sse`;
      result = await postStreaming(path, body, apiKey, onPartial, t0, signal, timeout);
      if (candidate !== useModel) {
        console.warn(`[gemini] ${useModel} failed (${lastErr?.message}) — ${candidate} answered instead`);
      }
      break;
    } catch (err) {
      lastErr = err;
      if (err?.message === 'Cancelled') throw err;
      if (!isRetryable(err)) throw err;        // 400 / 401 / 403 → fail fast
      console.warn(`[gemini] ${candidate}: ${err.message}`);
    }
  }

  if (!result) throw lastErr || new Error('Gemini request failed');

  const cleaned = result.text.trim();
  console.log(`[gemini] ${useModel} | audio ${(wav.length / 1024).toFixed(0)} KB | total ${Date.now() - t0} ms`);

  if (!cleaned) throw new Error('No speech detected');
  if (result.truncated) {
    console.warn('[gemini] response hit the token limit — transcript may be cut off');
  }
  return { raw: cleaned, cleaned, language, truncated: !!result.truncated };
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
function postStreaming(path, body, apiKey, onPartial, t0, signal, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };

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
      let truncated = false;
      let firstToken = true;
      const parser = new SseParser();

      res.on('data', (chunk) => {
        const s = chunk.toString();
        if (res.statusCode !== 200) { raw += s; return; }

        for (const payload of parser.push(s)) {
          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }

          if (evt.promptFeedback?.blockReason) {
            return done(reject, new Error(`Blocked by Gemini: ${evt.promptFeedback.blockReason}`));
          }
          const cand = evt.candidates?.[0];
          if (cand?.finishReason === 'MAX_TOKENS') truncated = true;

          const parts = cand?.content?.parts ?? [];
          for (const p of parts) if (p.text && !p.thought) text += p.text;

          if (firstToken && text) {
            firstToken = false;
            console.log(`[gemini] first token after ${Date.now() - t0} ms`);
          }
          if (onPartial && text) onPartial(text);
        }
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          let msg = raw.slice(0, 200);
          try { msg = JSON.parse(raw).error?.message || msg; } catch {}
          const err = new Error(`Gemini ${res.statusCode}: ${msg}`);
          err.status = res.statusCode;
          return done(reject, err);
        }
        // A final partial line may still be buffered.
        for (const payload of parser.flush()) {
          try {
            const evt = JSON.parse(payload);
            const parts = evt.candidates?.[0]?.content?.parts ?? [];
            for (const p of parts) if (p.text && !p.thought) text += p.text;
          } catch { /* ignore trailing garbage */ }
        }
        done(resolve, { text, truncated });
      });
      res.on('error', (e) => done(reject, e));
    });

    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new Error(`Gemini timed out after ${Math.round(timeoutMs / 1000)}s — check internet`));
    }, timeoutMs);

    function onAbort() {
      req.destroy();
      done(reject, new Error('Cancelled'));
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('error', (e) => {
      if (settled) return;
      const err = new Error(`Network error: ${e.message}`);
      err.code = e.code;
      done(reject, err);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Retryable = the request may succeed with another model or a moment later.
 * 400 / 401 / 403 are permanent failures and are reported immediately.
 */
function isRetryable(err) {
  if (err?.status) return RETRYABLE_STATUS.has(err.status);
  return /network error|timed out|socket hang up/i.test(err?.message || '');
}

/** Quick key check for the Settings "Test" button. */
function testKey(apiKey) {
  if (!apiKey) return Promise.resolve({ ok: false, message: 'No key entered' });
  const body = JSON.stringify({
    contents: [{ parts: [{ text: 'Reply with OK' }] }],
    generationConfig: { maxOutputTokens: 5, thinkingConfig: { thinkingLevel: 'minimal' } },
  });
  // The same model chain as a real dictation — a busy model must not make
  // a perfectly valid key look broken.
  const chain = [DEFAULT_MODEL, ...FALLBACK_MODELS.filter((m) => m !== DEFAULT_MODEL)];
  return (async () => {
    let lastErr = null;
    for (const model of chain) {
      try {
        await postStreaming(`/v1beta/models/${model}:streamGenerateContent?alt=sse`,
          body, apiKey, null, Date.now(), null, 10000);
        return { ok: true, message: 'Key works ✓' };
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) break;
      }
    }
    return { ok: false, message: lastErr?.message || 'Request failed' };
  })();
}

module.exports = { transcribe, testKey, resolveModel, buildSystemPrompt, DEFAULT_MODEL, FALLBACK_MODELS };
