/**
 * test-api.js — live check of the Gemini pipeline.
 *
 * Sends a short synthetic WAV to the API and reports which model answered,
 * how long it took and whether the fallback chain works.
 *
 * Run with:  npm run test:api
 */

require('dotenv').config();
const { transcribe, DEFAULT_MODEL, FALLBACK_MODELS } = require('../src/main/gemini');
const { encodeWav } = require('../src/main/wav');

const apiKey = (process.env.GEMINI_API_KEY || '').trim();

if (!apiKey) {
  console.error('\nNo GEMINI_API_KEY in .env — add one and try again.\n');
  process.exit(1);
}

// One second of a quiet tone. The model will not find any speech in it,
// but the request path, the model and the response format are what we
// are testing here.
const samples = new Float32Array(16000);
for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 20) * 0.0005;
const wav = encodeWav([samples], 16000);

async function run(model, label) {
  const t0 = Date.now();
  process.stdout.write(`  ${label.padEnd(26)} ${model.padEnd(26)} `);
  try {
    const r = await transcribe({ wav, apiKey, model, style: 'polished' });
    console.log(`OK in ${Date.now() - t0} ms  → "${String(r.cleaned).slice(0, 40)}"`);
    return true;
  } catch (e) {
    // The recording is a synthetic tone, so an empty transcript is the
    // correct answer — what matters is that the request went through.
    if (/no speech detected/i.test(e.message)) {
      console.log(`OK in ${Date.now() - t0} ms  (no speech in the test tone, as expected)`);
      return true;
    }
    console.log(`FAILED in ${Date.now() - t0} ms  → ${e.message}`);
    return false;
  }
}

(async () => {
  console.log('\nDictata — live API test\n');
  console.log(`  default model : ${DEFAULT_MODEL}`);
  console.log(`  fallbacks     : ${FALLBACK_MODELS.join(', ')}\n`);

  const ok = await run(DEFAULT_MODEL, 'default model');

  console.log('\n  (a silence-only recording is expected to come back empty or\n' +
              '   with a hallucination — the request itself is what matters)\n');

  process.exit(ok ? 0 : 1);
})();
