# Phase 1: Data Ownership — Pattern Map

**Mapped:** 2026-10-22
**Files analyzed:** 24 (7 new, 17 modified)
**Analogs found:** 21 / 24 (3 have no in-repo precedent)

Every analog named below is git-tracked source (verified with `git ls-files -- <path>` in
this session). No `.gsd/capabilities/**` mirror paths appear in this document.

## File Classification

| File | New/Mod | Role | Data Flow | Closest Analog | Match Quality |
|------|---------|------|-----------|----------------|---------------|
| `src/main/retention.js` | new | utility (pure) | transform | `src/main/ptt.js` (+ `src/main/analytics.js`) | role-match (pure module, injectable clock) |
| `src/main/exporter.js` | new | utility (pure) | transform | `src/main/analytics.js` | role-match (pure formatters, multi-export) |
| `src/main/ledger.js` | new | service | file-I/O (append-only) | `src/main/logger.js` (+ `src/main/store.js`) | role-match (fs append, never throws) |
| `src/main/storage.js` | new | service | file-I/O + CRUD | `src/main/store.js` | role-match (path resolution + atomic write) |
| `test/retention.test.js` | new | test | transform | `test/ptt.test.js` | exact (injectable clock) |
| `test/exporter.test.js` | new | test | transform | `test/analytics.test.js` | exact (pure-function assertions) |
| `test/ledger.test.js` | new | test | file-I/O | `test/dashboard.test.js` (`withServer`) + `test/store.test.js` | partial (no temp-dir precedent) |
| `src/main/store.js` | mod | model | CRUD | self-extend (`_save`, `addHistory`) | n/a — the persistence idiom itself |
| `src/main/events.js` | mod | store | event-driven | self-extend (`recent`, `clear`) | n/a |
| `src/main/analytics.js` | mod | utility (pure) | transform | self-extend (`summarize` totals loop) | n/a |
| `src/main/dashboard.js` | mod | controller/router | request-response | self-extend (`_handle`, `_state`) | n/a — the auth-order contract |
| `src/main/main.js` | mod | orchestrator/controller | request-response + event-driven | self-extend (`notifyHistory`, IPC block) | n/a |
| `src/renderer/settings.html` | mod | component (view) | request-response | self-extend (`data-panel` nav + `panel-*`) | n/a |
| `src/renderer/settingsRenderer.js` | mod | component (renderer) | request-response | self-extend (`loadGeneral`, `bindSelect`, `save`) | n/a |
| `src/renderer/settingsPreload.js` | mod | preload/bridge | request-response | self-extend (`contextBridge` map) | n/a |
| `src/renderer/historyRenderer.js` | mod | component (renderer) | CRUD | self-extend (`render`, delete handler) | n/a |
| `src/renderer/historyPreload.js` | mod (verify) | preload/bridge | request-response | self-extend | n/a |
| `src/dashboard/index.html` | mod | view | request-response | self-extend (history panel head) | n/a |
| `src/dashboard/app.js` | mod | controller (browser) | request-response + SSE | self-extend (`renderHistory`, `timeline`) | n/a |
| `src/dashboard/styles.css` | mod | config (styles) | — | self-extend (`.rec`, `:root`) | n/a |
| `test/store.test.js` | mod | test | CRUD | self-extend | n/a |
| `test/dashboard.test.js` | mod | test | request-response | self-extend (`withServer`, `fakeStore`) | n/a |
| `test/page.test.js` | mod | test | static assertions | self-extend | n/a |
| `test/analytics.test.js` | mod | test | transform | self-extend | n/a |

---

## Pattern Assignments

### `src/main/retention.js` (utility, pure/transform)

**Primary analog:** `src/main/ptt.js` — the repo's canonical "pure rules + injectable clock" module.
**Secondary analog:** `src/main/analytics.js` — pure helper shape and export style.

**Module header + why-it-is-separate pattern** (`src/main/ptt.js:1-17`):

```js
/**
 * ptt.js — push-to-talk / hands-free state machine (pure, no Electron).
 *
 * The hotkey layer used to toggle recording directly, which made the
 * double-tap-to-lock feature impossible: ...
 *
 * This module owns the interaction rules and returns explicit actions
 * that the app layer translates into recorder calls.
 * ...
 */
```

Copy this shape: a block comment naming the module, stating "pure, no Electron", and stating the
invariant (here: `0` means keep forever, so `cutoffFor` must return `null`).

**Injectable clock via `opts`** (`src/main/ptt.js:19-33`):

```js
const DEFAULT_DOUBLE_TAP_MS = 400;

class PttState {
  /**
   * @param {object} [opts]
   * @param {object} [opts.config]    live config, e.g. { doubleTapLocks: true }
   * @param {number} [opts.doubleTapMs]
   * @param {Function} [opts.now]      clock override (tests)
   */
  constructor(opts = {}) {
    this.config = opts.config || { doubleTapLocks: true };
    this.doubleTapMs = opts.doubleTapMs ?? DEFAULT_DOUBLE_TAP_MS;
    this.now = opts.now || (() => Date.now());
    this.reset();
  }
```

`retention.js` should be *functions*, not a class (there is no state), with `now` as an explicit
parameter — the research snippet already does this: `cutoffFor(days, now)` / `splitExpired(history, cutoff)`.

**Named-export-at-bottom pattern** (`src/main/analytics.js:9-13`, `:139`):

```js
const DAY_MS = 86400000;

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}
...
module.exports = { summarize, wordCount, normalizeError, startOfDay, isoDate };
```

