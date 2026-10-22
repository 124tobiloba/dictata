// Integration tests for the local dashboard server.
//   node --test "test/**/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

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

async function withServer(fn, opts = {}) {
  const bus = new EventBus();
  const server = new DashboardServer({ store: fakeStore(), bus, port: 0, ...opts });
  await server.start();
  try {
    await fn(server, bus);
  } finally {
    server.stop();
  }
}

const HISTORY_UUID = '8f0d6c1e-1111-4222-8333-444455556666';

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

// ── Delete routes ────────────────────────────────────────────────────────────
// Order matters: host → method+path → token → id validation → purge.

test('a delete without a token never reaches the purge', async () => {
  const seen = [];
  await withServer(async (server) => {
    const res = await fetch(`${server.baseUrl}/api/history/${HISTORY_UUID}`, { method: 'DELETE' });
    assert.equal(res.status, 401);
  }, { onPurge: (id) => { seen.push(id); return 1; } });
  assert.deepEqual(seen, []);
});

test('a delete with a wrong token never reaches the purge', async () => {
  const seen = [];
  await withServer(async (server) => {
    const res = await fetch(`${server.baseUrl}/api/history/${HISTORY_UUID}?token=nope`, { method: 'DELETE' });
    assert.equal(res.status, 401);
  }, { onPurge: (id) => { seen.push(id); return 1; } });
  assert.deepEqual(seen, []);
});

