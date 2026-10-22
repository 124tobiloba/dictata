---
last_mapped_commit: 0439ed1ae6b93347340f8af55ab3cb3f630a64f4
last_mapped_at: 2026-10-22
---
# Coding Conventions

**Analysis Date:** 2026-10-22

## Naming Patterns

**Files:**
- Main-process modules use camelCase nouns: `src/main/gemini.js`, `src/main/recorder.js`, `src/main/winhelper.js`, `src/main/events.js`.
- Renderer windows use a three-file set: `<name>.html`, `<name>Renderer.js`, `<name>Preload.js` (for example `src/renderer/status.html`, `src/renderer/statusRenderer.js`, `src/renderer/statusPreload.js`).
- Tests are named after the module they cover with a `.test.js` suffix: `test/ptt.test.js`, `test/store.test.js`, `test/dashboard.test.js`.
- HTML entry files are lowercase single words: `src/dashboard/index.html`, `src/renderer/settings.html`.
- Scripts under `scripts/` use kebab-case verbs: `test-api.js`, `test-paste.js`, `mic-probe.js`.

**Functions:**
- camelCase, verb-first: `encodeWav`, `mergeDefaults`, `buildSystemPrompt`, `publishPartial`, `setState`, `openDashboard`.
- Event handlers use an `on` prefix: `onRecordingDone`, `onPartial`, `_onData`, `_onEvent`.
- Class-private helpers use a leading underscore: `_load`, `_save`, `_ensureDecrypted`, `_buildWav`, `_register`, `_cmd`, `_handle`.
- Pure exported helpers are named after the exact operation, not the class (`mergeDefaults`, not `Store.merge`).

**Variables:**
- camelCase throughout: `lastCleaned`, `activeAbort`, `sessionId`, `targetPromise`, `dashboardToken`.
- Module-level constants use UPPER_SNAKE: `DEFAULT_MODEL`, `TIMEOUT_MS`, `SAMPLE_RATE`, `HISTORY_LIMIT`, `DEFAULT_PORT`.
- Constructor options are always named `opts`; defaults are applied with `??` or `||`.
- Instance fields that are internal are underscore-prefixed: `this._store`, `this._chunks`, `this._recording`, `this._registered`.
- String enum values are lowercase words: `'idle' | 'listening' | 'processing'`, `'polished' | 'casual' | 'verbatim'`. Action values may be kebab-case: `'start-lock'`, `'paste-last'`.

**Types and shapes:**
- Plain JavaScript only — no TypeScript, no Flow, no `.d.ts` files.
- Object shapes are documented with JSDoc on the function or class: see `src/main/ptt.js:21-33`, `src/main/paste.js:58-67`, `src/main/events.js:20-30`.
- State constants are a frozen-by-convention object, not a class: `const STATE = { IDLE: 'idle', LISTENING: 'listening', PROCESSING: 'processing' }` in `src/main/main.js:68`.

**Channels, events and DOM:**
- IPC channels are namespaced with a short prefix: `vf:*` from renderers (`vf:get-store`, `vf:update-settings`, `vf:status`) and `rec:*` for audio (`rec:start`, `rec:chunk`, `rec:done`).
- EventBus event types are lowercase words: `'state'`, `'partial'`, `'level'`, `'dictation'`, `'error'`, `'info'`.
- DOM ids are mostly camelCase for settings fields (`doubleTap`, `restoreClipboard`, `dashboardUrl`, `apiKey`) and kebab-case for compound UI elements (`sc-ptt`, `dict-add`, `panel-general`, `btn-clear`).
- CSS classes are kebab-case: `.entry-meta`, `.duration-badge`, `.stat-icon`, `.shortcut`, `.is-active`.

## Code Style