Export `RETENTION_CHOICES` as an UPPER_SNAKE module constant next to `DEFAULT_DOUBLE_TAP_MS` /
`HISTORY_LIMIT` (`src/main/store.js:46-48`).

---

### `src/main/exporter.js` (utility, pure/transform)

**Analog:** `src/main/analytics.js` — the repo's template for "pure data shaping that both the
server and `node:test` call".

**Small composable pure helpers** (`src/main/analytics.js:11-26`):

```js
function wordCount(text) { ... }

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isoDate(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
```

`exporter.js` must follow the same rule: **no `electron`, no `fs`** (`README.md:110-112`;
`.planning/codebase/CONVENTIONS.md` "Pure logic modules must not require `electron`"). The main
process owns `dialog.showSaveDialog` + `fs.writeFileSync`; the module only returns
`{ headers, rows } | string`.

**Return explicit shapes, not booleans** (conventions "Return Values", e.g. `src/main/ptt.js:60-67`):
`toCsv(rows)` → string; `historyExport(history)` → `{ columns, rows }`; `auditExport(rows)` → same.

**Not to copy:** `JSON.stringify(x, null, 2)` from `src/main/store.js:135` for CSV — research Q6
requires `\uFEFF` BOM + CRLF + RFC 4180 quoting + `'` formula guard.

---

### `src/main/ledger.js` (service, file-I/O append-only)

**Primary analog:** `src/main/logger.js` — append-only file writer that must never throw.
**Secondary analog:** `src/main/store.js` — constructor `opts`/path injection.

**Path is injected once at init, never hardcoded** (`src/main/logger.js:15-25`):

```js
let logFile = null;
let originals = null;

function init(app) {
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'dictata.log');
  } catch (e) {
    logFile = null;
  }
```

For the ledger the equivalent is a factory taking the resolved store dir — `createLedger({ file })`
per RESEARCH.md, injected from `storage.resolveStoreDir()` so the ledger **moves with the store**
(COMP-02 must copy `dictata-audit.ndjson`).

**Append + never-throw pattern** (`src/main/logger.js:40-47`):

```js
function write(level, args) {
  if (!logFile) return;
  try {
    const line = `[${new Date().toISOString()}] ${level} ${args.map(fmt).join(' ')}`;
    rotate();
    fs.appendFileSync(logFile, line + '\n');
  } catch { /* logging must never throw */ }
}
```

The ledger's `append(row)` must be the same shape: `try { fs.appendFileSync(file, JSON.stringify(row) + '\n') } catch { /* auditing must never break dictation */ }`.
The catch-block-explains-why rule is enforced by conventions ("Intentionally ignored errors say why").

**Defensive rotation analogue** (`src/main/logger.js:49-57`) — `rotate()` wraps everything in
`try/catch` because the file may not exist yet. Use the same tolerance in `read()` (skip a trailing
partial line) and `clear()` (`fs.writeFileSync(file, '')`).

**Constructor option style** (`src/main/store.js:95-106`):

```js
class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'dictata.json');
    ...
  }
```

become `constructor(opts = {}) { this.file = opts.file || path.join(...); }` — the repo's
`opts` + `??`/`||` defaulting convention (`CONVENTIONS.md` "Constructor options are always named `opts`").

---

### `src/main/storage.js` (service, file-I/O + CRUD)

**Analog:** `src/main/store.js` — the only existing module that resolves a path, reads/writes a JSON
document atomically, and migrates a legacy file.

**Atomic write, to be reused for the pointer file** (`src/main/store.js:126-141`):

```js
  _save() {
    this._ensureDecrypted();
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const settings = { ...this.data.settings };
        settings.apiKey = encryptSecret(settings.apiKey || '');
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ ...this.data, settings }, null, 2));
        fs.renameSync(tmp, this.file);
      } catch (e) {
        console.error('[store] save failed:', e.message);
      }
    }, 150);
  }
```

For `storage.js` the pointer write must be **immediate and fsynced** (no debounce), but the same
`tmp` + `renameSync` two-step applies. `storage.json` lives in `userData`, never in the store dir.

**Legacy-adoption / "never crash on startup" pattern** (`src/main/store.js:96-106`):

```js
    // Defensive: adopt the pre-rename store if the migration did not run.
    const legacy = path.join(app.getPath('userData'), 'voice-flow.json');
    try {
      if (!fs.existsSync(this.file) && fs.existsSync(legacy)) fs.copyFileSync(legacy, this.file);
    } catch { /* start fresh rather than crash */ }
```

This is the precedent for "resolve-before-construct" bootstrapping and for refusing to throw from a
filesystem probe. Use the same `try/catch` discipline in `resolveStoreDir()`: a corrupt or
unreadable `storage.json` must fall back to `userData`, not abort launch.

**Module-tag logging** (`src/main/store.js:58`, `:70`, `:122`, `:138`):

```js
console.warn('[store] safeStorage unavailable:', e.message);
console.error('[store] save failed:', e.message);
```

Use `[storage]` / `[ledger]` / `[retention]` tags, never the whole error object.

**Error messages:** UI-facing, em dash + remedy (`CONVENTIONS.md` "Error Handling"), e.g.
`'That folder already holds a Dictata record — pick another'`.

**Do not copy `renameSync` for the move itself** — `store.js:136` is safe only because both paths
are in one directory. `storage.moveStore()` must be copy → readback-verify → pointer commit →
delete (RESEARCH Q4, Pitfall 6).

---

### `test/retention.test.js` (test, pure/transform)

