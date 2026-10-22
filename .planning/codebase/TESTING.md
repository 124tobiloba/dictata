---
last_mapped_commit: 0439ed1ae6b93347340f8af55ab3cb3f630a64f4
last_mapped_at: 2026-10-22
---
# Testing Patterns

**Analysis Date:** 2026-10-22

## Test Framework

**Runner:**
- Node.js built-in test runner — `node:test` (no third-party runner).
- Config: none. There is no `jest.config.*`, `vitest.config.*`, or `.mocharc`. Test discovery is done by the CLI glob in `package.json:10`.
- Node.js 18+ required (developed on Node 22 per `README.md:31`). The runner is invoked as `node --test`.

**Assertion Library:**
- `node:assert` — imported as `const assert = require('node:assert')` (the non-strict API, so `assert.equal` is loose equality).
- No chai, no jest matchers, no custom assertion helpers.

**Run Commands:**

```bash
npm test                 # node --test "test/**/*.test.js" — 68 tests, ~1.5s
npm run test:dashboard   # node --test test/dashboard.test.js — server integration only
npm run test:api         # live Gemini request; needs network + GEMINI_API_KEY
npm run test:paste       # real paste pipeline; needs Windows desktop (opens Notepad)
npm run test:mic         # real microphone RMS probe; needs a microphone
```

- Current result: `68 tests`, `68 pass`, `0 fail`, `0 skipped`, `0 suites` (`npm test`).
- Optional coverage (no config required): `node --test --experimental-test-coverage "test/**/*.test.js"`.

## Test File Organization

**Location:**
- Separate `test/` directory at the repository root. Tests are never co-located with source.
- Each test file maps one-to-one to the module it covers: `test/ptt.test.js` → `src/main/ptt.js`, `test/wav.test.js` → `src/main/wav.js`, `test/store.test.js` → `src/main/store.js`.
- `test/dashboard.test.js` is the integration suite for the HTTP/SSE server (`src/main/dashboard.js`).
- `test/page.test.js` is a static-analysis suite over the dashboard page assets (`src/dashboard/index.html`, `styles.css`, `app.js`).

**Naming:**
- `<module>.test.js`, all lowercase, matching the source module.
- Test names are full lowercase sentences describing behavior, not method names: `'a slow second press stops the recording'`, `'rejects API calls without a token'`, `'the dashboard token survives a restart'`.

**Structure:**

```text
test/
├── analytics.test.js    # pure aggregation
├── dashboard.test.js    # HTTP server + SSE (integration)
├── gemini.test.js       # prompt building, model resolution
├── hotkeys.test.js      # accelerator conversion
├── page.test.js         # static checks on dashboard HTML/CSS/JS
├── ptt.test.js          # push-to-talk state machine
├── sse.test.js          # SSE parser
├── store.test.js        # settings merge / persistence shape
└── wav.test.js          # WAV encoder
```

**Supporting live scripts (not part of `npm test`):**
- `scripts/test-api.js` — live Gemini path, model fallback, response parsing.
- `scripts/test-paste.js` — end-to-end paste into Notepad, clipboard restore.
- `scripts/mic-probe.js` — measures real microphone RMS.

## Test Structure

**Suite Organization:**
- Flat `test()` calls only. There is no `describe`, no nesting, and no `beforeEach`/`afterEach` anywhere (0 occurrences of `describe(` / `it(`).
- File header is a one-line comment naming the unit under test, optionally followed by the run command:

```js
// Unit tests for the push-to-talk / hands-free state machine.
//   node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { PttState } = require('../src/main/ptt');
```

**Typical test:**

```js
test('a slow second press stops the recording', () => {
  const c = makeClock();
  const ptt = new PttState({ now: c.now });
  ptt.press();
  c.advance(1500);
  assert.deepEqual(ptt.press(), { action: 'stop', handsFree: false });
  assert.equal(ptt.recording, false);
});
```

**Patterns:**
- Arrange / act / assert in one short block — no setup callbacks.
- Deterministic time: a hand-rolled clock is injected instead of faking `Date.now()` globally (`test/ptt.test.js:7-10`).
- Explicit edge cases are first-class tests: empty input, `null`, `undefined`, CRLF, partially received chunks, wrong tokens.
- Assertions include a message when the failure would be ambiguous: `assert.equal(ptt.recording, true, 'the recording must NOT be stopped')`.
- Integration tests always release resources in `finally` (`test/dashboard.test.js:23-32`).