**Formatting:**
- No formatter configuration exists. There is no `.prettierrc`, `biome.json`, `.editorconfig`, or equivalent.
- Indentation is 2 spaces. No file under `src/`, `test/`, or `scripts/` contains a tab character.
- Line endings are LF, enforced repository-wide by `.gitattributes`: `* text=auto eol=lf`.
- Statements end with semicolons. String literals use single quotes; template literals are used whenever interpolation or multi-line text is needed.
- Multi-line object and array literals use trailing commas (`src/main/store.js:11-44`, `src/main/gemini.js:77-82`).
- `const` is the default; `let` is used only for reassigned module state. There is no `var` in the codebase.
- Modern syntax is used freely: optional chaining (`statusWindow?.webContents`), nullish coalescing (`opts.limit ?? DEFAULT_LIMIT`), object/array spread, `structuredClone`, `async`/`await`, `Array.prototype.at`-free indexing.
- Blank lines separate logical blocks; long files use box-drawing section banners: `// ── State ────────────────────────────────────────────────────────────────────` (`src/main/main.js:67`, `src/dashboard/app.js:31`).

**Linting:**
- No ESLint or Biome configuration detected. Correctness is guarded by tests instead of a linter (`npm test`).
- Keep new code consistent with the existing style: 2-space indent, single quotes, semicolons, trailing commas, no tabs.

**Async style:**
- Prefer `async`/`await` over raw promise chains. The only intentional promise-chain exceptions are sequence helpers (`Promise.resolve(...)`, `Promise.race(...)`) in `src/main/paste.js` and `src/main/winhelper.js`.
- Background work that must not delay the pipeline is launched with an async IIFE inside `setTimeout`, with its own `try/catch` (`src/main/paste.js:92-104`).
- Always pass and honor an `AbortSignal` for cancellable network work (`src/main/gemini.js:76-82`, `src/main/gemini.js:261-268`).

## Import Organization

**Order (enforced by convention, not tooling):**
1. Environment bootstrap — `require('dotenv').config()` first in `src/main/main.js:13`.
2. Node built-ins — `fs`, `path`, `crypto`, `https`, `events`, `child_process`.
3. Electron and third-party packages — `require('electron')` destructured at the top of main-process modules.
4. Local modules — relative `./` requires, grouped after the above (`src/main/main.js:19-28`).

```js
require('dotenv').config();
const { app, BrowserWindow, ipcMain, Tray } = require('electron');
const path = require('path');
const crypto = require('crypto');

const logger = require('./logger');
const { Store } = require('./store');
const { HotkeyService } = require('./hotkeys');
```

- CommonJS only (`require` / `module.exports`). There are no ESM files and no bundler.
- Named exports are preferred and destructured at the import site: `const { encodeWav } = require('./wav')`.
- No path aliases and no barrel/index files. Import the concrete module by relative path.
- Renderer scripts import nothing. They consume the preload bridge as `window.vf` (`src/renderer/statusPreload.js:4`, `src/renderer/settingsPreload.js:4`).

## Error Handling

**Patterns:**
- Throw `Error` with a message written for the UI, using an em dash to add the remedy: `'Missing Gemini API key — add it in Settings'`, `'No audio captured — check microphone'`, `'Gemini timed out after 30s — check internet'` (`src/main/gemini.js:84-85`, `src/main/gemini.js:258`).
- Catch at the boundary and log with a module tag plus `e.message`, never the whole error object: `console.warn('[store] safeStorage unavailable:', e.message)` (`src/main/store.js:58`).
- Intentionally ignored errors say why in the catch block: `catch { /* start fresh rather than crash */ }`, `catch { /* logging must never throw */ }`, `catch { /* the broker may already be gone */ }`.
- Cancellation uses a string sentinel, not a custom error class: `err.message === 'Cancelled'` (`src/main/gemini.js:121`, `src/main/main.js:501`).
- Non-fatal failures are published as `{ fatal: false }` events and surfaced in the tray; fatal pipeline failures are `{ fatal: true }` (`src/main/main.js:207`, `src/main/main.js:496-507`).
- Retryability is centralized in `isRetryable()` in `src/main/gemini.js:285-288`; only 408/429/5xx and network/timeout errors are retried.
- Process-level safety nets are installed once at startup: `uncaughtException` and `unhandledRejection` log and keep the tray app alive (`src/main/main.js:117-123`).
- Cleanup of timers, listeners and servers always happens in `finally` or an explicit `done()` guard (`src/main/gemini.js:182-189`, `test/dashboard.test.js:29-31`).