**Analog:** `test/ptt.test.js` — clock injection, no I/O.

**Clock harness** (`test/ptt.test.js:1-17`):

```js
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
```

Copy: `const test = require('node:test'); const assert = require('node:assert');`, relative
`require('../src/main/retention')`, descriptive sentence-style test names, `assert.deepEqual` on
whole result objects. Required cases (RESEARCH "Test Plan"): `cutoffFor(0) === null`, 30 days at a
fixed clock, DST boundary, `splitExpired` keeps boundary-equal rows.

---

### `test/exporter.test.js` (test, pure/transform)

**Analog:** `test/analytics.test.js` — pure assertions with a local `entry()` factory.

**Fixture factory + assertion style** (`test/analytics.test.js:1-41`):

```js
const test = require('node:test');
const assert = require('node:assert');

const { summarize, wordCount, normalizeError } = require('../src/main/analytics');

function entry(over = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    raw: 'raw text here',
    cleaned: 'Raw text here',
    durationMs: 5000,
    ...
    ...over,
  };
}

test('totals words, sessions and speaking time', () => {
  const s = summarize({ history: [entry({ cleaned: 'one two three' }), ...] });
  assert.equal(s.totals.words, 5);
```

Required assertions: BOM bytes (`EF BB BF`), quoted comma/quote/CRLF-in-cell, `=SUM` becomes
`'=SUM`, ISO timestamps, one row per history entry (RESEARCH Q6 / Test Plan).

---

### `test/ledger.test.js` (test, file-I/O)

**Analog (structure):** `test/dashboard.test.js` `withServer` — an async setup/teardown wrapper with
`try/finally`, the only I/O-using test harness in the repo.

```js
// test/dashboard.test.js:23-32
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
```

Copy the shape as `withLedger(fn)` → `fs.mkdtempSync(path.join(os.tmpdir(), 'dictata-ledger-'))`,
`try { await fn(ledger, dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }`.
**There is no existing temp-dir test in this repo** (grep for `tmpdir|mkdtemp` under `test/` returns
nothing) — this harness is genuinely new; model the teardown discipline on `withServer`, not on a
nonexistent file.

Also assert the privacy invariant literally: `assert.equal('raw' in row, false)` /
`assert.equal('cleaned' in row, false)`.

---

### `src/main/store.js` (model, CRUD) — self-extend

Extend, don't replace. Concretely:

- **Constructor `dir` option** — `src/main/store.js:95-106` currently hardcodes
  `path.join(app.getPath('userData'), 'dictata.json')`. Change to `constructor(opts = {})` with
  `this.dir = opts.dir || app.getPath('userData')`, keeping the legacy `voice-flow.json` adoption at
  `userData` (RESEARCH Q4 §373).
- **`flush()`** — extract the body of the `setTimeout` in `_save()` (`:129-140`) into `_writeNow()`;
  `_save()` = debounce → `_writeNow()`; `flush()` = `clearTimeout` + `_writeNow()`.
- **`_recomputeStats()`** — private helper following the `_load` / `_save` / `_ensureDecrypted`
  underscore convention (`:108`, `:116`, `:126`). Call it at the end of `_load()`, `addHistory()`,
  `purgeEntry()`, `clearAll()`, `purgeExpired()`. Nothing else may touch `this.data.stats`.