**Async tests:**

```js
test('serves the dashboard page', async () => {
  await withServer(async (server) => {
    const res = await fetch(server.baseUrl + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /Dictata/);
  });
});
```

## Mocking

**Framework:** None. There is no mocking library, no `mock.module`, no `--experimental-test-module-mocks`.

**Patterns:**
- **Hand-written fakes instead of mocks.** `test/dashboard.test.js:9-21` defines `fakeStore()` as a plain object with a `snapshot()` function returning only the fields the server reads.
- **Dependency injection instead of module interception.** `DashboardServer` accepts `{ store, bus, port, token }`, so the test passes fakes and `port: 0` (OS-assigned port) rather than patching `node:http` (`test/dashboard.test.js:23-32`).
- **Clock injection for time-dependent logic.** `PttState` accepts `now` (`src/main/ptt.js:26-31`); tests use `makeClock()` with `advance()`.
- **Real local I/O for integration.** The dashboard suite starts a real server on `127.0.0.1` with the built-in global `fetch()` and streams SSE through `res.body.getReader()` (`test/dashboard.test.js:124-149`).
- **Electron modules are imported but not exercised.** `test/store.test.js` and `test/hotkeys.test.js` `require()` modules that also require `electron`, but only call pure functions (`mergeDefaults`, `toAccelerator`) that never touch Electron APIs. Keep new tests on the pure export path if they run under plain Node.

**What to Mock:**
- External state that is slow or unavailable: the Store in the dashboard suite, the clock in the PTT suite.
- Never mock local pure modules — call them directly.

**What NOT to Mock:**
- `src/main/wav.js`, `src/main/sse.js`, `src/main/ptt.js`, `src/main/analytics.js`, the prompt builders in `src/main/gemini.js`, and `mergeDefaults` in `src/main/store.js`. These are pure and are tested as-is.
- Do not mock `fetch`, `http`, or timers in the dashboard suite; the real local server is the point of that test.

## Fixtures and Factories

**Test Data:**
- Factory functions with an overrides object are the standard pattern:

```js
function entry(over = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    raw: 'raw text here',
    cleaned: 'Raw text here',
    durationMs: 5000,
    transcribeMs: 1500,
    model: 'gemini-2.5-flash',
    at: Date.now(),
    ...over,
  };
}
```

(`test/analytics.test.js:10-21`)
- Server lifecycle is wrapped in a helper that guarantees teardown:

```js
async function withServer(fn) {
  const bus = new EventBus();
  const server = new DashboardServer({ store: fakeStore(), bus, port: 0 });
  await server.start();
  try { await fn(server, bus); }
  finally { server.stop(); }
}
```

(`test/dashboard.test.js:23-32`)
- Dashboard history fixtures are generated with `Array.from({ length: 25 }, (_, i) => ...)` to test ordering and volume (`test/dashboard.test.js:88-99`).

**Location:**
- Fixtures live inline at the top of the test file that needs them. There is no shared `fixtures/` directory and no cross-file test helpers.
- If a fixture is needed by two suites, extract it into a local helper module under `test/` only when duplication becomes real.

## Coverage

**Requirements:** None enforced. No coverage thresholds, no CI configuration in the repository, and no coverage badge.

**View Coverage:**

```bash
node --test --experimental-test-coverage "test/**/*.test.js"
```

- Priority areas already covered: `ptt.js` (9 tests), `analytics.js` (10), `gemini.js` prompt/model logic (8), `store.js` merge logic (6), `sse.js` (6), `wav.js` (5), `hotkeys.js` (4), dashboard server (11), dashboard page statics (9).

## Test Types

**Unit Tests:**
- Scope: pure functions and state machines with no Electron, network, filesystem, or microphone access.
- Files: `test/ptt.test.js`, `test/wav.test.js`, `test/sse.test.js`, `test/store.test.js`, `test/gemini.test.js`, `test/hotkeys.test.js`, `test/analytics.test.js`.
- Approach: direct function/class calls; injected clocks; assertions on exact return shapes.

