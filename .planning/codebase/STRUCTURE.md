---
last_mapped_commit: 0439ed1ae6b93347340f8af55ab3cb3f630a64f4
last_mapped_at: 2026-10-22
---
# Codebase Structure

**Analysis Date:** 2026-10-22

## Directory Layout

```text
Voice Flow/                       # repo root (product name: Dictata)
├── src/
│   ├── main/                     # Electron main process — all Node/OS logic
│   ├── renderer/                 # Electron windows (pill, settings, history) + worklet
│   └── dashboard/                # Static web dashboard served over local HTTP
├── test/                         # node:test unit + static-page tests
├── scripts/                      # Manual / end-to-end diagnostic scripts
├── assets/                       # App, installer and tray icons
├── dist/                         # electron-builder output (generated)
├── node_modules/                 # installed dependencies (generated)
├── .planning/                    # GSD planning artifacts (this documentation)
├── .opencode/                    # local agent skills (gitignored)
├── .env                          # local dev secrets (gitignored, not read)
├── .env.example                  # documents GEMINI_API_KEY
├── package.json                  # manifest, scripts, electron-builder config
├── package-lock.json
├── README.md                     # product + architecture overview
├── .gitignore
└── .gitattributes
```

## Directory Purposes

**`src/main/`:**
- Purpose: Everything that runs in Electron's main process — orchestration, OS integration, networking, persistence, HTTP server.
- Contains: CommonJS modules exporting classes (`Store`, `Recorder`, `EventBus`, `DashboardServer`, `HotkeyService`, `PttState`), pure functions (`encodeWav`, `summarize`, `transcribe`, `pasteText`), and one process-wide singleton (`winHelper`).
- Key files: `src/main/main.js` (entry + orchestrator), `src/main/store.js`, `src/main/gemini.js`, `src/main/dashboard.js`, `src/main/winhelper.js`.

**`src/renderer/`:**
- Purpose: Electron `BrowserWindow` UIs and the microphone capture pipeline.
- Contains: three windows, each as `*.html` + `*Preload.js` + `*Renderer.js`, plus the AudioWorklet processor.
- Key files: `src/renderer/statusRenderer.js` (capture + pill), `src/renderer/recorderWorklet.js` (PCM chunking), `src/renderer/settingsRenderer.js`, `src/renderer/historyRenderer.js`.

**`src/dashboard/`:**
- Purpose: The browser dashboard served at `http://127.0.0.1:7788/` by `DashboardServer`.
- Contains: a single-page vanilla-JS app with no build step — `index.html`, `styles.css`, `app.js`.
- Key files: `src/dashboard/app.js` (state cache, SSE client, renderers, SVG charts), `src/dashboard/index.html` (three tabs + takeover/banner chrome), `src/dashboard/styles.css`.

**`test/`:**
- Purpose: Fast, dependency-free tests run by `node --test`.
- Contains: one test file per pure module plus a static dashboard-page test.
- Key files: `test/ptt.test.js`, `test/wav.test.js`, `test/sse.test.js`, `test/gemini.test.js`, `test/store.test.js`, `test/analytics.test.js`, `test/dashboard.test.js`, `test/page.test.js`, `test/hotkeys.test.js`.

**`scripts/`:**
- Purpose: Checks that need Electron, network, a microphone, or a real Windows desktop.
- Contains: `scripts/test-paste.js` (Notepad end-to-end), `scripts/test-api.js` (live Gemini), `scripts/mic-probe.js` + `scripts/mic-probe.html` (mic level).
- Key files: referenced by `package.json` scripts `test:paste`, `test:api`, `test:mic`.

**`assets/`:**
- Purpose: Installer/tray artwork referenced by code and electron-builder.
- Contains: `assets/icon.ico`, `assets/icon.png`, `assets/tray-icon.png`.
- Key files: `src/main/main.js:260` loads `tray-icon.png`; `package.json:49` uses `icon.ico`.

**`dist/`:**
- Purpose: electron-builder output (`npm run dist`), including `win-unpacked/` and the NSIS installer.
- Generated: Yes.
- Committed: No (gitignored).

**`.planning/`:**
- Purpose: GSD-generated project documents; `codebase/` holds architecture/reference docs.
- Generated: Yes (by GSD workflows).
- Committed: Yes.