- **Collector return shapes** — mirror `addHistory`'s unshift + cap idiom (`:181-189`) for
  `purgeEntry(id)` returning `{ removed, wasLast, ids }` (conventions: "Return explicit result
  objects rather than booleans where more than one fact matters").
- **`clearAll()` is an allow-list** — touch `history`, id-matching `events`, `stats` only. Never
  rebuild from `DEFAULTS` (that would wipe `settings`, `dashboardToken`, `dictionary`,
  `replacements`; the token contract is documented at `:162-172`).
- Keep `module.exports = { Store, DEFAULTS, mergeDefaults, encryptSecret, decryptSecret }` (`:204`)
  and export any new pure helper alongside it.

**`DEFAULTS` addition** (`src/main/store.js:11-35`): add `retentionDays: 0` with a trailing `//`
comment (the file annotates every setting this way), and add `storage` facts nowhere — the pointer
lives in `storage.json`, not here.

---

### `src/main/events.js` (store, event-driven) — self-extend

**Analog is the file itself.** `clear()` (`:67-69`) is the precedent for a bulk buffer mutation;
`recent()` (`:57-60`) shows the `filter` + `includes` idiom to mirror in reverse:

```js
  /** The most recent events, newest first. */
  recent(n = 100, types = null) {
    const list = types ? this.buffer.filter((e) => types.includes(e.type)) : this.buffer;
    return list.slice(-n).reverse();
  }

  /** Only the events that are worth persisting. */
  persistable() {
    return this.buffer.filter((e) => PERSISTED_TYPES.has(e.type));
  }

  clear() {
    this.buffer = [];
  }
```

Add `forget(id)` / `forgetMany(ids)` as `this.buffer = this.buffer.filter((e) => !ids.has(e.id))`
(same one-line mutator style), and JSDoc each with the `/** ... */` one-liner used by `clear()`.
Keep `module.exports = { EventBus, PERSISTED_TYPES }` (`:72`).

---

### `src/main/analytics.js` (utility, pure/transform) — self-extend

Add `computeStats(history)` next to `summarize`. Copy the totals loop verbatim from
`summarize` (`src/main/analytics.js:59-60`) so the two can never disagree:

```js
  const words = entries.reduce((n, h) => n + wordCount(h.cleaned || h.raw), 0);
  const msSpoken = entries.reduce((n, h) => n + (h.durationMs || 0), 0);
```

Prefer stored `h.words` when finite, fall back to `wordCount(h.cleaned || h.raw)` (rows written
before `entry.words` existed — `src/main/main.js:470`). Export it in the existing bottom
`module.exports` (`:139`). `summarize()`'s shape must not change — `lifetimeWords: stats.words || 0`
(`:129`) starts agreeing with `totals.words` once `stats` is derived.

---

### `src/main/dashboard.js` (controller/router, request-response) — self-extend

**Analog is `_handle` itself.** The auth/order contract to preserve (`src/main/dashboard.js:161-201`):

```js
  async _handle(req, res) {
    const url = new URL(req.url, `http://${HOST}:${this.port}`);
    const pathname = url.pathname;

    // Block DNS rebinding: only accept requests addressed to us.
    if (!this._hostAllowed(req.headers.host)) {
      return this._json(res, 403, { error: 'Host not allowed' });
    }

    if (pathname === '/api/events') {
      if (!this._authorised(url)) return this._json(res, 401, { error: 'Bad token' });
      return this._events(req, res);
    }

    if (pathname === '/api/state') {
      if (!this._authorised(url)) return this._json(res, 401, { error: 'Bad token' });
      return this._json(res, 200, this._state());
    }

    if (pathname === '/api/history') {
      if (!this._authorised(url)) return this._json(res, 401, { error: 'Bad token' });
      return this._json(res, 200, { history: this.store.snapshot().history });
    }

    // Static files
    ...
```

New routes go **between** `GET /api/history` and the `// Static files` comment. Order is
non-negotiable: `_hostAllowed` → method+path → `_authorised` → id validation → callback
(RESEARCH Q7 list). Note `GET /api/history` is currently method-agnostic, so splitting
`DELETE /api/history` requires adding `req.method === 'GET'` to the existing branch or placing the
DELETE branch **before** it.

Helpers to reuse verbatim (`:203-212`, `:268-275`):

```js
  _hostAllowed(host) {
    if (!host) return false;
    const allowed = [`${HOST}:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
    return allowed.includes(host);
  }

  _authorised(url) {
    const token = url.searchParams.get('token');
    return !!token && token === this.token;
  }
  ...
  _json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  }
```

**Dependency injection contract** (`:79-89`): callbacks are constructor opts, like `store`/`bus`:

```js
  constructor(opts = {}) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.port = opts.port ?? DEFAULT_PORT;
```

Add `onPurge`, `onClearAll`, `onOpenSettings`, `getPrivacyFacts` the same way so
`test/dashboard.test.js`'s `fakeStore()` harness can assert them without Electron.

**`_state()` privacy facts** (`:214-237`): add a read-only block inside the returned object
(`retentionDays`, resolved store dir, `auditCount`) — D-02 facts. Derive them from injected
callbacks, not from `fs` inside the handler.

Also update the module header route list (`:7-10`) — conventions require the file to state its purpose.

---

### `src/main/main.js` (orchestrator, request-response + event-driven) — self-extend

**The three existing anchors to extend:**

1. **`before-quit` flush** (`src/main/main.js:149-154`):

```js
app.on('before-quit', () => {
  hotkeys.stop();
  recorder.cancel();
  winHelper.stop();
  dashboard.stop();
});
```

Add `store.flush()` first. Pitfall 2: without it a delete inside the 150 ms debounce is lost.

2. **`notifyHistory()`** (`:563-567`) — the single refresh channel for the History window; the delete
   path must call it instead of letting the renderer filter its own array:

```js
function notifyHistory() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.webContents.send('vf:history-updated', store.snapshot().history);
  }
}
```

3. **IPC registration block** (`:617-620`) — replace the direct-store calls with the shared path:

```js
  // History
  ipcMain.handle('vf:delete-history', (_e, id) => store.deleteHistory(id));
  ipcMain.handle('vf:clear-history', () => store.clearHistory());
  ipcMain.handle('vf:paste-entry', (_e, text) => pasteInto(text));
```

becomes `ipcMain.handle('vf:delete-history', (_e, id) => purgeEntry(id));` etc. New handlers
(`vf:set-retention`, `vf:data-info`, `vf:choose-storage-dir`, `vf:export-history`, `vf:export-audit`,
`vf:clear-audit`) join the same block. Follow the `vf:` prefix convention; `dialog` must be added to
the destructured `require('electron')` at `:14`.

**IPC-handler consequence pattern to copy** — `vf:update-settings` (`:577-599`) shows how one patch is
fanned out to subsystems, then the renderer gets the new value back:

```js
  ipcMain.handle('vf:update-settings', (_e, patch) => {
    const next = store.updateSettings(patch);
    if ('launchAtLogin' in patch) applyLoginItem();
    if ('maxRecordingSec' in patch) applyRecorderLimits();
    ...
    return next;
  });
