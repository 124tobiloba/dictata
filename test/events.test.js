// Unit tests for the activity event bus.
//
// The delete path relies on the bus actually dropping a row: a no-op `forget`
// would still let the deleted text back out over SSE, and nothing else in the
// suite would notice.
const test = require('node:test');
const assert = require('node:assert');

const { EventBus } = require('../src/main/events');

/** Decorate the singleton exactly the way src/main/main.js does. */
function decorate(bus) {
  bus.appState = 'idle';
  bus.handsFree = false;
  bus.startedAt = 1700000000000;
  bus.version = '0.1.0';
  return bus;
}

test('forget removes one event and keeps the app-state properties', () => {
  const bus = decorate(new EventBus());
  const a = bus.publish('dictation', { text: 'one' });
  const b = bus.publish('error', { message: 'two' });
  const c = bus.publish('info', { message: 'three' });

  bus.forget(a.id);

  assert.deepEqual(bus.recent().map((e) => e.id), [c.id, b.id]);
  assert.equal(bus.persistable().some((e) => e.id === a.id), false);

  assert.equal(bus.appState, 'idle');
  assert.equal(bus.handsFree, false);
  assert.equal(bus.startedAt, 1700000000000);
  assert.equal(bus.version, '0.1.0');
});

test('forgetMany drops every listed id and leaves the rest', () => {
  const bus = decorate(new EventBus());
  const a = bus.publish('dictation', { text: 'one' });
  const b = bus.publish('error', { message: 'two' });
  const c = bus.publish('info', { message: 'three' });

  bus.forgetMany([a.id, b.id]);

  assert.deepEqual(bus.recent().map((e) => e.id), [c.id]);
  assert.equal(bus.persistable().length, 1);
  assert.equal(bus.persistable()[0].id, c.id);
});

test('forgetAll empties the buffer but not the app state', () => {
  const bus = decorate(new EventBus());
  bus.publish('dictation', { text: 'one' });
  bus.publish('error', { message: 'two' });

  bus.forgetAll();

  assert.deepEqual(bus.buffer, []);
  assert.deepEqual(bus.recent(), []);
  assert.deepEqual(bus.persistable(), []);
  assert.equal(bus.appState, 'idle');
  assert.equal(bus.handsFree, false);
  assert.equal(bus.startedAt, 1700000000000);
  assert.equal(bus.version, '0.1.0');
});
