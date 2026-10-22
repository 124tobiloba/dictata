// Integration tests for the local dashboard server.
//   node --test "test/**/*.test.js"
const test = require('node:test');
const assert = require('node:assert');

const { EventBus } = require('../src/main/events');
const { DashboardServer } = require('../src/main/dashboard');

/** A minimal stand-in for the Store. */
function fakeStore(history = [], events = []) {
  return {
    snapshot: () => ({
      settings: { model: 'gemini-2.5-flash' },
      history,
      events,
      stats: { words: 120, sessions: 4, msSpoken: 60000 },
      dictionary: [],
      replacements: [],
    }),
  };
}

async function withServer(fn) {
  const bus = new EventBus();
  const server = new DashboardServer({ store: fakeStore(), bus, port: 0 });
  await server.start();
  try {
    await fn(server, bus);
  } finally {
    server.stop();
  }
}

test('serves the dashboard page', async () => {
  await withServer(async (server) => {
    const res = await fetch(server.baseUrl + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /Dictata/);
    // The three views the page offers.
    assert.match(html, /data-tab="live"/);
    assert.match(html, /data-tab="history"/);
    assert.match(html, /data-tab="insights"/);
  });
});

test('serves the stylesheet and the client script', async () => {
  await withServer(async (server) => {
    const css = await fetch(server.baseUrl + '/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const js = await fetch(server.baseUrl + '/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  });
});

test('rejects API calls without a token', async () => {
  await withServer(async (server) => {
    const res = await fetch(server.baseUrl + '/api/state');
    assert.equal(res.status, 401);
  });
});

test('rejects API calls with a wrong token', async () => {
  await withServer(async (server) => {
    const res = await fetch(server.baseUrl + '/api/state?token=nope');
    assert.equal(res.status, 401);
  });
});

test('returns the state snapshot with a valid token', async () => {
  await withServer(async (server) => {
    const res = await fetch(`${server.baseUrl}/api/state?token=${server.token}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.analytics);
    assert.ok(data.analytics.totals);
    assert.equal(data.app.model, 'gemini-2.5-flash');
    assert.ok(Array.isArray(data.history));
  });
});

test('the history view gets every stored dictation, with its text', async () => {
  const bus = new EventBus();
  const history = Array.from({ length: 25 }, (_, i) => ({
    id: `h-${i}`,
    raw: `raw ${i}`,
    cleaned: `dictation number ${i}`,
    at: 1_700_000_000_000 + i * 1000,
    durationMs: 2000 + i,
    transcribeMs: 900 + i,
    pasteMs: 120,
    pasted: i % 5 !== 0,
    model: 'gemini-2.5-flash',
    words: 3,
  }));
  const server = new DashboardServer({ store: fakeStore([...history].reverse()), bus, port: 0 });
  await server.start();
  try {
    const res = await fetch(`${server.baseUrl}/api/state?token=${server.token}`);
    const data = await res.json();

    // Older dictations must survive — a 40-row live feed would hide them.
    assert.equal(data.history.length, 25);
    assert.equal(data.events.filter((e) => e.type === 'dictation').length, 25);

    const newest = data.history[0];
    assert.equal(newest.id, 'h-24');
    assert.equal(newest.cleaned, 'dictation number 24');
    assert.equal(newest.pasted, true);
    assert.equal(newest.pasteMs, 120);

    // Newest first, so the history reads like a timeline.
    const times = data.history.map((h) => h.at);
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  } finally {
    server.stop();
  }
});

test('streams live events over SSE', async () => {
  await withServer(async (server, bus) => {
    const res = await fetch(`${server.baseUrl}/api/events?token=${server.token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Publish an event once the stream is open.
    setTimeout(() => bus.publish('dictation', { text: 'hello from the bus', words: 5 }), 50);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('hello from the bus')) break;
    }
    await reader.cancel();

    assert.match(buffer, /event: hello/);
    assert.match(buffer, /hello from the bus/);
    assert.match(buffer, /"type":"dictation"/);
  });
});

test('falls back to the next free port', async () => {
  const bus = new EventBus();
  const first = new DashboardServer({ store: fakeStore(), bus, port: 0 });
  await first.start();
  const second = new DashboardServer({ store: fakeStore(), bus, port: first.port });
  await second.start();
  try {
    assert.notEqual(second.port, first.port);
    assert.ok(second.url.startsWith('http://127.0.0.1:'));
  } finally {
    first.stop();
    second.stop();
  }
});

test('binds to localhost only', async () => {
  await withServer(async (server) => {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\//);
  });
});

test('uses a token that was handed in, so links survive a restart', async () => {
  const bus = new EventBus();
  const server = new DashboardServer({ store: fakeStore(), bus, port: 0, token: 'a-stable-token' });
  await server.start();
  try {
    assert.equal(server.token, 'a-stable-token');
    assert.match(server.url, /token=a-stable-token$/);

    const res = await fetch(`${server.baseUrl}/api/state?token=a-stable-token`);
    assert.equal(res.status, 200);
  } finally {
    server.stop();
  }
});

test('the state payload carries the real keyboard shortcuts', async () => {
  const bus = new EventBus();
  const store = fakeStore();
  store.snapshot = () => ({
    settings: {
      model: 'gemini-2.5-flash',
      shortcuts: { pushToTalk: ['Alt', 'Shift', 'D'], handsFree: ['Alt', 'Shift', 'F'] },
    },
    history: [], events: [], stats: {}, dictionary: [], replacements: [],
  });
  const server = new DashboardServer({ store, bus, port: 0 });
  await server.start();
  try {
    const res = await fetch(`${server.baseUrl}/api/state?token=${server.token}`);
    const data = await res.json();
    assert.deepEqual(data.app.shortcuts.pushToTalk, ['Alt', 'Shift', 'D']);
  } finally {
    server.stop();
  }
});