```

`vf:set-retention` should look the same: update → clamp to `RETENTION_CHOICES` → `sweepRetention()` →
return the new value.

**Pipeline call sites** (`:449-480`) — capture `appName` (already computed at `:403`) into the ledger
row, then after `store.addHistory(entry)` (`:471`) call `sweepRetention()` **before**
`bus.publish('dictation', ...)` (`:474`), and `ledger.append(...)`. The catch block (`:500-509`) is
where the `failed` ledger row goes; it must not throw:

```js
  } catch (err) {
    if (err?.message === 'Cancelled') {
      console.log('[pipeline] cancelled');
      bus.publish('info', { message: 'Dictation cancelled', kind: 'cancel' });
      return;
    }
```

Cancellations are excluded from the ledger (research A3) but still excluded from the timeline,
matching `src/dashboard/app.js:388`.

**Singleton bootstrap ordering** (`:78-90`): `const store = new Store();` must become
`const storage = new Storage(...); const store = new Store({ dir: storage.resolveStoreDir() });`
**before** `new DashboardServer(...)`, because the store is module-level and cannot be re-created.

**`error`/`info` persistence hook** (`:100-102`) — the precedent for "every new bus event type gets a
persistence decision here":

```js
bus.on('event', (event) => {
  if (event.type === 'error' || event.type === 'info') store.addEvent(event);
});
```

Delete/clear `info` events (`kind: 'history'`) will be persisted by this hook automatically — keep
`kind` so the dashboard can filter them out of the timeline if needed.

**Single mutation path** (new, in this file): `purgeEntry`, `clearAll`, `sweepRetention`,
`rederiveLast` per RESEARCH.md "Code Examples". They are the *only* functions allowed to call
`store.purgeEntry/clearAll/purgeExpired` + `bus.forget*` + `notifyHistory()` + `updateTrayMenu()`.

---

### `src/renderer/settings.html` (component/view) — self-extend

**Analog is the existing panel/nav structure.** Nav (`src/renderer/settings.html:253-260`):

```html
  <nav>
    <h1>⚡ Dictata</h1>
    <button class="nav-btn active" data-panel="general">General</button>
    <button class="nav-btn" data-panel="shortcuts">Shortcuts</button>
    <button class="nav-btn" data-panel="ai">AI &amp; Style</button>
    <button class="nav-btn" data-panel="dictionary">Dictionary</button>
    <button class="nav-btn" data-panel="stats">Stats</button>
  </nav>
```

Add a sixth button `data-panel="privacy"` labelled "Privacy &amp; Data". The panel container pattern
(`:350-366`) and the section/row pattern (`:268-282`, `:286-292`):

```html
    <div class="panel" id="panel-shortcuts">
      <h2>Shortcuts</h2>
      <div class="section">
        <div class="section-title">Current bindings</div>
        <div class="row"><label>Push-to-talk</label><span id="sc-ptt"></span></div>
        ...
      </div>
```

```html
        <div class="row">
          <label>Keyboard shortcut</label>
          <select id="pasteMethod">
            <option value="ctrl-v">Ctrl + V</option>
            <option value="shift-insert">Shift + Insert</option>
          </select>
        </div>
```

Reuse: `.section` / `.section-title` / `.row` / `.hint` / `.btn` / `.btn.secondary` / `select` /
`kbd`. Existing precedent for a button row (`:305-310`) covers the four export buttons + "Change…".
Panel ids are kebab-case (`panel-general`, `panel-privacy`) — `CONVENTIONS.md` "DOM ids".

The `kbd`-annotated explanatory section (`:360-365`) is the precedent for the copy that must state
"already-pasted text and the Windows clipboard are outside Dictata's control".

---

### `src/renderer/settingsRenderer.js` (component/renderer) — self-extend

**Nav wiring is generic — nothing to add** (`src/renderer/settingsRenderer.js:15-22`):

```js
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.panel}`).classList.add('active');
  });
});
```

Only `init()` (`:5-12`) needs a `loadPrivacy();` line.

**Bind + save idiom** (`:25-38`, `:203-217`):

```js
function loadGeneral() {
  const s = data.settings;
  bind('doubleTap',       s.doubleTapLocks,      (v) => save({ doubleTapLocks: v }));
  ...
  bindSelect('pasteMethod',s.pasteMethod,        (v) => save({ pasteMethod: v }));
  ...
}

async function save(patch) {
  data.settings = await window.vf.updateSettings(patch);
}

function bindSelect(id, initial, onChange) {
  const el = document.getElementById(id);
  el.value = initial;
  el.addEventListener('change', () => onChange(el.value));
}
```

Copy for `retentionDays` (a `bindSelect`), and for the storage path use read-only text +
`window.vf.chooseStorageDir()` (async, then re-render) instead of `bindText`.

**Async callback precedent for a non-form action** (`:49-53`) — this is the model for export buttons
(invoke → show the returned message in a status element):

```js
  document.getElementById('testDashboard')?.addEventListener('click', async () => {
    await window.vf.dashboardTest();
    const el = document.getElementById('dashboardUrl');
    if (el) el.textContent = 'Test event sent — watch the page.';
  });
```

Escaping: `esc()` here is minimal (`:239-241`) — it covers `& < >` only. Do not interpolate
user-controlled text with it; use `textContent` for the resolved storage path.

---

### `src/renderer/settingsPreload.js` (preload/bridge) — self-extend

**Analog is the whole file** (`src/renderer/settingsPreload.js:1-14`):

```js
// Settings window preload
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vf', {
  getStore: () => ipcRenderer.invoke('vf:get-store'),
  updateSettings: (patch) => ipcRenderer.invoke('vf:update-settings', patch),
  testKey: (key) => ipcRenderer.invoke('vf:test-key', key),
  ...
});
```

Append one arrow per channel, same naming (`chooseStorageDir`, `dataInfo`, `exportHistory`,
`exportAudit`, `clearAudit`). Never expose `ipcRenderer` itself (`CONVENTIONS.md` "Preload bridges").
Remember the three-place rule: preload + `ipcMain.handle` in `main.js` + renderer caller.