## Logging

**Framework:** `console.*` only, mirrored to a rolling file by `src/main/logger.js`.

- `logger.init(app)` replaces `console.log`, `console.warn` and `console.error` in the main process; lines are prefixed with an ISO timestamp and INFO/WARN/ERROR level (`src/main/logger.js:27-45`).
- Every log line starts with a bracketed area tag: `[gemini]`, `[pipeline]`, `[recorder]`, `[dashboard]`, `[store]`, `[hotkeys]`, `[paste]`, `[dictata]`, `[rec]`.
- Log decisions, timings and recovery paths, not every function: `console.log(\`[gemini] first token after ${Date.now() - t0} ms\`)` (`src/main/gemini.js:224`), `console.log(\`[pipeline] stop → pasted in ${Date.now() - t0} ms\`)` (`src/main/main.js:473`).
- `console.warn` marks degraded but recoverable behavior (fallback model, unregistered shortcut, clipboard restore failure). `console.error` marks failures that need diagnosis.
- Never log secrets. The Gemini key is passed in request headers and is never printed (`src/main/gemini.js:191-197`).
- The log rotates at 512 KB to `dictata.log.1` and logging never throws (`src/main/logger.js:13`, `src/main/logger.js:49-57`).

## Comments

**When to Comment:**
- Every main-process module opens with a block comment stating its purpose, the reason it is separate, and any key invariant. Examples: `src/main/ptt.js:1-17`, `src/main/wav.js:1-5`, `src/main/sse.js:1-7`, `src/main/dashboard.js:1-15`.
- Explain *why*, especially for workarounds and fragile ordering. Examples: the double-tap explanation (`src/main/ptt.js:3-9`), Electron's async clipboard (`src/main/paste.js:20-24`), why `thinkingConfig` is model-specific (`src/main/gemini.js:44-50`), and why `recording` stays true until the worklet replies (`src/renderer/statusRenderer.js:115-117`).
- Section banners divide long files (`main.js`, `dashboard.js`, `settingsRenderer.js`, `dashboard/app.js`).
- Historical bug notes are acceptable when they prevent regression: `// ...the original bug` (`src/renderer/statusRenderer.js:117`).

**JSDoc/TSDoc:**
- Use JSDoc for exported functions, options objects and return shapes: `@param {object} [opts]`, `@param {AbortSignal} [opts.signal]`, `@returns {Promise<{pasted: boolean}>}`.
- Multi-line JSDoc is block style with one tag per line (`src/main/gemini.js:71-75`, `src/main/dashboard.js:73-78`).
- Trailing `//` comments may annotate individual object fields (`src/main/store.js:14-39`).

## Function Design

**Size:** Pure functions are kept under roughly 50 lines; orchestration functions may exceed that (`onRecordingDone` in `src/main/main.js:387-517`) but delegate every concern to a module.

**Parameters:** More than two parameters use a single destructured options object with defaults:

```js
async function pasteText({ text, html, restore = true, method = 'ctrl-v', hwnd = 0, allowKeys = true }) {
```

**Return Values:** Return explicit result objects rather than booleans where more than one fact matters: `{ action: 'lock', handsFree: true }` (`src/main/ptt.js:60-67`), `{ pasted }` (`src/main/paste.js:106`), `{ text, truncated }` (`src/main/gemini.js:251`). Return `null` for a deliberate no-op (`PttState.cancel()`).

**Dependency injection:** Time, storage, HTTP transport and Electron objects are injectable for tests — `now` in `PttState` (`src/main/ptt.js:26-31`), `store`/`bus` in `DashboardServer` (`src/main/dashboard.js:79-89`). Keep new stateful modules injectable the same way.

## Module Design