**`.opencode/skills/`:**
- Purpose: Local agent skill `ui-ux-pro-max` (design data CSVs + Python search scripts) used during UI work; the dashboard's visual language follows this skill's guidance.
- Generated: No.
- Committed: No (`.opencode/` is gitignored).

## Key File Locations

**Entry Points:**
- `src/main/main.js`: Electron main entry (`main` in `package.json`), app bootstrap, state machine, IPC, tray.
- `src/main/hotkeys.js`: Global shortcut registration → PTT actions.
- `src/main/dashboard.js`: Local HTTP/SSE server entry.
- `src/renderer/status.html` + `src/renderer/statusRenderer.js`: Pill UI and recorder start-up.
- `src/dashboard/index.html` + `src/dashboard/app.js`: Dashboard page entry.

**Configuration:**
- `package.json`: scripts (`start`, `dev`, `dist`, `test`, `test:*`), dependency list, electron-builder config.
- `.env.example`: documents `GEMINI_API_KEY` fallback (a local `.env` also exists and is gitignored).
- `.gitignore`: ignores `node_modules/`, `.env`, `dist/`, `out/`, `*.log`, `.opencode/`.
- No ESLint/Prettier/TypeScript/bundler config files exist.

**Core Logic:**
- `src/main/main.js`: dictation state machine and pipeline sequencing.
- `src/main/ptt.js`: push-to-talk / hands-free rules (pure).
- `src/main/gemini.js`: prompt construction, model fallback, streaming request.
- `src/main/recorder.js`: chunk collection, length cap, WAV emission.
- `src/main/wav.js`: WAV encoding (pure).
- `src/main/sse.js`: SSE parser (pure).
- `src/main/paste.js`: clipboard + paste sequence.
- `src/main/winhelper.js`: PowerShell bridge for window focus and SendKeys.
- `src/main/store.js`: settings/history persistence, encryption, token.
- `src/main/events.js`: typed event bus.
- `src/main/analytics.js`: dashboard aggregation (pure).
- `src/main/logger.js`: rolling file log.

**Testing:**
- `test/*.test.js`: unit tests, run with `node --test "test/**/*.test.js"`.
- `test/dashboard.test.js`: spins the real `DashboardServer` against an `EventBus` and temp store.
- `test/page.test.js`: static assertions over `src/dashboard` HTML/CSS/JS (ids, breakpoints, no webfonts).
- `scripts/test-paste.js`, `scripts/test-api.js`, `scripts/mic-probe.js`: environment-dependent checks.

## Naming Conventions

**Files:**
- Main-process modules: lowercase camelCase nouns — `store.js`, `hotkeys.js`, `winhelper.js`, `paste.js`.
- Renderer pairs: `<window>Preload.js`, `<window>Renderer.js`, `<window>.html` — `statusPreload.js`, `statusRenderer.js`, `status.html`.
- Worklet: `recorderWorklet.js` (registered processor name `recorder-processor`).
- Dashboard: generic `app.js`, `styles.css`, `index.html`.
- Tests: `<module>.test.js`, mirroring the source module name.
- Scripts: `test-<area>.js`, `mic-probe.js`.

**Directories:**
- Lowercase, single words: `main`, `renderer`, `dashboard`, `test`, `scripts`, `assets`.

**IPC channels:**
- App channels are namespaced `vf:<kebab-action>` (`vf:get-store`, `vf:update-settings`, `vf:paste-entry`).
- Recorder channels are namespaced `rec:<verb>` (`rec:start`, `rec:stop`, `rec:chunk`, `rec:level`, `rec:done`, `rec:error`).

**Symbols:**
- Classes: PascalCase (`Store`, `Recorder`, `EventBus`, `DashboardServer`, `HotkeyService`, `PttState`, `WinHelper`).
- Functions/variables: camelCase; booleans often prefixed `is`/`has` or named as flags (`handsFreeOn`, `_recording`, `cancelled`).
- Constants: UPPER_SNAKE (`DEFAULT_MODEL`, `FALLBACK_MODELS`, `SAMPLE_RATE`, `CHUNK_SAMPLES`, `MAX_BYTES`, `HISTORY_LIMIT`).
- Private members: leading underscore (`_chunks`, `_finish`, `_handle`, `_broadcast`).
- Persisted event types: lowercase strings `state`, `partial`, `level`, `dictation`, `error`, `info`.
- HTML ids/classes: kebab-case (`statusPill`, `modelPill` are camelCase in the dashboard nav; element ids are camelCase or kebab-case per file — follow the file you are editing).