---

### `src/renderer/historyRenderer.js` (component/renderer, CRUD) — self-extend

**The exact code to change** (`src/renderer/historyRenderer.js:41-50`):

```js
  // Events
  list.querySelectorAll('.entry-btn.paste').forEach((btn) => {
    btn.addEventListener('click', () => window.vf.pasteEntry(btn.dataset.text));
  });

  list.querySelectorAll('.entry-btn.del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await window.vf.deleteHistory(btn.dataset.id);
      btn.closest('.entry').remove();
    });
  });
```

Delete the local `.remove()` — DATA-03/D-09 requires the authoritative `vf:history-updated` push
(`src/renderer/historyRenderer.js:9` `window.vf.onHistoryUpdated(render)`) to re-render. Keep the
`await window.vf.deleteHistory(id)` call; it now routes to `purgeEntry`.

**Clear flow** (`:58-62`) already uses a native `confirm` — acceptable here (unlike the dashboard),
but the label must name the count per D-10:

```js
document.getElementById('btn-clear').addEventListener('click', async () => {
  if (!confirm('Clear all dictation history?')) return;
  await window.vf.clearHistory();
  render([]);
});
```

Drop `render([])` for the same reason (the push re-renders), or keep it as an optimistic paint followed
by the push.

Row-building style to preserve (`:17-38`): `document.createElement`, `el.innerHTML` with every
user string through `esc()` (`payload: ${esc(item.cleaned || item.raw)}` at `:30`), `list.insertBefore(el, empty.nextSibling)`.

---

### `src/renderer/historyPreload.js` (preload/bridge) — verify only

No new channel is strictly required (`deleteHistory` / `clearHistory` / `onHistoryUpdated` already
exist, `:4-11`):

```js
contextBridge.exposeInMainWorld('vf', {
  getStore: () => ipcRenderer.invoke('vf:get-store'),
  deleteHistory: (id) => ipcRenderer.invoke('vf:delete-history', id),
  clearHistory: () => ipcRenderer.invoke('vf:clear-history'),
  pasteEntry: (text) => ipcRenderer.invoke('vf:paste-entry', text),
  onHistoryUpdated: (cb) => ipcRenderer.on('vf:history-updated', (_e, d) => cb(d)),
  openSettings: () => ipcRenderer.send('vf:open-settings'),
});
```

If a "delete failed attempt" channel is added, follow this exact one-liner + `invoke` shape.

---

### `src/dashboard/index.html` (view) — self-extend

**Analog is the history panel head** (`src/dashboard/index.html:128-134`):

```html
        <section class="panel" data-panel="history" hidden>
          <div class="panel-head">
            <h2 class="panel-title">Your dictation history</h2>
            <p class="panel-sub" id="historySub"></p>
          </div>
          <div class="history" id="history"></div>
        </section>
```

Clear-all control + the read-only privacy facts block (D-02) go inside `.panel-head` as siblings of
`#historySub`, using existing classes only (`.btn`, `.btn-quiet`, `.card-meta`, `.chip`). Rows are
built in JS, so **no per-row markup goes in the HTML** — matches `#history` being an empty mount point.

`test/page.test.js:20-35` asserts every `$('#id')` in `app.js` exists in `index.html` and that
`data-tab`s exactly equal `data-panel`s — add ids in both files in the same edit.

---

### `src/dashboard/app.js` (browser controller, request-response + SSE) — self-extend

**Escaping — non-negotiable** (`src/dashboard/app.js:71-75`):

```js
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
```

Every interpolated id/text in the new delete markup passes through `esc()` — the id is a UUID but
`data-id` is still an interpolation (`esc(...)` at `:116`, `:428`, `:443` are the precedents).

**Row builder to extend** (`src/dashboard/app.js:424-452`) — this is the exact place the trash button
and inline confirm are inserted. Note the two branches: `error` rows (`:425-435`) and dictation rows
(`:445-451`); D-07 requires the affordance on **both**.

```js
    const rows = items.map((e) => {
      if (e.type === 'error') {
        return `<div class="rec is-problem">
          <div class="rec-time">${fmtClock(e.ts)}</div>
          <div class="rec-problem" title="${esc(e.message)}">
            ...
            <span>${esc(problemLabel(e.message))}</span>
          </div>
        </div>`;
      }
      ...
      return `<div class="rec">
        <div class="rec-time">${fmtClock(e.ts)}</div>
        <div>
          <p class="rec-text">${esc(e.text || e.cleaned || '')}</p>
          ${chips.length ? `<div class="rec-meta">${chips.join('')}</div>` : ''}
        </div>
      </div>`;
    }).join('');
```

Add a third cell: `<button class="rec-del" type="button" data-id="${esc(e.id)}" aria-label="Delete this dictation">…svg…</button>`.
`e.id` exists on both row kinds because `timeline()` keys by id (`:380-390`).

**State object is the only place confirm state may live** (`:18-29`):

```js
const state = {
  app: { state: 'idle', model: null, shortcuts: null, handsFree: false },
  analytics: null,
  events: [],
  history: [],
  ...
  tab: 'live',
};
```

Add `confirmId: null` and `confirmClear: false` here — `renderHistory()` rebuilds `innerHTML`
(`:460`) and a 5 s interval re-renders the history tab (`:786-790`), so closure or DOM state is
destroyed every 5 s (Pitfall 5).

**Delegated listener precedent** — the existing per-element wiring at `:339-341` and `:768-778`
attaches once at load. For rows, delegate on `#history` (`e.target.closest('.rec-del')`) because rows
are recreated on each render.