test('a delete accepts a history UUID and hands it over unchanged', async () => {
  const seen = [];
  await withServer(async (server) => {
    const res = await fetch(`${server.baseUrl}/api/history/${HISTORY_UUID}?token=${server.token}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { removed: 1 });
  }, { onPurge: (id) => { seen.push(id); return 1; } });
  assert.deepEqual(seen, [HISTORY_UUID]);
});

test('a delete accepts a failed-attempt bus id', async () => {
  const seen = [];
  await withServer(async (server) => {
    const res = await fetch(`${server.baseUrl}/api/history/mhqk3z1a-0?token=${server.token}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
  }, { onPurge: (id) => { seen.push(id); return 1; } });
  assert.deepEqual(seen, ['mhqk3z1a-0']);
});

test('a delete for an id that matches nothing is a 404', async () => {
  await withServer(async (server) => {
    const res = await fetch(`${server.baseUrl}/api/history/${HISTORY_UUID}?token=${server.token}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 404);
  }, { onPurge: () => 0 });
});

test('a malformed or traversal-shaped id is refused with a 400', async () => {
  const seen = [];
  await withServer(async (server) => {
    for (const bad of ['a-b-c', '..%2F..%2Fx']) {
      const res = await fetch(`${server.baseUrl}/api/history/${bad}?token=${server.token}`, {
        method: 'DELETE',
      });
      assert.equal(res.status, 400, `${bad} must be rejected`);
    }
  }, { onPurge: (id) => { seen.push(id); return 1; } });
  assert.deepEqual(seen, []);
});

test('a GET is never served as a delete', async () => {
  const seen = [];
  await withServer(async (server) => {
    const list = await fetch(`${server.baseUrl}/api/history?token=${server.token}`);
    assert.equal(list.status, 200, 'the read route still works');
    assert.ok(Array.isArray((await list.json()).history));

    const one = await fetch(`${server.baseUrl}/api/history/${HISTORY_UUID}?token=${server.token}`);
    assert.equal(one.status, 404, 'a GET falls through to the static 404');
  }, { onPurge: (id) => { seen.push(id); return 1; } });
  assert.deepEqual(seen, []);
});

test('clear-all needs the token and returns the callback count', async () => {
  let calls = 0;
  await withServer(async (server) => {
    const unauth = await fetch(`${server.baseUrl}/api/history`, { method: 'DELETE' });
    assert.equal(unauth.status, 401);
    assert.equal(calls, 0, 'an unauthorised request never clears anything');

    const res = await fetch(`${server.baseUrl}/api/history?token=${server.token}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { removed: 3 });
  }, { onClearAll: () => { calls++; return 3; } });
  assert.equal(calls, 1);
});

// ── Privacy facts and Open Settings (D-02, T-01-06) ──────────────────────────
// Every state response must carry the facts, and the only dashboard action is
// opening a window — behind the same host + token gates as every other route.

test('the state payload carries the read-only privacy facts', async () => {
  const facts = { retentionDays: 90, storeDir: 'C:\\Users\\HP\\AppData\\Roaming\\Dictata', auditCount: 7 };
  await withServer(async (server) => {
    const res = await fetch(`${server.baseUrl}/api/state?token=${server.token}`);
    const data = await res.json();
    assert.deepEqual(data.privacy, facts);
  }, { getPrivacyFacts: () => facts });
});

test('without an injected source the privacy block is null, never invented', async () => {
  await withServer(async (server) => {
    const res = await fetch(`${server.baseUrl}/api/state?token=${server.token}`);
    const data = await res.json();
    assert.equal(data.privacy, null);
  });
});

test('the privacy path follows the store after a move, without a restart', async () => {
  // The facts come from the main process, but `storeDir` must be read from the
  // store's current file on every call — a storage move must not leave the
  // dashboard naming the folder the record has left.
  const store = fakeStore();
  store.file = 'C:\\one\\dictata.json';
  const server = new DashboardServer({
    store,
    bus: new EventBus(),
    port: 0,
    getPrivacyFacts: () => ({ retentionDays: 0, storeDir: 'C:\\stale', auditCount: 3 }),
  });
  await server.start();
  try {
    let res = await fetch(`${server.baseUrl}/api/state?token=${server.token}`);
    let data = await res.json();
    assert.equal(data.privacy.storeDir, path.dirname(store.file));
    assert.equal(data.privacy.auditCount, 3, 'the other facts pass through');

    store.file = 'D:\\two\\dictata.json';   // storage.moveTo + setFile()
    res = await fetch(`${server.baseUrl}/api/state?token=${server.token}`);
    data = await res.json();
    assert.equal(data.privacy.storeDir, path.dirname(store.file));
  } finally {
    server.stop();
  }
});

test('opening settings without a token never reaches the callback', async () => {
  let calls = 0;
  await withServer(async (server) => {
    const res = await fetch(`${server.baseUrl}/api/settings/open`, { method: 'POST' });
    assert.equal(res.status, 401);
  }, { onOpenSettings: () => { calls++; } });
  assert.equal(calls, 0);
});

test('opening settings with a valid token runs the callback', async () => {
  let calls = 0;
  await withServer(async (server) => {
    const res = await fetch(`${server.baseUrl}/api/settings/open?token=${server.token}`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }, { onOpenSettings: () => { calls++; } });
  assert.equal(calls, 1);
});

test('a cross-site POST cannot open settings', async () => {
  let calls = 0;
  await withServer(async (server) => {
    const res = await fetch(`${server.baseUrl}/api/settings/open?token=${server.token}`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example' },
    });
    assert.equal(res.status, 403);
  }, { onOpenSettings: () => { calls++; } });
  assert.equal(calls, 0);
});

test('a same-origin POST is allowed through', async () => {
  let calls = 0;
  await withServer(async (server) => {
    const res = await fetch(`${server.baseUrl}/api/settings/open?token=${server.token}`, {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${server.port}` },
    });
    assert.equal(res.status, 200);
  }, { onOpenSettings: () => { calls++; } });
  assert.equal(calls, 1);
});

test('a GET to the open-settings path never runs the callback', async () => {
  let calls = 0;
  await withServer(async (server) => {
    const res = await fetch(`${server.baseUrl}/api/settings/open?token=${server.token}`);
    assert.equal(res.status, 404, 'the read method falls through to the static 404');
  }, { onOpenSettings: () => { calls++; } });
  assert.equal(calls, 0);
});