## Where to Add New Code

**New Feature (main-process service):**
- Implementation: create `src/main/<feature>.js` exporting a class or pure functions.
- Wiring: instantiate in the singletons block of `src/main/main.js:79` and call it from the appropriate pipeline stage.
- Tests: add `test/<feature>.test.js` if it can be Electron-free.

**New Pure Business Rule:**
- Primary code: a new Electron-free module in `src/main/` (model it on `src/main/ptt.js` or `src/main/wav.js`).
- Tests: `test/<name>.test.js` using `node:test` + `node:assert`.

**New Renderer Window:**
- Implementation: `src/renderer/<name>.html`, `src/renderer/<name>Preload.js`, `src/renderer/<name>Renderer.js`.
- Wiring: add a `create<Name>Window()` in `src/main/main.js` next to `createSettingsWindow()` (line 213), using `contextIsolation: true` and the preload path.
- IPC: add `ipcMain.handle('vf:<action>')` in `setupIPC()` (`src/main/main.js:570`) and expose it only in that window's preload.

**New IPC Call for an Existing Window:**
- Main handler: `src/main/main.js` `setupIPC()`.
- Bridge: the matching `src/renderer/*Preload.js`.
- Caller: the matching `src/renderer/*Renderer.js`.

**New Dashboard View or Panel:**
- Markup: `src/dashboard/index.html` (tabs are `data-tab="live|history|insights"`).
- Logic: a `render<View>()` function plus registration in `renderAll()` in `src/dashboard/app.js:345`.
- Styles: `src/dashboard/styles.css` (light/dark via `data-theme`, responsive breakpoints).
- Live data: consume existing `handleEvent()` types rather than adding polling; only add server routes in `src/main/dashboard.js:161` if new data is required.

**New Activity Event:**
- Publish with `bus.publish('<type>', payload)` in `src/main/main.js`.
- If it must survive restarts, add it to `PERSISTED_TYPES` in `src/main/events.js:14` (note: `main.js:100` persists only `error` and `info`; dictations are persisted as history).
- Consume in `src/dashboard/app.js handleEvent()` and, if the pill needs it, send a `vf:status` payload.

**New Settings Field:**
- Default: `DEFAULTS.settings` in `src/main/store.js:11`.
- UI: add the control to `src/renderer/settings.html` and bind it in `src/renderer/settingsRenderer.js` (use the `bind*` helpers, line 207+).
- Side effects: handle the patch in `ipcMain.handle('vf:update-settings')` in `src/main/main.js:577`.

**New Diagnostic Script:**
- Implementation: `scripts/test-<area>.js`.
- Registration: add an npm script in `package.json` (`test:paste`, `test:api`, `test:mic` are the precedents).

**Shared Utilities:**
- Pure helpers belong in `src/main/analytics.js` (aggregation/formatting of dictation data) or a new small `src/main/<util>.js`; there is no `utils/` directory and none should be introduced without a second consumer.

## Special Directories

**`dist/`:**
- Purpose: Packaged Windows build output (`dist/win-unpacked/`, NSIS installer).
- Generated: Yes.
- Committed: No.

**`node_modules/`:**
- Purpose: Installed dependencies (`dotenv` runtime; `electron`, `electron-builder` dev).
- Generated: Yes.
- Committed: No.

**`src/dashboard/`:**
- Purpose: Static assets served at runtime by `DashboardServer` (`ROOT = path.join(__dirname, '../dashboard')`).
- Generated: No.
- Committed: Yes.
- Note: files here are loaded directly from disk at runtime; adding a new page asset requires no registration, but paths are prefix-checked in `src/main/dashboard.js:188`.

**`assets/`:**
- Purpose: Binary artwork shipped by electron-builder (`files` includes `assets/**/*`).
- Generated: No.
- Committed: Yes.

**`.opencode/`:**
- Purpose: Local agent skills and tooling; not part of the shipped app.
- Generated: No.
- Committed: No.

---

*Structure analysis: 2026-10-22*
