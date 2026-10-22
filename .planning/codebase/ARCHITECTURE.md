---
last_mapped_commit: 0439ed1ae6b93347340f8af55ab3cb3f630a64f4
last_mapped_at: 2026-10-22
---
<!-- refreshed: 2026-10-22 -->

# Architecture

**Analysis Date:** 2026-10-22

## System Overview

Dictata is a Windows-only Electron tray application. A global hotkey drives a small state machine in the Electron **main process**, which records audio through a hidden **renderer** window (getUserMedia + AudioWorklet), sends it to **Google Gemini** in one streaming request, and pastes the cleaned text into whatever window had focus. A separate **local HTTP dashboard** (node:http + SSE) mirrors all activity into a browser page.

```text
┌──────────────────────────────────────────────────────────────────────┐
│                         Interaction / Entry                          │
│  global shortcuts            tray menu            IPC from windows   │
│  `src/main/hotkeys.js`       `src/main/main.js`   `src/main/main.js` │
└───────────────┬──────────────────────┬───────────────────────────────┘
                │                      │
                ▼                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Orchestrator (main process)                       │
│  `src/main/main.js` — IDLE → LISTENING → PROCESSING → IDLE           │
│  owns: windows, tray, pipeline, session guard, event publishing      │
└───┬───────────────┬───────────────────┬───────────────────┬──────────┘
    │               │                   │                   │
    ▼               ▼                   ▼                   ▼
┌─────────┐  ┌─────────────┐  ┌─────────────────┐  ┌──────────────────┐
│ Audio   │  │ AI / Cloud  │  │ Desktop I/O     │  │ Persistence/Feed │
│ Recorder│  │ gemini.js   │  │ paste.js        │  │ store.js         │
│ wav.js  │  │ sse.js      │  │ winhelper.js    │  │ events.js        │
└────┬────┘  └──────┬──────┘  └────────┬────────┘  │ analytics.js     │
     │              │                  │           │ dashboard.js     │
     ▼              ▼                  ▼           └────────┬─────────┘
┌──────────────────────────┐  ┌──────────────────┐        │
│ Status-pill renderer     │  │ PowerShell helper│        ▼
│ getUserMedia + Worklet   │  │ (long-lived)     │  Dashboard browser
│ `src/renderer/status*`   │  │ focus + SendKeys │  `src/dashboard/`
└──────────────────────────┘  └──────────────────┘
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

**Overall:** Layered Electron main-process architecture with a registry-of-singletons orchestrator, pure domain modules, and dumb renderers behind preload bridges.

**Key Characteristics:**
- No bundler, no transpiler, no framework. Plain CommonJS in the main process, plain `<script>` files in renderers, plain HTML/CSS/JS for the dashboard.
- Every renderer is sandboxed: `contextIsolation: true`, `nodeIntegration: false`, and a per-window `*Preload.js` exposing a narrow `window.vf` API via `contextBridge`.
- Business rules that can be pure are isolated from Electron (`ptt.js`, `wav.js`, `sse.js`, `analytics.js`, plus prompt/body builders in `gemini.js`) so `node --test` can cover them without a display or network.
- The main process is the only place with Node/OS access; renderers communicate exclusively over named IPC channels (`vf:*`, `rec:*`).
- A typed event bus (`src/main/events.js`) is the single fan-out point for UI feedback, dashboard streaming, and persisted error/info events.
- One external model call performs transcription and cleanup together; there is no separate STT stage.

## Layers

**Entry / Interaction Layer:**
- Purpose: Convert user intent (hotkey, tray click, window IPC) into orchestrator actions.
- Location: `src/main/main.js`, `src/main/hotkeys.js`, `src/main/ptt.js`
- Contains: `app.whenReady()` bootstrap, `HotkeyService`, `PttState`, tray menu construction, IPC handlers.
- Depends on: Electron APIs (`globalShortcut`, `Tray`, `Menu`, `BrowserWindow`).
- Used by: nothing above it; it is the top of the call graph.

**Orchestration Layer:**
- Purpose: Own the dictation lifecycle and application state.
- Location: `src/main/main.js` (`state`, `setState`, `beginRecording`, `onRecordingDone`, `pasteInto`, `setupIPC`)
- Contains: module-level state (`state`, `handsFreeOn`, `lastTargetHwnd`, `sessionId`, `targetPromise`, `activeAbort`), window references, pipeline sequencing.
- Depends on: every service layer below.
- Used by: hotkey actions, tray, IPC.

**Service / Domain Layer:**
- Purpose: Perform one job each with no knowledge of the UI.
- Location: `src/main/recorder.js`, `src/main/gemini.js`, `src/main/paste.js`, `src/main/winhelper.js`, `src/main/store.js`, `src/main/events.js`, `src/main/dashboard.js`, `src/main/analytics.js`, `src/main/logger.js`
- Contains: classes (`Recorder`, `Store`, `EventBus`, `DashboardServer`, `WinHelper`) and pure functions (`encodeWav`, `transcribe`, `buildSystemPrompt`, `summarize`, `pasteText`).
- Depends on: Node core (`https`, `http`, `fs`, `path`, `crypto`, `child_process`, `events`) and a small set of Electron APIs (`clipboard`, `safeStorage`, `ipcMain`, `app`).
- Used by: the orchestrator and, for pure modules, tests.

**Presentation Layer (Electron windows):**
- Purpose: Render status/settings/history and capture microphone audio.
- Location: `src/renderer/`
- Contains: one `.html`, one `*Preload.js`, one `*Renderer.js` per window, plus `recorderWorklet.js`.
- Depends on: only the `window.vf` bridge; no Node APIs.
- Used by: the main process via `BrowserWindow.loadFile()` and IPC events.

**Presentation Layer (Web dashboard):**
- Purpose: A browser page that observes app activity.
- Location: `src/dashboard/`
- Contains: static `index.html`, `styles.css`, `app.js` served by `DashboardServer`; consumes `/api/state` and `/api/events`.
- Depends on: HTTP/SSE only.
- Used by: the user's default browser, opened via tray.

## Data Flow

### Primary Request Path — one dictation

1. User presses `Alt+Shift+D`; Electron fires the registered accelerator in `HotkeyService._register()` (`src/main/hotkeys.js:52`).
2. `PttState.press()` decides `start` / `lock` / `start-lock` / `stop` (`src/main/ptt.js:44`); `HotkeyService` emits `action` (`src/main/hotkeys.js:77`).
3. The listener in `main.js` switches on the action (`src/main/main.js:305`); `beginRecording()` increments `sessionId`, creates `targetPromise`, calls `recorder.start()` (`src/main/main.js:339`).
4. `Recorder.start()` sends `rec:start` to the status window (`src/main/recorder.js:65`).
5. The status renderer opens `getUserMedia` with 16 kHz mono constraints and loads the worklet via a Blob URL (`src/renderer/statusRenderer.js:128`). The worklet posts 640-sample (40 ms) Float32 chunks plus RMS level (`src/renderer/recorderWorklet.js:41`).
6. Renderer sends `rec:chunk` / `rec:level`; `Recorder` accumulates chunks and re-emits `level` (`src/main/recorder.js:40`).
7. Stop (second hotkey press, hands-free off, cancel, or max-length timer) triggers `Recorder.stop()` → `rec:stop` → worklet posts `done` → `Recorder._finish()` (`src/main/recorder.js:84`, `src/main/recorder.js:92`).
8. `_finish()` rejects recordings under 0.3 s, then `encodeWav()` builds a 16-bit WAV (`src/main/wav.js:14`) and emits `done`.
9. `onRecordingDone()` sends "Transcribing…" to the pill, awaits the foreground target, and starts an `AbortController` plus a keep-alive timer (`src/main/main.js:387`).
10. `transcribe()` builds a system prompt (`src/main/gemini.js:155`) and posts inline base64 audio to `streamGenerateContent?alt=sse` (`src/main/gemini.js:180`); the `SseParser` assembles partial text, forwarded via `onPartial` to the pill and event bus (`src/main/main.js:436`).
11. On success the pipeline records `lastRaw`/`lastCleaned`, calls `pasteInto()` (`src/main/main.js:463`), then writes the history entry and stats (`src/main/main.js:471`).
12. `pasteInto()` resolves the foreground window; if it belongs to Dictata it first focuses the remembered `lastTargetHwnd`; `pasteText()` snapshots the clipboard, writes text, focuses the target, and sends `^v` through `winHelper` (`src/main/paste.js:68`, `src/main/paste.js:113`).
13. `bus.publish('dictation', …)` fans out to dashboard SSE clients (`src/main/dashboard.js:260`); the pill shows the final text and auto-hides.

### Streaming Feedback Path (pill + dashboard)

1. Pipeline publishes `state`, `partial`, `level`, `dictation`, `error`, `info` via `EventBus.publish()` (`src/main/events.js:37`).
2. `main.js` sends `vf:status` directly to the status window for low-latency pill updates (`src/main/main.js:557`).
3. The same events reach `DashboardServer` via its `bus.on('event')` subscription, then `_broadcast()` writes `data: …\n\n` to each SSE response (`src/main/dashboard.js:260`).
4. `src/dashboard/app.js` `handleEvent()` updates local state and re-renders the relevant view (`src/dashboard/app.js:223`).
5. Errors and notes are additionally persisted by a bus listener that calls `store.addEvent()` (`src/main/main.js:100`).

### Dashboard Request Path

1. Tray → `openDashboard()` → `shell.openExternal(dashboard.url)` where the URL carries `?token=…` (`src/main/main.js:284`).
2. `DashboardServer._handle()` validates the `Host` header against DNS rebinding, then the token, then routes (`src/main/dashboard.js:161`).
3. `/api/state` builds a snapshot from `Store` + `EventBus` + `summarize()` (`src/main/dashboard.js:214`).
4. `/api/events` upgrades to SSE, sends `hello`, keeps a 25 s ping, and registers the response in `clients` (`src/main/dashboard.js:239`).
5. Static files are served from `src/dashboard` with an allow-list MIME map and a path-prefix check (`src/main/dashboard.js:186`).

**State Management:**
- The dictation state machine is a single module-level string in `src/main/main.js:69` (`idle` / `listening` / `processing`) mutated only through `setState()` (`src/main/main.js:545`).
- Per-recordings race protection uses a monotonically increasing `sessionId`; stale async completions compare `mySession !== sessionId` and bail (`src/main/main.js:388`, `src/main/main.js:443`).
- `handsFreeOn` mirrors `PttState.handsFree`; `bus.appState`/`bus.handsFree` mirror the same values for the dashboard.
- Persistence is owned by `Store`, which debounces writes 150 ms and writes atomically through a `.tmp` file (`src/main/store.js:126`).
- Renderers keep only ephemeral view state (`settings`, `recording`, `cancelled`); the dashboard keeps a normalized client cache (`state` object) refreshed by SSE.

## Key Abstractions

**EventBus (`src/main/events.js`):**
- Purpose: Decouple producers from UI/dashboard/persistence consumers.
- Examples: `state`, `partial`, `level`, `dictation`, `error`, `info` events created in `src/main/main.js`.
- Pattern: `EventEmitter` subclass with a bounded ring buffer (`limit: 500`), stable event ids, and a `PERSISTED_TYPES` allow-list.

**Store (`src/main/store.js`):**
- Purpose: Single source of truth for settings, dictionary, replacements, history, events, stats, dashboard token.
- Examples: `new Store()` singleton in `src/main/main.js:79`.
- Pattern: JSON document in `userData/dictata.json`, `mergeDefaults()` for forward-compatible schema migration, `safeStorage` encryption for the API key, `snapshot()` returns a `structuredClone`.

**Recorder (`src/main/recorder.js`):**
- Purpose: Own the main-side audio buffer lifecycle and encode the WAV.
- Pattern: `EventEmitter` (`level`, `done`, `error`) with a 1.5 s stop watchdog and a configurable max-length timer.

**PttState (`src/main/ptt.js`):**
- Purpose: Encode tap/double-tap/hands-free semantics as pure transitions returning `{ action, handsFree }`.
- Pattern: Pure class with injectable clock (`opts.now`) for deterministic tests.

**DashboardServer (`src/main/dashboard.js`):**
- Purpose: Local observability surface without adding a server dependency.
- Pattern: `node:http` server with manually routed endpoints, token-in-query auth, host allow-list, port fallback chain (`preferred … preferred+3`), SSE client set.

**WinHelper (`src/main/winhelper.js`):**
- Purpose: Fast Win32 calls without native modules.
- Pattern: One long-lived `powershell.exe` child; newline command protocol (`target`, `focus <hwnd>`, `keys <sendkeys>`) terminated by `__END__`, FIFO queue with per-command timeouts.

## Entry Points

**Electron main entry:**
- Location: `src/main/main.js` (declared as `main` in `package.json:5`)
- Triggers: `npm start` / `npm run dev` / packaged app launch
- Responsibilities: single-instance lock, user-data migration, `app.whenReady()` wiring (`src/main/main.js:125`), tray, IPC, hotkeys, dashboard, first-run settings.

**Global hotkeys:**
- Location: `src/main/hotkeys.js`
- Triggers: system-wide accelerators configured in `store.settings.shortcuts`
- Responsibilities: translate key presses into PTT actions and `paste-last`.

**IPC surface (renderer → main):**
- Location: `setupIPC()` in `src/main/main.js:570`
- Channels: `vf:get-store`, `vf:get-settings`, `vf:update-settings`, `vf:dashboard-url`, `vf:test-key`, `vf:set-dictionary`, `vf:set-replacements`, `vf:open-external`, `vf:open-dashboard`, `vf:dashboard-test`, `vf:delete-history`, `vf:clear-history`, `vf:paste-entry`
- Audio channels (from `recorder.attach()`): `rec:chunk`, `rec:level`, `rec:done`, `rec:error`

**IPC surface (main → renderer):**
- `vf:status`, `vf:settings`, `vf:history-updated` (targeted sends)
- `rec:start`, `rec:stop`, `rec:cancel` (recorder control)

**HTTP surface:**
- Location: `src/main/dashboard.js`
- Routes: `/`, `/api/state`, `/api/history`, `/api/events`, plus static assets under `src/dashboard`.

**CLI scripts:**
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

**What happens:** `src/main/main.js` (≈558 lines) simultaneously owns app lifecycle, window creation, tray menus, the state machine, the full dictation pipeline, partial-text throttling, error notification, IPC routing, and user-data migration.
**Why it's wrong:** Any change to the pipeline or windows touches the same file as unrelated concerns; it cannot be unit-tested without Electron, so pipeline behavior is only covered indirectly.
**Do this instead:** Follow the existing pure-module precedent (`ptt.js`, `wav.js`, `sse.js`): extract pipeline stages into Electron-free modules (e.g. a transcript/paste coordinator) and leave `main.js` as thin wiring, as the codebase already does for interaction rules.

### Duplicated state representations

**What happens:** The same logical state exists in four places: `state` in `main.js`, `PttState.active/handsFree`, `bus.appState/bus.handsFree`, and the renderer `STATES` table in `src/renderer/statusRenderer.js:23`.
**Why it's wrong:** Each copy must be synchronized manually in `setState()` and `HotkeyService.reset()`; a missed sync produces exactly the class of stuck-state bug the comments in `statusRenderer.js:115` and `main.js:513` describe.
**Do this instead:** Treat the main-process state machine as authoritative and derive UI/bus values in one place (`setState()`), or centralize the transition table in a pure module analogous to `src/main/ptt.js`.

### Variable shadowing across scopes

**What happens:** `lastPartialAt` exists both as a module-level throttle timestamp (`src/main/main.js:366`) and as a local `let` inside `onRecordingDone()` (`src/main/main.js:410`).
**Why it's wrong:** The keep-alive timer reads the local variable while `publishPartial()` updates the module-level one, so the two throttles can diverge and be misread during maintenance.
**Do this instead:** Use distinct names (e.g. `lastPartialPublishAt` vs `lastPartialAt`) or keep the timestamp on a single pipeline-scoped object.

### HTML string assembly in renderers

**What happens:** `src/renderer/historyRenderer.js:20` builds entries with `innerHTML` and embeds text in `data-text="${esc(...)}"` attributes; `src/dashboard/app.js` similarly builds icon/chart markup as template strings.
**Why it's wrong:** Transcription text is attacker-influenced audio output; escaping bugs or attribute-context mistakes become HTML/JS injection, and inline handlers (`onclick="toggleRaw(...)"`) bypass the preload boundary discipline used everywhere else.
**Do this instead:** Create elements with `document.createElement` and assign `textContent` for user data (as the pill does with `label.textContent` in `src/renderer/statusRenderer.js:38`), and attach listeners with `addEventListener` rather than inline attributes.

## Error Handling

**Strategy:** Fail visibly at the edges, keep the tray process alive, and classify every failure so the dashboard can group it.

**Patterns:**
- Global `uncaughtException` / `unhandledRejection` handlers log and continue (`src/main/main.js:118`).
- Pipeline `try/catch/finally` publishes an `error` event with `kind: 'api' | 'paste' | 'microphone' | 'cancel'`, updates the pill, shows a tray balloon, and always clears state in `finally` (`src/main/main.js:500`).
- Cancellation is a sentinel string (`new Error('Cancelled')`) thrown by aborting the HTTPS request (`src/main/gemini.js:263`) and recognized in the pipeline (`src/main/main.js:501`).
- Retry policy: retryable HTTP statuses and network/timeout errors walk a model fallback chain with a 60 s total budget; 400/401/403 fail fast (`src/main/gemini.js:103`, `src/main/gemini.js:285`).
- Recorder guards: minimum 0.3 s audio, 1.5 s stop watchdog, max-length auto-stop (`src/main/recorder.js:84`).
- WinHelper degrades to empty string / `false` on timeout or process exit rather than throwing (`src/main/winhelper.js:132`).
- Store never throws from load or save; it falls back to defaults or logs (`src/main/store.js:108`, `src/main/store.js:126`).
- Logging must never throw; `logger.write()` swallows all errors (`src/main/logger.js:40`).

## Cross-Cutting Concerns

**Logging:** `logger.init(app)` monkey-patches `console.log/warn/error` to append to `%APPDATA%/Dictata/logs/dictata.log` with 512 KB rotation (`src/main/logger.js:18`). All modules use plain `console.*` with `[module]` prefixes.

**Validation:** Deliberately light. `updateSettings()` clamps `maxRecordingSec` to 15–1800 s (`src/main/store.js:151`); `open-external` allows only `http(s)` URLs (`src/main/main.js:606`); dashboard static paths are prefix-checked (`src/main/dashboard.js:188`); API key is trimmed and falls back to `process.env.GEMINI_API_KEY` (`src/main/main.js:31`).

**Authentication:** The dashboard uses a stable random token persisted in the store (`getOrCreateToken()`, `src/main/store.js:167`) and required as a query parameter on every API route. The Gemini API key is stored encrypted with `safeStorage` (DPAPI) and transparently decrypted on first access (`src/main/store.js:116`).

**User-data identity:** The app was renamed from `voice-flow` to `Dictata`; `migrateUserData()` pins `userData` to `%APPDATA%/Dictata` and copies/renames the legacy folder, store, and log (`src/main/main.js:37`).

---

*Architecture analysis: 2026-10-22*