**Authoritative refresh after a mutation** — `loadState()` (`:157-173`) already assigns
`state.events`/`state.history` and calls `renderAll()`; call it after the DELETE resolves (RESEARCH
"Dashboard DELETE call (app.js)"). Token is in the query string exactly as `loadState` does:
`?token=${encodeURIComponent(token)}`.

**Tab-switch reset** (`:320-337`) — clear `confirmId` here (`setTab`) plus on Escape, matching Q8 §5.

---

### `src/dashboard/styles.css` (styles/config) — self-extend

**Row grid — the third column changes here** (`src/dashboard/styles.css:449-464`):

```css
.rec {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 18px;
  padding: 18px 22px;
  border-top: 1px solid var(--line-soft);
}
.rec:first-child { border-top: 0; }

.rec-time {
  font-size: 12.5px; color: var(--muted);
  padding-top: 3px;
  font-variant-numeric: tabular-nums;
}
.rec-text { font-size: 15px; line-height: 1.65; color: var(--ink); white-space: pre-wrap; }
.rec-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
```

Change to `grid-template-columns: 96px minmax(0, 1fr) 32px;` and add `.rec-del` with `opacity: 0`,
revealed by `.rec:hover`, `.rec:focus-within`, `.rec-del:focus-visible`. **Never `display:none` or
`visibility:hidden`** (Pitfall 4). Include `@media (hover: none) { .rec-del { opacity: 1 } }` and
`@media (prefers-reduced-motion: reduce) { .rec-del { transition: none } }` — `test/page.test.js:59-65`
requires ≥3 breakpoints and a `prefers-reduced-motion` rule, and the file must keep one at ≤620px.

**Tokens only** (`:7-39`): `var(--muted)`, `var(--orange)`, `var(--ink)`, `var(--line-soft)`,
`var(--radius)`. Focus ring precedent (`:91`):

```css
:focus-visible { outline: 2px solid var(--orange); outline-offset: 2px; border-radius: 6px; }
```

`.chip` (`:410-417`) is the style to reuse for the privacy facts (retention window, storage path).

---

### `test/store.test.js` (test, CRUD) — self-extend

Keep the existing pure-`mergeDefaults` style (`test/store.test.js:1-13`):

```js
// Unit tests for the settings merge logic.
const test = require('node:test');
const assert = require('node:assert');
const { mergeDefaults, DEFAULTS } = require('../src/main/store');

test('an empty file yields the defaults', () => {
  const s = mergeDefaults({});
  assert.equal(s.settings.model, DEFAULTS.settings.model);
```

