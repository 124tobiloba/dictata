// Unit tests for the prompt builder and model resolution.
const test = require('node:test');
const assert = require('node:assert');
const { resolveModel, buildSystemPrompt, buildRequestBody, thinkingLevelFor, supportsThinkingLevel, DEFAULT_MODEL, FALLBACK_MODELS } = require('../src/main/gemini');

test('retired models fall back to the default', () => {
  assert.equal(resolveModel('gemini-1.5-pro'), DEFAULT_MODEL);
  assert.equal(resolveModel('gemini-2.0-flash'), DEFAULT_MODEL);
  // Retired for new API keys in 2026 — the API answers 404.
  assert.equal(resolveModel('gemini-2.5-flash'), DEFAULT_MODEL);
  assert.equal(resolveModel(''), DEFAULT_MODEL);
  assert.equal(resolveModel(undefined), DEFAULT_MODEL);
});

test('current models are kept', () => {
  assert.equal(resolveModel('gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(resolveModel('gemini-3.5-flash'), 'gemini-3.5-flash');
  assert.equal(resolveModel('gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite');
});

test('the prompt contains the style instruction', () => {
  const p = buildSystemPrompt({ style: 'verbatim', dictionary: [], replacements: [] });
  assert.match(p, /exactly what was said/i);
  assert.match(p, /output ONLY the final text/i);
});

test('the prompt contains dictionary terms and replacements', () => {
  const p = buildSystemPrompt({
    style: 'polished',
    dictionary: [{ term: 'Kubernetes' }],
    replacements: [{ from: 'teh', to: 'the' }],
  });
  assert.match(p, /Kubernetes/);
  assert.match(p, /teh.*the/);
});

test('the prompt contains the target app when known', () => {
  const withApp = buildSystemPrompt({ style: 'polished', appName: 'Slack', dictionary: [], replacements: [] });
  assert.match(withApp, /Slack/);
  const withoutApp = buildSystemPrompt({ style: 'polished', appName: '', dictionary: [], replacements: [] });
  assert.doesNotMatch(withoutApp, /Target app/);
});

test('the prompt never leaks empty sections', () => {
  const p = buildSystemPrompt({ style: 'polished', dictionary: [], replacements: [] });
  assert.doesNotMatch(p, /Spell exactly/);
  assert.doesNotMatch(p, /Expand/);
  assert.doesNotMatch(p, /Text before cursor/);
  assert.doesNotMatch(p, /Previous dictation/);
});

test('thinking levels match what each model actually accepts', () => {
  // 3.8-flash answers 400 to "minimal" but accepts "low". Guessing from the
  // version number is what made that a permanent, non-retryable failure.
  assert.equal(thinkingLevelFor('gemini-3.6-flash'), 'minimal');
  assert.equal(thinkingLevelFor('gemini-3.5-flash'), 'minimal');
  assert.equal(thinkingLevelFor('gemini-3.5-flash-lite'), 'minimal');
  assert.equal(thinkingLevelFor('gemini-3.8-flash'), 'low');
  assert.equal(thinkingLevelFor('gemini-2.5-flash'), null);
  assert.equal(thinkingLevelFor('gemini-2.0-flash'), null);
  assert.equal(thinkingLevelFor(''), null);

  assert.equal(supportsThinkingLevel('gemini-3.8-flash'), true);
  assert.equal(supportsThinkingLevel('gemini-2.5-flash'), false);
  assert.equal(supportsThinkingLevel(''), false);
});

test('the request body only sends a thinking level to models that support it', () => {
  const base = { wavBase64: 'AAA=', systemPrompt: 'test' };

  const old = JSON.parse(buildRequestBody({ ...base, model: 'gemini-2.5-flash' }));
  assert.equal(old.generationConfig.thinkingConfig, undefined,
    '2.5-flash rejects thinkingConfig with a 400');

  const modern = JSON.parse(buildRequestBody({ ...base, model: 'gemini-3.5-flash' }));
  assert.equal(modern.generationConfig.thinkingConfig.thinkingLevel, 'minimal');

  // The one model that only takes "low".
  const newest = JSON.parse(buildRequestBody({ ...base, model: 'gemini-3.8-flash' }));
  assert.equal(newest.generationConfig.thinkingConfig.thinkingLevel, 'low');

  // The audio travels inline, so the body must contain the base64 payload.
  assert.equal(modern.contents[0].parts[0].inlineData.mimeType, 'audio/wav');
  assert.equal(modern.contents[0].parts[0].inlineData.data, 'AAA=');
  assert.equal(modern.systemInstruction.parts[0].text, 'test');
});

test('the settings dropdown offers exactly the models the client uses', () => {
  // A retired option here is how every new user ends up on a 404: the select
  // binds the stored id, and the stored id is what gets sent.
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings.html'), 'utf8');
  const options = [...html.matchAll(/<option value="(gemini-[^"]+)"/g)].map((m) => m[1]);

  assert.ok(options.length >= 2, 'the model select is empty');
  assert.equal(new Set(options).size, options.length, 'duplicate model option');
  for (const model of options) {
    assert.ok(FALLBACK_MODELS.includes(model), `${model} is not in FALLBACK_MODELS`);
  }
  assert.ok(options.includes(DEFAULT_MODEL), 'the default model is not selectable');
});
