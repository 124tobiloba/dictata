// Unit tests for the prompt builder and model resolution.
const test = require('node:test');
const assert = require('node:assert');
const { resolveModel, buildSystemPrompt, DEFAULT_MODEL } = require('../src/main/gemini');

test('retired models fall back to the default', () => {
  assert.equal(resolveModel('gemini-1.5-pro'), DEFAULT_MODEL);
  assert.equal(resolveModel('gemini-2.0-flash'), DEFAULT_MODEL);
  assert.equal(resolveModel(''), DEFAULT_MODEL);
  assert.equal(resolveModel(undefined), DEFAULT_MODEL);
});

test('current models are kept', () => {
  assert.equal(resolveModel('gemini-3.5-flash'), 'gemini-3.5-flash');
  assert.equal(resolveModel('gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite');
  assert.equal(resolveModel('gemini-2.5-flash'), 'gemini-2.5-flash');
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