**Exports:**
- CommonJS, one `module.exports = { ... }` statement at the bottom of each file.
- Export the pure helpers alongside the class so they can be tested without Electron: `{ Store, DEFAULTS, mergeDefaults, encryptSecret, decryptSecret }` (`src/main/store.js:204`), `{ transcribe, testKey, resolveModel, buildSystemPrompt, buildRequestBody, supportsThinkingLevel, DEFAULT_MODEL, FALLBACK_MODELS }` (`src/main/gemini.js:325-328`).
- Stateful services are classes (`Store`, `Recorder`, `HotkeyService`, `EventBus`, `DashboardServer`) instantiated once as singletons in `src/main/main.js:79-90`. `winHelper` is exported already-instantiated (`src/main/winhelper.js:185`).

**Layering:**
- Pure logic modules must not require `electron`: `ptt.js`, `wav.js`, `sse.js`, `analytics.js`. This is a stated design rule in `README.md:110-112`.
- Electron-facing modules may require Electron: `store.js`, `hotkeys.js`, `recorder.js`, `paste.js`, `dashboard.js`, `logger.js`.
- `src/main/main.js` is the only orchestrator; other modules do not import `main.js` and do not create windows.

**Preload bridges:**
- Every renderer gets its own preload exposing a minimal `window.vf` surface via `contextBridge.exposeInMainWorld`; `ipcRenderer` is never exposed directly (`src/renderer/statusPreload.js:4-22`, `src/renderer/settingsPreload.js:4-14`, `src/renderer/historyPreload.js:4-11`).
- New IPC calls must be added in three places: the preload bridge, the `ipcMain.handle`/`ipcMain.on` registration in `src/main/main.js:570-620`, and the renderer caller.

## UI Conventions

- **No build step.** `src/dashboard/` and `src/renderer/` are plain HTML/CSS/JS loaded directly by Electron or by the local HTTP server. Do not introduce a bundler or framework.
- **Dashboard helpers:** `$` and `$$` are the only selectors (`src/dashboard/app.js:12-13`). Rendering functions are named `render*` (`renderShortcuts`, `renderLive`, `renderHistory`, `renderStats`) and read from a single `state` object (`src/dashboard/app.js:18-29`).
- **Escaping:** Any user-controlled text inserted with `innerHTML` must pass through the local `esc()` helper first (`src/dashboard/app.js:71-75`, `src/renderer/historyRenderer.js:80-82`, `src/renderer/settingsRenderer.js:239-241`).
- **CSS:** All colors and radii come from custom properties defined at `:root` and overridden under the dark theme (`src/dashboard/styles.css:1-40`). Reuse `var(--ink)`, `var(--muted)`, `var(--orange)`, `var(--radius)` rather than hard-coded values.
- **Accessibility:** Interactive state uses `aria-selected`, `aria-hidden` and real focus calls, not class-only signaling (`src/dashboard/app.js:325-330`).
- **Responsive/reduced motion:** The dashboard must keep at least three `@media (max-width: …)` breakpoints, one at ≤620px, and honor `prefers-reduced-motion` — this is asserted by `test/page.test.js:59-65`.

## Security Conventions

- All `BrowserWindow` instances set `contextIsolation: true` and `nodeIntegration: false` (`src/main/main.js:191-195`, `src/main/main.js:224-228`, `src/main/main.js:248-252`).
- External URLs are validated before opening: only `http(s)` strings reach `shell.openExternal` (`src/main/main.js:606-608`).
- The dashboard binds to `127.0.0.1` only, checks the `Host` header against an allowlist, validates the token on every API route, and rejects static paths that escape its root (`src/main/dashboard.js:165-188`, `src/main/dashboard.js:203-212`).
- Secrets are encrypted at rest with Electron `safeStorage` and an `enc:` prefix; plaintext legacy values are still readable and are re-encrypted on the next save (`src/main/store.js:48-73`, `src/main/store.js:126-141`).

---

*Convention analysis: 2026-10-22*