**Integration Tests:**
- Scope: the local dashboard HTTP server, authentication, state payload, history ordering, SSE delivery, port fallback.
- File: `test/dashboard.test.js`.
- Approach: real server on `127.0.0.1`, real `fetch`, real streaming reader; fake Store and real `EventBus`.

**Static Analysis Tests:**
- Scope: the no-build dashboard page. `test/page.test.js` reads `index.html`, `styles.css`, `app.js` as strings and asserts:
  - every `$('#id')` lookup in `app.js` has a matching `id="…"` in the HTML (`test/page.test.js:20-28`);
  - every `data-tab` has a matching `data-panel` (`test/page.test.js:30-35`);
  - `[hidden]` really hides, there is no demo/simulation code, no webfont or CDN, at least three breakpoints, reduced-motion support, and the stale-link takeover behavior (`test/page.test.js:37-81`).

**Live / End-to-End Scripts (manual, not in `npm test`):**
- `scripts/test-api.js` — sends a synthetic WAV to Gemini; treats "No speech detected" as success because the request path is what is under test.
- `scripts/test-paste.js` — opens Notepad, calls the real `pasteText()`, verifies Notepad received the text and the clipboard was restored. Uses a small `check(name, ok, detail)` harness and `app.exit(failures ? 1 : 0)`.
- `scripts/mic-probe.js` — Electron window with `getUserMedia`, prints RMS/peak after 4 seconds to distinguish a silent device from a broken level calculation.

**Manual checklist:** `README.md:199-222` covers the nine user-facing flows plus the dashboard restart/stale-token behavior.

## Common Patterns

**Async Testing:**
- `async` test callbacks with `await` on every I/O call. Never fire-and-forget inside a test except for deliberately timed event publication:

```js
setTimeout(() => bus.publish('dictation', { text: 'hello from the bus', words: 5 }), 50);
```

(`test/dashboard.test.js:135`)

**Deadline loops for streams:**

```js
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  if (buffer.includes('hello from the bus')) break;
}
await reader.cancel();
```

(`test/dashboard.test.js:137-144`)

**Error Testing:**
- Assert on exact messages where they are part of the contract:

```js
assert.equal(normalizeError('Gemini 503: high demand'), 'Gemini 503');
```

- Assert on HTTP status for failure paths: `assert.equal(res.status, 401)` for missing and wrong tokens (`test/dashboard.test.js:60-72`).
- Assert that a function does *not* throw or does *not* match, using `assert.doesNotMatch` (`test/gemini.test.js:39-47`).

**Ordering and identity:**
- Use `assert.deepEqual` for arrays and object shapes; use timestamp arrays to prove newest-first ordering (`test/dashboard.test.js:116-118`).

**Port allocation:**
- Always pass `port: 0` in tests so the OS picks a free port; read it back from `server.port` / `server.baseUrl`. Never hard-code `7788` in a test.

## Adding New Tests

1. Put the file at `test/<module>.test.js`, import with `node:test`, `node:assert`, and the module's pure export.
2. Write flat `test('lowercase behavior sentence', …)` blocks — no `describe`.
3. Keep the unit pure: if the code under test needs Electron, network, or a microphone, extract the pure part or add a live script under `scripts/` instead.
4. Add an explicit edge case for empty/null input and one for the failure path.
5. Run `npm test`; all tests must pass without network, microphone, or API key.

**Known gaps to be aware of:**
- `src/main/recorder.js`, `src/main/paste.js`, `src/main/winhelper.js`, `src/main/logger.js`, and the orchestration in `src/main/main.js` have no automated tests; `paste.js`/`winhelper.js` are covered only by `scripts/test-paste.js`.
- `Store` file I/O, encryption, debounced saves, and legacy migration are untested; only `mergeDefaults` is covered (`test/store.test.js`).
- Renderer scripts (`statusRenderer.js`, `settingsRenderer.js`, `historyRenderer.js`) have no DOM tests.
- `HotkeyService` registration is not tested, only `toAccelerator` (`test/hotkeys.test.js`).

---

*Testing analysis: 2026-10-22*
