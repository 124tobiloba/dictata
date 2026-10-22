<!-- GSD:project-start source:PROJECT.md -->

## Project

**Dictata**

Dictata is a Windows dictation app: hold a hotkey, speak, and clean written text appears
in whatever app has focus. It is the open-source alternative to Wispr Flow — you bring
your own Gemini API key, nothing is routed through a Dictata server, and a local
dashboard shows exactly what was said, how long it took, and whether it landed.

The v1.0 audience is **regulated teams** (legal, medical, finance, government
contractors): people who would use dictation all day but cannot send audio to a vendor
they have not vetted, and who need deletion, export, and an audit trail they control.

**Core Value:** **A regulated professional's words never leave their machine except to the model
endpoint they chose — and they can prove it, delete it, and export it at any time.**

If everything else fails, dictation must still be reliable, private by default, and
fully erasable.

### Constraints

- **Tech stack**: Electron 44 + vanilla JS/HTML/CSS; no framework or bundler — keeps the OSS contribution surface small.
- **Platform**: Windows 10/11 x64 only for v1.0; clipboard-paste and `SetForegroundWindow` behaviour is Windows-specific.
- **Privacy**: transcripts and audio must never be written to a remote service, and audio must not be persisted to disk by default.
- **Compliance**: regulated buyers need deletable, exportable data and a written data-flow statement before pilots.
- **Distribution cost**: code signing certificates and auto-update infrastructure are real recurring costs — they justify the Pro tier.
- **Licensing**: MIT core with a proprietary Pro module; the brand and trademark are the defensible asset.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->

## Technology Stack

## Languages

- JavaScript (Node.js, CommonJS `require`/`module.exports`) — all main-process modules, scripts, and tests. No TypeScript, no ESM, no transpilation.
- JavaScript (browser/DOM) — renderer windows (`src/renderer/*.js`) and the local dashboard (`src/dashboard/app.js`), loaded directly by `<script src>` with no build step.
- HTML5 — `src/renderer/status.html`, `src/renderer/settings.html`, `src/renderer/history.html`, `src/dashboard/index.html`, `scripts/mic-probe.html`
- CSS3 — `src/dashboard/styles.css` and inline `<style>` blocks in the renderer HTML files
- PowerShell — embedded as a string in `src/main/winhelper.js` (Win32 P/Invoke + `System.Windows.Forms.SendKeys`)

## Runtime