New cases need a `Store` instance, which requires `electron` (`store.js:6`). **The repo has no
Electron mock** — therefore put the mutation-path logic in testable pure helpers where possible
(`computeStats`, `splitExpired`) and test `purgeEntry`/`clearAll` semantics against a plain object
shaped like `this.data` (same technique as `test/dashboard.test.js`'s `fakeStore`, `:9-21`).
Assert exactly what the plan states: `settings`, `dashboardToken`, `dictionary`, `replacements`
survive `clearAll`; `stats.words` equals the sum of retained rows after a cap overflow; `mergeDefaults`
returns `retentionDays: 0` for an old file.

---

### `test/dashboard.test.js` (test, request-response) — self-extend

**Harness to reuse** (`test/dashboard.test.js:9-32`):

```js
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
```

**Auth assertion style** (`:60-84`) — copy for the new routes: no token → 401, wrong token → 401,
valid token → the callback runs. Required cases (RESEARCH Test Plan): `DELETE /api/history/:id`
200/404/401, bad id → 400, `DELETE /api/history` count, `POST /api/settings/open` invokes the
callback, and **a GET to a DELETE-only path falls through to static 404, never to a mutation**.

`fetch(url, { method: 'DELETE' })` on `server.baseUrl` — `port: 0` gives a free port (`:25`).

---

### `test/page.test.js` (test, static assertions) — self-extend

**The id-existence guard** (`test/page.test.js:20-35`) is what will catch a mis-wired delete control:

```js
test('every element the client looks up exists in the markup', () => {
  const ids = new Set([...js.matchAll(/\$\$?\('#([\w-]+)'\)/g)].map((m) => m[1]));
  ...
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, [], `app.js references ids that index.html does not define: ${missing.join(', ')}`);
});
```

Because of this, if `app.js` references `$('#privacyFacts')` it must exist in `index.html` **in the
same commit**. Also extend the no-absolute-origin test (`:51-57`) — the "Open Settings" control must
use a relative URL (`POST /api/settings/open`), never `http://…`.

---

### `test/analytics.test.js` (test, transform) — self-extend

Add `computeStats` cases beside the existing totals tests (`test/analytics.test.js:30-48`), reusing
the `entry()` factory (`:10-21`). Key assertion for D-06: for any history array,
`computeStats(history).words === summarize({ history }).totals.words`.

---

## Shared Patterns

### 1. Module header comment (every new main-process module)

**Source:** `src/main/ptt.js:1-17`, `src/main/analytics.js:1-7`, `src/main/dashboard.js:1-15`,
`src/main/logger.js:1-8`, `src/main/store.js:1-5`.
**Apply to:** `retention.js`, `exporter.js`, `ledger.js`, `storage.js`, and the route-list update in
`dashboard.js`.

```js
/**
 * analytics.js — pure aggregation of the activity data.
 *
 * No Electron, no I/O: the dashboard server and the tests both use this,
 * so the numbers on the page and the numbers in the tests can never drift
 * apart.
 */
```

State the reason the module is separate and the invariant it protects.

### 2. Error handling: catch at the boundary, log tag + message, never throw upward

**Source:** `src/main/store.js:57-59`, `:69-72`; `src/main/logger.js:46`.
**Apply to:** `ledger.append`, `storage.moveStore`, `main.js` delete/export handlers.

```js
  } catch (e) {
    console.warn('[store] safeStorage unavailable:', e.message);
  }
```

```js
  } catch { /* logging must never throw */ }
```

`ledger.append` must never break the dictation pipeline; a failed move must return
`{ moved: false, message }` rather than reject into the renderer. Non-fatal problems become
`bus.publish('error', { ..., fatal: false })` + `notifyError(...)` (`src/main/main.js:203-210`, `:494-498`).

### 3. Dashboard security gate order

**Source:** `src/main/dashboard.js:161-212`.
**Apply to:** `DELETE /api/history/:id`, `DELETE /api/history`, `POST /api/settings/open`.

`_hostAllowed(req.headers.host)` → 403 first, then method+path, then `_authorised(url)` → 401, then
validate the id (`/^[0-9a-f-]{36}$/i`) before it reaches `Map`/`filter`. Never decode a matched UUID.

### 4. IPC three-place wiring

**Source:** `src/renderer/settingsPreload.js:4-14` + `src/main/main.js:570-620` + `settingsRenderer.js` callers.
**Apply to:** every new Settings action.

Channel names `vf:*`; handler in `setupIPC()`; bridge method on `window.vf`. A change that touches
only two of the three is a runtime `undefined`.

### 5. Escaping at every `innerHTML` interpolation

**Source:** `src/dashboard/app.js:71-75`, `src/renderer/historyRenderer.js:80-82`,
`src/renderer/settingsRenderer.js:239-241`.
**Apply to:** delete-control markup, confirm prompt copy, privacy facts (prefer `textContent` for
paths).

### 6. Pure core, I/O shell

**Source:** `src/main/analytics.js:1-7`, `src/main/ptt.js:2`, `src/main/dashboard.js:22`.
**Apply to:** `retention.js`, `exporter.js` (pure, `node:test`-able) vs. `ledger.js`, `storage.js`
(fs/Electron).

`README.md:110-112` and `CONVENTIONS.md` both state this rule; a `require('electron')` in
`retention.js` or `exporter.js` is a defect.

### 7. Atomic persistence

**Source:** `src/main/store.js:129-140`.
**Apply to:** the `storage.json` pointer.

`write tmp` → `renameSync`. For the store itself, destructive mutations call `flush()` (new) because
the 150 ms debounce silently loses a delete followed by quit.

### 8. Test style

**Source:** `test/*.test.js` — `node:test` + `node:assert`, `// Unit tests for …` header, sentence-style
test names, `assert.deepEqual` for whole shapes, `try/finally` teardown for anything with a resource
(`test/dashboard.test.js:23-32`), clock injection instead of sleeping (`test/ptt.test.js:7-10`).

---

## No Analog Found

Files (or sub-patterns) with no close match in the codebase — the planner should use the RESEARCH.md
snippets rather than inventing a repo precedent.

| File / pattern | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `storage.moveStore()` (copy → readback-verify → pointer commit → delete + `pendingDelete` journal) | service | file-I/O | The only existing move is `fs.renameSync` inside one directory (`src/main/store.js:136`) and a one-time `fs.cpSync` migration (`src/main/main.js:51-57`). Neither verifies a readback nor recovers a crash. |
| `dialog.showOpenDialog` / `showSaveDialog` usage | service | request-response | No `dialog` import anywhere in `src/` today (`src/main/main.js:14` destructures `app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, screen, session`). |
| `test/ledger.test.js` temp-directory harness | test | file-I/O | No test in `test/` uses `os.tmpdir` / `mkdtemp` (grep: no matches). Model teardown on `withServer`, but the setup is new. |
| Retention sweep scheduling | orchestrator | batch | No timer/sweep precedent; the single `setInterval` patterns are UI keep-alives (`src/main/dashboard.js:250-252`, `src/main/main.js:411-415`). Sweep is call-site-driven per D-05, not a timer. |
| CSV formatting (BOM, CRLF, RFC 4180 quoting, formula guard) | utility | transform | Nothing in the repo exports files; `JSON.stringify(..., null, 2)` (`src/main/store.js:135`) is the only serialization precedent. |

---

## Metadata

**Analog search scope:** `src/main/`, `src/renderer/`, `src/dashboard/`, `test/` — all git-tracked.
**Files scanned:** 22 read in full or targeted sections (`store.js`, `events.js`, `analytics.js`,
`logger.js`, `ptt.js`, `dashboard.js`, `main.js`, `dashboard/app.js`, `dashboard/index.html`,
`dashboard/styles.css`, `renderer/settings.html`, `renderer/settingsRenderer.js`,
`renderer/settingsPreload.js`, `renderer/historyPreload.js`, `renderer/historyRenderer.js`,
`renderer/history.html`, `test/store.test.js`, `test/dashboard.test.js`, `test/analytics.test.js`,
`test/page.test.js`, `test/ptt.test.js`, plus `.planning/codebase/CONVENTIONS.md`).
**Tracked-source verification:** `git ls-files -- <each analog>` returned every path above; no
gitignored mirror paths are referenced.
**Pattern extraction date:** 2026-10-22
