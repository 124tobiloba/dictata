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
// Capacity on the newest models is unreliable: they regularly take 20-30 s
// or stop answering altogether. 2.5-flash is consistently fast right now,
// so it is the default and the first entry of the fallback chain.
const DEFAULT_MODEL = 'gemini-2.5-flash';
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.6-flash'];
const TIMEOUT_MS = 30000;        // per request
const TOTAL_BUDGET_MS = 60000;  // for the whole model chain
const MAX_OUTPUT_TOKENS = 4096;

// Models Google has retired for new keys → map to a working one.
const RETIRED = /^gemini-(1\.[0-9]|2\.0|pro-vision)/;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
// The model echoing our instruction back means it heard no speech.
const ECHO = /^transcribe this recording now\.?$/i;

function resolveModel(model) {
  if (!model || RETIRED.test(model)) return DEFAULT_MODEL;
  return model;
}

/** thinkingLevel is only understood by the Gemini 3.x models. */
function supportsThinkingLevel(model) {
  const m = /^gemini-(\d+)\./.exec(model || '');
  return m ? Number(m[1]) >= 3 : false;
}

/**
 * Build the request body for a model.
 *
 * The body is model-specific: sending thinkingConfig to a model that does
 * not understand it fails with "Thinking level is not supported for this
 * model." — a 400 that no retry can fix.
 */
function buildRequestBody({ model, wavBase64, systemPrompt }) {
  return JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'audio/wav', data: wavBase64 } },
        { text: 'Transcribe this recording now.' },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...(supportsThinkingLevel(model)
        ? { thinkingConfig: { thinkingLevel: 'minimal' } }
        : {}),
    },
  });
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

  const systemPrompt = buildSystemPrompt({
    style, appName, dictionary, replacements,
    language, userName, textBefore, textAfter, prevCleaned,
  });

  // Try the preferred model first, then walk down the fallback chain.
  //   • 429 / 503 → the model is at capacity: wait and retry the same one
  //   • timeout   → the model is not answering at all: use the next one
  const chain = [useModel, ...FALLBACK_MODELS.filter((m) => m !== useModel)];
  let result = null;
  let lastErr = null;
  let answeredModel = null;

  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    const remaining = TOTAL_BUDGET_MS - (Date.now() - t0);
    if (i > 0 && remaining < 5000) break;      // no time left for another try
    const timeout = Math.max(5000, Math.min(TIMEOUT_MS, remaining));
    const body = buildRequestBody({ model: candidate, wavBase64: wav.toString('base64'), systemPrompt });
    const path = `/v1beta/models/${candidate}:streamGenerateContent?alt=sse`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await postStreaming(path, body, apiKey, onPartial, t0, signal, timeout);
        answeredModel = candidate;
        if (candidate !== useModel) {
          console.warn(`[gemini] ${useModel} failed (${lastErr?.message}) — ${candidate} answered instead`);
        }
        break;
      } catch (err) {
        lastErr = err;
        if (err?.message === 'Cancelled') throw err;
        if (!isRetryable(err)) throw err;        // 400 / 401 / 403 → fail fast
        console.warn(`[gemini] ${candidate}: ${err.message}`);
        const timedOut = /timed out/i.test(err.message);
        if (timedOut || attempt === 1) break;    // timeout → try the next model
        // Capacity error: wait as long as the API asked us to.
        await sleep(err.retryAfter || (attempt === 0 ? 2000 : 4000));
        if (Date.now() - t0 > TOTAL_BUDGET_MS) break;
      }
    }
    if (result) break;
  }

  if (!result) throw lastErr || new Error('Gemini request failed');

  const cleaned = result.text.trim();
  console.log(`[gemini] ${useModel} | audio ${(wav.length / 1024).toFixed(0)} KB | total ${Date.now() - t0} ms`);

  if (!cleaned) throw new Error('No speech detected');
  // With silence the model sometimes echoes the instruction instead of
  // saying that there was no speech.
  if (ECHO.test(cleaned)) throw new Error('No speech detected');
  if (result.truncated) {
    console.warn('[gemini] response hit the token limit — transcript may be cut off');
  }
  return {
    raw: cleaned,
    cleaned,
    language,
    truncated: !!result.truncated,
    model: answeredModel || useModel,
  };
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
          // The API tells us how long to wait when it is rate limiting us.
          const retryAfter = Number(res.headers['retry-after']);
          if (Number.isFinite(retryAfter) && retryAfter > 0) {
            err.retryAfter = Math.min(retryAfter * 1000, 15000);
          }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Quick key check for the Settings "Test" button. */
function testKey(apiKey) {
  if (!apiKey) return Promise.resolve({ ok: false, message: 'No key entered' });
  const body = JSON.stringify({
    contents: [{ parts: [{ text: 'Reply with OK' }] }],
    generationConfig: {
      maxOutputTokens: 5,
      ...(supportsThinkingLevel(DEFAULT_MODEL)
        ? { thinkingConfig: { thinkingLevel: 'minimal' } }
        : {}),
    },
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

module.exports = {
  transcribe, testKey, resolveModel, buildSystemPrompt, buildRequestBody,
  supportsThinkingLevel, DEFAULT_MODEL, FALLBACK_MODELS,
};