- Electron `44.9.0` (Chromium multi-process: main + renderer + preload; `nodeIntegration: false`, `contextIsolation: true` in every window — see `src/main/main.js:191-195`, `224-228`, `248-252`)
- Node.js for tooling/tests: `>= 22.12.0` (required by `@electron/asar` and Electron 44's dev toolchain in `package-lock.json`; the repo was developed on Node `v22.21.1`). `README.md` states Node 18+ as the user-facing minimum.
- Attempted runtime target: Windows 10/11 x64 only (`README.md:30`, `package.json:40-50`)
- npm
- Lockfile: present (`package-lock.json`, `lockfileVersion: 3`)

## Frameworks

- Electron `^44.9.0` — desktop shell, tray, global shortcuts, IPC, clipboard, `safeStorage` (DPAPI), single-instance lock, login-item registration
- No UI framework (no React/Vue/Svelte), no CSS framework, no bundler (no Vite/Webpack/Rollup), no template engine. Everything is hand-written vanilla DOM code.
- `node:test` (Node built-in test runner) + `node:assert` — configured in `package.json:10` as `node --test "test/**/*.test.js"`. No Jest/Vitest/Mocha.
- Test files: `test/analytics.test.js`, `test/dashboard.test.js`, `test/gemini.test.js`, `test/hotkeys.test.js`, `test/page.test.js`, `test/ptt.test.js`, `test/sse.test.js`, `test/store.test.js`, `test/wav.test.js`
- `electron-builder` `^26.15.3` — Windows NSIS installer (`package.json:9`, `29-61`); output directory `dist/`
- macOS/Linux builder packages (`dmg-builder`, `electron-winstaller`, `@electron/notarize`, `@electron/osx-sign`) are transitive dependencies of `electron-builder`, not used by this project's scripts.

## Key Dependencies

- `dotenv` `^18.0.8` — the only production dependency. Loads `GEMINI_API_KEY` from `.env` as a development fallback (`src/main/main.js:13`, `src/main/main.js:31`; `scripts/test-api.js:10-14`).
- `electron` `^44.9.0` — dev dependency that is the actual runtime (app is launched via `electron .`, not bundled).
- Node built-ins only for everything else: `https` (Gemini streaming request — `src/main/gemini.js:14`), `http` (dashboard server — `src/main/dashboard.js:17`), `crypto` (UUIDs, dashboard token — `src/main/main.js:16`, `src/main/store.js:9`), `fs`/`path` (JSON store, logger, static files), `child_process` (PowerShell helper — `src/main/winhelper.js:12`), `events` (EventEmitter services).
- **No native addons.** `package.json:26-28` still contains an `allowScripts` entry for `uiohook-napi@1.5.5`, but `uiohook-napi` is not in `dependencies`, `devDependencies`, or `package-lock.json`. Global hotkeys use Electron `globalShortcut` (`src/main/hotkeys.js:14`), and keystroke injection uses PowerShell instead of `robotjs` (`src/main/paste.js:109-116`).

## Configuration

- `.env` and `.env.example` exist at the repo root (values not inspected; `.env` is gitignored via `.gitignore`).
- Single required variable: `GEMINI_API_KEY`. Resolution order in `src/main/main.js:31`: encrypted value in the JSON store → `process.env.GEMINI_API_KEY`.
- No `NODE_ENV` usage; dev mode is a CLI flag: `electron . --dev` → `IS_DEV = process.argv.includes('--dev')` (`src/main/main.js:30`).
- `package.json` `"build"` block (`package.json:29-61`): appId `com.vilian.dictata`, productName `Dictata`, NSIS target x64, one-click installer, `perMachine: false`, icon `assets/icon.ico`, packaged files limited to `src/**/*`, `assets/**/*`, `package.json`.
- No `engines` field, no `.nvmrc`, no TypeScript config, no lint/format config (`.eslintrc*`, `.prettierrc*`, `biome.json`, `tsconfig.json` all absent), no CI configuration (`.github/` absent).
- Line endings normalized to LF by `.gitattributes` (`* text=auto eol=lf`); PNG/ICO marked binary.

## Platform Requirements

- Node.js 22.12+ and npm
- Windows 10/11 x64 (the PowerShell helper, `SendKeys`, DPAPI-backed `safeStorage`, tray, and login-item APIs are Windows-specific)
- Working microphone; a Google AI Studio API key for live checks
- `npm start` / `npm run dev` (no build step), `npm run dist` for the installer
- Windows 10/11 x64, installed as an NSIS package (current artifacts in `dist/`: `Voice Flow Setup 0.1.0.exe` from a pre-rename build, plus `dist/win-unpacked/`)
- Runs as a tray app; optional auto-start via `app.setLoginItemSettings` (`src/main/main.js:156-159`)
- Outbound HTTPS to `generativelanguage.googleapis.com` is required for all dictation

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## Naming Patterns

- Main-process modules use camelCase nouns: `src/main/gemini.js`, `src/main/recorder.js`, `src/main/winhelper.js`, `src/main/events.js`.
- Renderer windows use a three-file set: `<name>.html`, `<name>Renderer.js`, `<name>Preload.js` (for example `src/renderer/status.html`, `src/renderer/statusRenderer.js`, `src/renderer/statusPreload.js`).
- Tests are named after the module they cover with a `.test.js` suffix: `test/ptt.test.js`, `test/store.test.js`, `test/dashboard.test.js`.
- HTML entry files are lowercase single words: `src/dashboard/index.html`, `src/renderer/settings.html`.
- Scripts under `scripts/` use kebab-case verbs: `test-api.js`, `test-paste.js`, `mic-probe.js`.
- camelCase, verb-first: `encodeWav`, `mergeDefaults`, `buildSystemPrompt`, `publishPartial`, `setState`, `openDashboard`.
- Event handlers use an `on` prefix: `onRecordingDone`, `onPartial`, `_onData`, `_onEvent`.
- Class-private helpers use a leading underscore: `_load`, `_save`, `_ensureDecrypted`, `_buildWav`, `_register`, `_cmd`, `_handle`.
- Pure exported helpers are named after the exact operation, not the class (`mergeDefaults`, not `Store.merge`).
- camelCase throughout: `lastCleaned`, `activeAbort`, `sessionId`, `targetPromise`, `dashboardToken`.
- Module-level constants use UPPER_SNAKE: `DEFAULT_MODEL`, `TIMEOUT_MS`, `SAMPLE_RATE`, `HISTORY_LIMIT`, `DEFAULT_PORT`.
- Constructor options are always named `opts`; defaults are applied with `??` or `||`.
- Instance fields that are internal are underscore-prefixed: `this._store`, `this._chunks`, `this._recording`, `this._registered`.
- String enum values are lowercase words: `'idle' | 'listening' | 'processing'`, `'polished' | 'casual' | 'verbatim'`. Action values may be kebab-case: `'start-lock'`, `'paste-last'`.
- Plain JavaScript only — no TypeScript, no Flow, no `.d.ts` files.
- Object shapes are documented with JSDoc on the function or class: see `src/main/ptt.js:21-33`, `src/main/paste.js:58-67`, `src/main/events.js:20-30`.
- State constants are a frozen-by-convention object, not a class: `const STATE = { IDLE: 'idle', LISTENING: 'listening', PROCESSING: 'processing' }` in `src/main/main.js:68`.
- IPC channels are namespaced with a short prefix: `vf:*` from renderers (`vf:get-store`, `vf:update-settings`, `vf:status`) and `rec:*` for audio (`rec:start`, `rec:chunk`, `rec:done`).
- EventBus event types are lowercase words: `'state'`, `'partial'`, `'level'`, `'dictation'`, `'error'`, `'info'`.
- DOM ids are mostly camelCase for settings fields (`doubleTap`, `restoreClipboard`, `dashboardUrl`, `apiKey`) and kebab-case for compound UI elements (`sc-ptt`, `dict-add`, `panel-general`, `btn-clear`).
- CSS classes are kebab-case: `.entry-meta`, `.duration-badge`, `.stat-icon`, `.shortcut`, `.is-active`.

## Code Style

- No formatter configuration exists. There is no `.prettierrc`, `biome.json`, `.editorconfig`, or equivalent.
- Indentation is 2 spaces. No file under `src/`, `test/`, or `scripts/` contains a tab character.
- Line endings are LF, enforced repository-wide by `.gitattributes`: `* text=auto eol=lf`.
- Statements end with semicolons. String literals use single quotes; template literals are used whenever interpolation or multi-line text is needed.
- Multi-line object and array literals use trailing commas (`src/main/store.js:11-44`, `src/main/gemini.js:77-82`).
- `const` is the default; `let` is used only for reassigned module state. There is no `var` in the codebase.
- Modern syntax is used freely: optional chaining (`statusWindow?.webContents`), nullish coalescing (`opts.limit ?? DEFAULT_LIMIT`), object/array spread, `structuredClone`, `async`/`await`, `Array.prototype.at`-free indexing.
- Blank lines separate logical blocks; long files use box-drawing section banners: `// ── State ────────────────────────────────────────────────────────────────────` (`src/main/main.js:67`, `src/dashboard/app.js:31`).
- No ESLint or Biome configuration detected. Correctness is guarded by tests instead of a linter (`npm test`).
- Keep new code consistent with the existing style: 2-space indent, single quotes, semicolons, trailing commas, no tabs.
- Prefer `async`/`await` over raw promise chains. The only intentional promise-chain exceptions are sequence helpers (`Promise.resolve(...)`, `Promise.race(...)`) in `src/main/paste.js` and `src/main/winhelper.js`.
- Background work that must not delay the pipeline is launched with an async IIFE inside `setTimeout`, with its own `try/catch` (`src/main/paste.js:92-104`).
- Always pass and honor an `AbortSignal` for cancellable network work (`src/main/gemini.js:76-82`, `src/main/gemini.js:261-268`).

## Import Organization

- CommonJS only (`require` / `module.exports`). There are no ESM files and no bundler.
- Named exports are preferred and destructured at the import site: `const { encodeWav } = require('./wav')`.
- No path aliases and no barrel/index files. Import the concrete module by relative path.
- Renderer scripts import nothing. They consume the preload bridge as `window.vf` (`src/renderer/statusPreload.js:4`, `src/renderer/settingsPreload.js:4`).

## Error Handling

- Throw `Error` with a message written for the UI, using an em dash to add the remedy: `'Missing Gemini API key — add it in Settings'`, `'No audio captured — check microphone'`, `'Gemini timed out after 30s — check internet'` (`src/main/gemini.js:84-85`, `src/main/gemini.js:258`).
- Catch at the boundary and log with a module tag plus `e.message`, never the whole error object: `console.warn('[store] safeStorage unavailable:', e.message)` (`src/main/store.js:58`).
- Intentionally ignored errors say why in the catch block: `catch { /* start fresh rather than crash */ }`, `catch { /* logging must never throw */ }`, `catch { /* the broker may already be gone */ }`.
- Cancellation uses a string sentinel, not a custom error class: `err.message === 'Cancelled'` (`src/main/gemini.js:121`, `src/main/main.js:501`).
- Non-fatal failures are published as `{ fatal: false }` events and surfaced in the tray; fatal pipeline failures are `{ fatal: true }` (`src/main/main.js:207`, `src/main/main.js:496-507`).
- Retryability is centralized in `isRetryable()` in `src/main/gemini.js:285-288`; only 408/429/5xx and network/timeout errors are retried.
- Process-level safety nets are installed once at startup: `uncaughtException` and `unhandledRejection` log and keep the tray app alive (`src/main/main.js:117-123`).
- Cleanup of timers, listeners and servers always happens in `finally` or an explicit `done()` guard (`src/main/gemini.js:182-189`, `test/dashboard.test.js:29-31`).

## Logging

- `logger.init(app)` replaces `console.log`, `console.warn` and `console.error` in the main process; lines are prefixed with an ISO timestamp and INFO/WARN/ERROR level (`src/main/logger.js:27-45`).
- Every log line starts with a bracketed area tag: `[gemini]`, `[pipeline]`, `[recorder]`, `[dashboard]`, `[store]`, `[hotkeys]`, `[paste]`, `[dictata]`, `[rec]`.
- Log decisions, timings and recovery paths, not every function: `console.log(\`[gemini] first token after ${Date.now() - t0} ms\`)` (`src/main/gemini.js:224`), `console.log(\`[pipeline] stop → pasted in ${Date.now() - t0} ms\`)` (`src/main/main.js:473`).
- `console.warn` marks degraded but recoverable behavior (fallback model, unregistered shortcut, clipboard restore failure). `console.error` marks failures that need diagnosis.
- Never log secrets. The Gemini key is passed in request headers and is never printed (`src/main/gemini.js:191-197`).
- The log rotates at 512 KB to `dictata.log.1` and logging never throws (`src/main/logger.js:13`, `src/main/logger.js:49-57`).

## Comments

- Every main-process module opens with a block comment stating its purpose, the reason it is separate, and any key invariant. Examples: `src/main/ptt.js:1-17`, `src/main/wav.js:1-5`, `src/main/sse.js:1-7`, `src/main/dashboard.js:1-15`.
- Explain *why*, especially for workarounds and fragile ordering. Examples: the double-tap explanation (`src/main/ptt.js:3-9`), Electron's async clipboard (`src/main/paste.js:20-24`), why `thinkingConfig` is model-specific (`src/main/gemini.js:44-50`), and why `recording` stays true until the worklet replies (`src/renderer/statusRenderer.js:115-117`).
- Section banners divide long files (`main.js`, `dashboard.js`, `settingsRenderer.js`, `dashboard/app.js`).
- Historical bug notes are acceptable when they prevent regression: `// ...the original bug` (`src/renderer/statusRenderer.js:117`).
- Use JSDoc for exported functions, options objects and return shapes: `@param {object} [opts]`, `@param {AbortSignal} [opts.signal]`, `@returns {Promise<{pasted: boolean}>}`.
- Multi-line JSDoc is block style with one tag per line (`src/main/gemini.js:71-75`, `src/main/dashboard.js:73-78`).
- Trailing `//` comments may annotate individual object fields (`src/main/store.js:14-39`).

## Function Design

## Module Design

- CommonJS, one `module.exports = { ... }` statement at the bottom of each file.
- Export the pure helpers alongside the class so they can be tested without Electron: `{ Store, DEFAULTS, mergeDefaults, encryptSecret, decryptSecret }` (`src/main/store.js:204`), `{ transcribe, testKey, resolveModel, buildSystemPrompt, buildRequestBody, supportsThinkingLevel, DEFAULT_MODEL, FALLBACK_MODELS }` (`src/main/gemini.js:325-328`).
- Stateful services are classes (`Store`, `Recorder`, `HotkeyService`, `EventBus`, `DashboardServer`) instantiated once as singletons in `src/main/main.js:79-90`. `winHelper` is exported already-instantiated (`src/main/winhelper.js:185`).
- Pure logic modules must not require `electron`: `ptt.js`, `wav.js`, `sse.js`, `analytics.js`. This is a stated design rule in `README.md:110-112`.
- Electron-facing modules may require Electron: `store.js`, `hotkeys.js`, `recorder.js`, `paste.js`, `dashboard.js`, `logger.js`.
- `src/main/main.js` is the only orchestrator; other modules do not import `main.js` and do not create windows.
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

<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## System Overview

```text

```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Main orchestrator | App lifecycle, state machine, window/tray creation, IPC, pipeline sequencing | `src/main/main.js` |
| Push-to-talk rules | Pure double-tap / hands-free interaction state machine | `src/main/ptt.js` |
| Hotkey service | Registers Electron global shortcuts, translates presses into actions | `src/main/hotkeys.js` |
| Recorder | Collects Float32 chunks from renderer, enforces length cap, emits WAV on done | `src/main/recorder.js` |
| WAV encoder | Pure Float32 → 16-bit 16 kHz mono RIFF/WAVE | `src/main/wav.js` |
| Gemini client | Builds prompt/body, streams SSE, retries and falls back across models | `src/main/gemini.js` |
| SSE parser | Pure incremental `data:` line parser | `src/main/sse.js` |
| Paste pipeline | Clipboard snapshot → write → focus target → SendKeys → restore | `src/main/paste.js` |
| Win32 helper | Long-lived PowerShell process: foreground window, focus, SendKeys | `src/main/winhelper.js` |
| Store | JSON persistence in `%APPDATA%/Dictata`, settings merge, encrypted API key, history/stats | `src/main/store.js` |
| Event bus | Typed in-memory activity events with rolling buffer | `src/main/events.js` |
| Analytics | Pure aggregation for dashboard charts and totals | `src/main/analytics.js` |
| Dashboard server | Local HTTP + SSE server with token auth and static asset serving | `src/main/dashboard.js` |
| Logger | Mirrors `console.*` into a rotating log file | `src/main/logger.js` |
| Status pill | Always-on-top pill UI + microphone capture + real-time level | `src/renderer/status.html`, `src/renderer/statusRenderer.js`, `src/renderer/recorderWorklet.js` |
| Settings window | Form UI for shortcuts, AI, dictionary, dashboard | `src/renderer/settings.html`, `src/renderer/settingsRenderer.js` |
| History window | Local history list with re-paste and delete | `src/renderer/history.html`, `src/renderer/historyRenderer.js` |
| Web dashboard page | Vanilla-JS dashboard (Dictation / History / Insights) driven by SSE | `src/dashboard/index.html`, `src/dashboard/app.js`, `src/dashboard/styles.css` |

## Pattern Overview

- No bundler, no transpiler, no framework. Plain CommonJS in the main process, plain `<script>` files in renderers, plain HTML/CSS/JS for the dashboard.
- Every renderer is sandboxed: `contextIsolation: true`, `nodeIntegration: false`, and a per-window `*Preload.js` exposing a narrow `window.vf` API via `contextBridge`.
- Business rules that can be pure are isolated from Electron (`ptt.js`, `wav.js`, `sse.js`, `analytics.js`, plus prompt/body builders in `gemini.js`) so `node --test` can cover them without a display or network.
- The main process is the only place with Node/OS access; renderers communicate exclusively over named IPC channels (`vf:*`, `rec:*`).
- A typed event bus (`src/main/events.js`) is the single fan-out point for UI feedback, dashboard streaming, and persisted error/info events.
- One external model call performs transcription and cleanup together; there is no separate STT stage.

## Layers

- Purpose: Convert user intent (hotkey, tray click, window IPC) into orchestrator actions.
- Location: `src/main/main.js`, `src/main/hotkeys.js`, `src/main/ptt.js`
- Contains: `app.whenReady()` bootstrap, `HotkeyService`, `PttState`, tray menu construction, IPC handlers.
- Depends on: Electron APIs (`globalShortcut`, `Tray`, `Menu`, `BrowserWindow`).
- Used by: nothing above it; it is the top of the call graph.
- Purpose: Own the dictation lifecycle and application state.
- Location: `src/main/main.js` (`state`, `setState`, `beginRecording`, `onRecordingDone`, `pasteInto`, `setupIPC`)
- Contains: module-level state (`state`, `handsFreeOn`, `lastTargetHwnd`, `sessionId`, `targetPromise`, `activeAbort`), window references, pipeline sequencing.
- Depends on: every service layer below.
- Used by: hotkey actions, tray, IPC.
- Purpose: Perform one job each with no knowledge of the UI.
- Location: `src/main/recorder.js`, `src/main/gemini.js`, `src/main/paste.js`, `src/main/winhelper.js`, `src/main/store.js`, `src/main/events.js`, `src/main/dashboard.js`, `src/main/analytics.js`, `src/main/logger.js`
- Contains: classes (`Recorder`, `Store`, `EventBus`, `DashboardServer`, `WinHelper`) and pure functions (`encodeWav`, `transcribe`, `buildSystemPrompt`, `summarize`, `pasteText`).
- Depends on: Node core (`https`, `http`, `fs`, `path`, `crypto`, `child_process`, `events`) and a small set of Electron APIs (`clipboard`, `safeStorage`, `ipcMain`, `app`).
- Used by: the orchestrator and, for pure modules, tests.
- Purpose: Render status/settings/history and capture microphone audio.
- Location: `src/renderer/`
- Contains: one `.html`, one `*Preload.js`, one `*Renderer.js` per window, plus `recorderWorklet.js`.
- Depends on: only the `window.vf` bridge; no Node APIs.
- Used by: the main process via `BrowserWindow.loadFile()` and IPC events.
- Purpose: A browser page that observes app activity.
- Location: `src/dashboard/`
- Contains: static `index.html`, `styles.css`, `app.js` served by `DashboardServer`; consumes `/api/state` and `/api/events`.
- Depends on: HTTP/SSE only.
- Used by: the user's default browser, opened via tray.

## Data Flow

### Primary Request Path — one dictation

### Streaming Feedback Path (pill + dashboard)

### Dashboard Request Path

- The dictation state machine is a single module-level string in `src/main/main.js:69` (`idle` / `listening` / `processing`) mutated only through `setState()` (`src/main/main.js:545`).
- Per-recordings race protection uses a monotonically increasing `sessionId`; stale async completions compare `mySession !== sessionId` and bail (`src/main/main.js:388`, `src/main/main.js:443`).
- `handsFreeOn` mirrors `PttState.handsFree`; `bus.appState`/`bus.handsFree` mirror the same values for the dashboard.
- Persistence is owned by `Store`, which debounces writes 150 ms and writes atomically through a `.tmp` file (`src/main/store.js:126`).
- Renderers keep only ephemeral view state (`settings`, `recording`, `cancelled`); the dashboard keeps a normalized client cache (`state` object) refreshed by SSE.

## Key Abstractions

- Purpose: Decouple producers from UI/dashboard/persistence consumers.
- Examples: `state`, `partial`, `level`, `dictation`, `error`, `info` events created in `src/main/main.js`.
- Pattern: `EventEmitter` subclass with a bounded ring buffer (`limit: 500`), stable event ids, and a `PERSISTED_TYPES` allow-list.
- Purpose: Single source of truth for settings, dictionary, replacements, history, events, stats, dashboard token.
- Examples: `new Store()` singleton in `src/main/main.js:79`.
- Pattern: JSON document in `userData/dictata.json`, `mergeDefaults()` for forward-compatible schema migration, `safeStorage` encryption for the API key, `snapshot()` returns a `structuredClone`.
- Purpose: Own the main-side audio buffer lifecycle and encode the WAV.
- Pattern: `EventEmitter` (`level`, `done`, `error`) with a 1.5 s stop watchdog and a configurable max-length timer.
- Purpose: Encode tap/double-tap/hands-free semantics as pure transitions returning `{ action, handsFree }`.
- Pattern: Pure class with injectable clock (`opts.now`) for deterministic tests.
- Purpose: Local observability surface without adding a server dependency.
- Pattern: `node:http` server with manually routed endpoints, token-in-query auth, host allow-list, port fallback chain (`preferred … preferred+3`), SSE client set.
- Purpose: Fast Win32 calls without native modules.
- Pattern: One long-lived `powershell.exe` child; newline command protocol (`target`, `focus <hwnd>`, `keys <sendkeys>`) terminated by `__END__`, FIFO queue with per-command timeouts.

## Entry Points

- Location: `src/main/main.js` (declared as `main` in `package.json:5`)
- Triggers: `npm start` / `npm run dev` / packaged app launch
- Responsibilities: single-instance lock, user-data migration, `app.whenReady()` wiring (`src/main/main.js:125`), tray, IPC, hotkeys, dashboard, first-run settings.
- Location: `src/main/hotkeys.js`
- Triggers: system-wide accelerators configured in `store.settings.shortcuts`
- Responsibilities: translate key presses into PTT actions and `paste-last`.
- Location: `setupIPC()` in `src/main/main.js:570`
- Channels: `vf:get-store`, `vf:get-settings`, `vf:update-settings`, `vf:dashboard-url`, `vf:test-key`, `vf:set-dictionary`, `vf:set-replacements`, `vf:open-external`, `vf:open-dashboard`, `vf:dashboard-test`, `vf:delete-history`, `vf:clear-history`, `vf:paste-entry`
- Audio channels (from `recorder.attach()`): `rec:chunk`, `rec:level`, `rec:done`, `rec:error`
- `vf:status`, `vf:settings`, `vf:history-updated` (targeted sends)
- `rec:start`, `rec:stop`, `rec:cancel` (recorder control)
- Location: `src/main/dashboard.js`
- Routes: `/`, `/api/state`, `/api/history`, `/api/events`, plus static assets under `src/dashboard`.
- `scripts/test-api.js` — live Gemini check (`npm run test:api`)
- `scripts/test-paste.js` — Electron end-to-end Notepad paste check (`npm run test:paste`)
- `scripts/mic-probe.js` + `scripts/mic-probe.html` — microphone level probe (`npm run test:mic`)

## Architectural Constraints

- **Threading:** Electron main-process event loop for all orchestration and Node I/O; renderers run their own loops and own the audio graph. The PowerShell helper is a separate OS process serialized through a promise queue.
- **Global state:** Module-level singletons/mutable state in `src/main/main.js` (`store`, `recorder`, `hotkeys`, `bus`, `dashboard`, `state`, `handsFreeOn`, `lastCleaned`, `lastRaw`, `lastTargetHwnd`, `activeAbort`, `sessionId`, `targetPromise`); `winHelper` is exported as a process-wide singleton (`src/main/winhelper.js:185`); `logger` installs global `console` wrappers (`src/main/logger.js:33`).
- **Platform:** Windows-only. Depends on `powershell.exe`, `System.Windows.Forms.SendKeys`, Win32 `SetForegroundWindow`, and Windows DPAPI via Electron `safeStorage`. `package.json` only builds an NSIS x64 target.
- **Security model:** All renderers use `contextIsolation: true` and `nodeIntegration: false`; microphone permission is granted globally for `media`/`microphone` in `createStatusWindow()` (`src/main/main.js:171`). The dashboard binds `127.0.0.1`, rejects foreign `Host` headers, and requires the stored token on API routes.
- **Single instance:** `app.requestSingleInstanceLock()` exits a second copy (`src/main/main.js:111`).
- **Lifecycle:** Tray app — `window-all-closed` is prevented so the process outlives its windows (`src/main/main.js:166`).
- **No build step:** Source files are shipped as-is (`build.files` in `package.json:35`); no `dist/` bundling of JS, so file paths in source are production paths.
- **Audio format coupling:** 16 kHz mono Float32 → 16-bit WAV is assumed by `recorder`, `wav`, the worklet, and Gemini's inline audio contract; changing one requires changing all four.
- **Circular imports:** None detected; dependencies flow one way from `main.js` into service modules. `paste.js` ↔ `winhelper.js` is one-directional (`paste` requires `winhelper`).

## Anti-Patterns

### God-object orchestrator

### Duplicated state representations

### Variable shadowing across scopes

### HTML string assembly in renderers

## Error Handling

- Global `uncaughtException` / `unhandledRejection` handlers log and continue (`src/main/main.js:118`).
- Pipeline `try/catch/finally` publishes an `error` event with `kind: 'api' | 'paste' | 'microphone' | 'cancel'`, updates the pill, shows a tray balloon, and always clears state in `finally` (`src/main/main.js:500`).
- Cancellation is a sentinel string (`new Error('Cancelled')`) thrown by aborting the HTTPS request (`src/main/gemini.js:263`) and recognized in the pipeline (`src/main/main.js:501`).
- Retry policy: retryable HTTP statuses and network/timeout errors walk a model fallback chain with a 60 s total budget; 400/401/403 fail fast (`src/main/gemini.js:103`, `src/main/gemini.js:285`).
- Recorder guards: minimum 0.3 s audio, 1.5 s stop watchdog, max-length auto-stop (`src/main/recorder.js:84`).
- WinHelper degrades to empty string / `false` on timeout or process exit rather than throwing (`src/main/winhelper.js:132`).
- Store never throws from load or save; it falls back to defaults or logs (`src/main/store.js:108`, `src/main/store.js:126`).
- Logging must never throw; `logger.write()` swallows all errors (`src/main/logger.js:40`).

## Cross-Cutting Concerns

<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-fast` for a trivial task inline, with no subagents and no PLAN.md
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
