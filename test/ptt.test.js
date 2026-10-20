// Unit tests for the push-to-talk / hands-free state machine.
//   node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { PttState } = require('../src/main/ptt');

function makeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('first press starts a normal recording', () => {
  const c = makeClock();
  const ptt = new PttState({ now: c.now });
  assert.deepEqual(ptt.press(), { action: 'start', handsFree: false });
  assert.equal(ptt.recording, true);
});

test('a slow second press stops the recording', () => {
  const c = makeClock();
  const ptt = new PttState({ now: c.now });
  ptt.press();
  c.advance(1500);
  assert.deepEqual(ptt.press(), { action: 'stop', handsFree: false });
  assert.equal(ptt.recording, false);
});

test('double tap keeps recording and locks hands-free', () => {
  const c = makeClock();
  const ptt = new PttState({ now: c.now });
  ptt.press();                     // start
  c.advance(120);                  // second tap, fast
  assert.deepEqual(ptt.press(), { action: 'lock', handsFree: true });
  assert.equal(ptt.handsFree, true);
  assert.equal(ptt.recording, true, 'the recording must NOT be stopped');
});

test('a press while locked stops the recording and releases the lock', () => {
  const c = makeClock();
  const ptt = new PttState({ now: c.now });
  ptt.press();
  c.advance(100);
  ptt.press();                     // lock
  c.advance(2000);
  assert.deepEqual(ptt.press(), { action: 'stop', handsFree: false });
  assert.equal(ptt.recording, false);
  assert.equal(ptt.handsFree, false);
});

test('double tap while idle starts a locked recording', () => {
  const c = makeClock();
  const ptt = new PttState({ now: c.now });
  ptt.press();
  c.advance(100);
  ptt.press();                     // lock
  ptt.reset();                     // e.g. after an error
  assert.deepEqual(ptt.press(), { action: 'start', handsFree: false });
});

test('double-tap lock can be turned off in the settings', () => {
  const c = makeClock();
  const config = { doubleTapLocks: false };
  const ptt = new PttState({ config, now: c.now });
  ptt.press();
  c.advance(100);
  assert.deepEqual(ptt.press(), { action: 'stop', handsFree: false });
});

test('the hands-free key toggles a locked recording on and off', () => {
  const c = makeClock();
  const ptt = new PttState({ now: c.now });
  assert.deepEqual(ptt.toggleHandsFree(), { action: 'start-lock', handsFree: true });
  assert.deepEqual(ptt.toggleHandsFree(), { action: 'stop', handsFree: false });
});

test('cancel aborts an active recording', () => {
  const c = makeClock();
  const ptt = new PttState({ now: c.now });
  ptt.press();
  assert.deepEqual(ptt.cancel(), { action: 'cancel', handsFree: false });
  assert.equal(ptt.recording, false);
});

test('cancel does nothing when nothing is running', () => {
  const ptt = new PttState({ now: makeClock().now });
  assert.equal(ptt.cancel(), null);
});
