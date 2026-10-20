// Unit tests for the accelerator conversion.
const test = require('node:test');
const assert = require('node:assert');
const { toAccelerator } = require('../src/main/hotkeys');

test('maps Ctrl to CommandOrControl', () => {
  assert.equal(toAccelerator(['Ctrl', 'Shift', 'Space']), 'CommandOrControl+Shift+Space');
  assert.equal(toAccelerator(['Control', 'D']), 'CommandOrControl+D');
});

test('maps the Windows key to Super', () => {
  assert.equal(toAccelerator(['Meta', 'D']), 'Super+D');
  assert.equal(toAccelerator(['Win', 'D']), 'Super+D');
});

test('passes other keys through', () => {
  assert.equal(toAccelerator(['Alt', 'Shift', 'D']), 'Alt+Shift+D');
  assert.equal(toAccelerator(['F5']), 'F5');
});

test('returns null for an empty chord', () => {
  assert.equal(toAccelerator([]), null);
  assert.equal(toAccelerator(null), null);
  assert.equal(toAccelerator(undefined), null);
});
