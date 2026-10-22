---
last_mapped_commit: 0439ed1ae6b93347340f8af55ab3cb3f630a64f4
last_mapped_at: 2026-10-22
---
# Codebase Concerns

**Analysis Date:** 2026-10-22

> Scope: full repo. Electron 44 tray app ("Dictata") — Windows-only push-to-talk
> dictation. ~2.6k lines of app code in `src/`, 10 test files in `test/`, 4 dev
> scripts in `scripts/`. Working tree is clean; 10 commits, no CI, no lint config.

## Tech Debt

**`src/main/main.js` is a 558-line god module:**
- Issue: Orchestration, state machine, window lifecycle, tray menu, IPC handlers, migration, dashboard lifecycle, paste targeting and logging all live in one file.
- Files: `src/main/main.js`
- Impact: Every pipeline change risks a window/tray/IPC regression; the state machine cannot be unit-tested because transitions are interleaved with Electron calls.
- Fix approach: Extract an `AppController` (state transitions + session guard) that takes recorder/gemini/paste as injected dependencies, leaving `main.js` as wiring only. Move IPC registration to `src/main/ipc.js`.

**Electron-bound modules have no automated coverage:**
- Issue: Only pure modules (`ptt.js`, `wav.js`, `sse.js`, `analytics.js`, `gemini` request building, `mergeDefaults`) are tested. `paste.js`, `recorder.js`, `winhelper.js`, `logger.js`, `dashboard` auth paths and all of `main.js` are untested.
- Files: `src/main/paste.js`, `src/main/recorder.js`, `src/main/winhelper.js`, `src/main/logger.js`, `src/main/main.js`, `test/*.test.js`
- Impact: The bugs below (mic teardown, PTT desync, dead IPC channel, stats drift) all shipped despite a green suite.
- Fix approach: Make the paste orchestration injectable (clipboard + winHelper fakes) and test restore/`allowKeys`/focus-failure branches; unit-test `Recorder` with a fake status window and ipcMain stub; test dashboard 403/401/404/path handling.

**Dead IPC channel — History → Settings button does nothing:**
- Issue: `historyPreload.js:10` sends `vf:open-settings`; `main.js:570-621` never registers a handler for it (all others use `ipcMain.handle`).
- Files: `src/renderer/historyPreload.js`, `src/renderer/historyRenderer.js`, `src/main/main.js`
- Impact: "Settings" in the History window is silently broken.
- Fix approach: Add `ipcMain.on('vf:open-settings', () => createSettingsWindow())` next to the other IPC handlers.

**Duplicated word-count implementations:**
- Issue: `store.addHistory` re-implements the split/trim count inline while `analytics.wordCount` already exists and is used everywhere else.
- Files: `src/main/store.js:184`, `src/main/analytics.js:11`
- Impact: Counter and dashboard can drift if either normalization changes.
- Fix approach: Import `wordCount` in `store.js`.

**Stale build configuration for a removed native dependency:**
- Issue: `package.json:26-28` allow-lists `uiohook-napi@1.5.5`, but the package is not a dependency and hotkeys use Electron's `globalShortcut`.
- Files: `package.json`
- Impact: Misleading install config; a future `npm install` reviewer may assume native hooks are used.
- Fix approach: Delete the `allowScripts` block.

**No lint, formatter, type-check or CI:**
- Issue: No `.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `tsconfig.json`, `.github/` or any pipeline. `package.json` has no `engines` field.
- Files: `package.json`
- Impact: Style and correctness issues (e.g. `.catch` on `undefined`, unguarded `new URL`) are caught only at runtime; README's "Node 18+" is unenforced and, for `node --test "test/**/*.test.js"`, wrong (glob expansion needs Node ≥21).
- Fix approach: Add ESLint (`no-floating-promises`, `no-undef` would have caught `vf:open-settings`), declare `"engines": { "node": ">=21" }`, add a GitHub Actions job running `npm test` on `windows-latest`.

**Module-level mutable pipeline state:**
- Issue: `lastCleaned`, `lastRaw`, `handsFreeOn`, `sessionId`, `lastPartialText`, `lastPartialAt`, `lastTargetHwnd` are module globals; `onRecordingDone` re-declares a shadowing `lastPartialAt` at `main.js:410`.
- Files: `src/main/main.js:69-76`, `src/main/main.js:365-372`, `src/main/main.js:410`
- Impact: Shadowing makes throttling behaviour easy to break; globals make the pipeline untestable in parallel.
- Fix approach: Hold session-scoped state in an object created per recording; pass it into `transcribe`/`onRecordingDone`.

**No settings schema validation:**
- Issue: `updateSettings` merges arbitrary keys; only `maxRecordingSec` is clamped. `dashboardPort` is not validated at load time, and `mergeDefaults` accepts any stored type.
- Files: `src/main/store.js:76-93`, `src/main/store.js:148-157`, `src/main/main.js:589-593`
- Impact: A string `dashboardPort` reaches `DashboardServer.start()` where `preferred + 1` string-concatenates and `server.listen('77881')` would create a named pipe, yielding `http://127.0.0.1:undefined/`. A hand-edited `shortcuts` value that is not an array throws inside `toAccelerator`.
- Fix approach: Validate/coerce on load (port 1024-65535, shortcuts as `string[]`, style/model/language against allow-lists) and reject unknown keys.

## Known Bugs

**Microphone teardown crashes after suspend / device change:**
- Symptoms: Next dictation fails with `Microphone error: Cannot read properties of undefined (reading 'catch')`; the pill shows an error and nothing records.
- Files: `src/renderer/statusRenderer.js:133`
- Trigger: `ensureContext()` early-returns only when `audioCtx.state === 'running'`. After OS sleep, or after switching mics, the context is `suspended`, so the teardown line runs: `await stream?.getTracks().forEach((t) => t.stop()).catch(...)` — `forEach` returns `undefined`, and `.catch` is read from `undefined`.
- Workaround: Restart the app.
- Fix approach: `for (const t of stream?.getTracks() ?? []) t.stop();` inside a `try/catch`; also disconnect `sourceNode`/`workletNode` and null them before rebuilding.

**Recorder error path bypasses the state machine:**
- Symptoms: After a "Recording too short" / "No audio from microphone" error, the next PTT press is swallowed; the user must press twice.
- Files: `src/main/main.js:203-210`
- Trigger: `recorder.on('error')` assigns `state = STATE.IDLE` directly instead of calling `setState(STATE.IDLE)`, so `hotkeys.reset()` never runs and `PttState.active` stays `true`; the next press emits `'stop'`, which `main.js:321` ignores because state is already IDLE.
- Fix approach: Replace the direct assignment with `setState(STATE.IDLE)` (after publishing the error) so PTT state and app state stay in sync.

**`window-all-closed` handler calls `preventDefault()` on a non-existent event:**
- Symptoms: `[dictata] uncaught exception: TypeError: Cannot read properties of undefined (reading 'preventDefault')` in the log whenever the last window closes.
- Files: `src/main/main.js:166`
- Trigger: Electron's `window-all-closed` listener receives no Event argument: `app.on('window-all-closed', (e) => e.preventDefault())`.
- Fix approach: Use `app.on('window-all-closed', () => { /* stay in tray */ })`.

**Opening the dashboard while it is disabled reports a false failure:**
- Symptoms: Tray shows "Start Dashboard"; clicking it produces the balloon "The dashboard could not be started — check the log file."
- Files: `src/main/main.js:139-147`, `src/main/main.js:284-292`
- Trigger: `startDashboard()` returns early when `settings.dashboardEnabled` is false, so `dashboard.url` stays null.
- Fix approach: In `openDashboard`, check `dashboardEnabled` and either open Settings on the dashboard panel or enable it explicitly before starting.

**Lifetime word totals silently freeze / diverge from history:**
- Symptoms: "Total words" on the dashboard stops growing after 500 dictations; after "Clear history" the dashboard shows zero dictations but a non-zero lifetime word count; deleting one entry does not adjust stats.
- Files: `src/main/store.js:46`, `src/main/store.js:181-196`, `src/main/analytics.js:59`, `src/main/analytics.js:129`, `src/main/dashboard.js:228-233`
- Trigger: `analytics.summarize` recomputes `totals.words` from `history`, which is capped at 500 and truncated by `clearHistory`/`deleteHistory`, while `stats.words` accumulates forever and is only surfaced as `lifetimeWords`.
- Fix approach: Render both explicitly (`lifetimeWords` vs `windowWords`), or keep per-day rollups in the store so aggregates survive history pruning; decrement stats in `deleteHistory`/`clearHistory`.

**API-key field auto-saves partial and empty values:**
- Symptoms: Clearing the key field to paste a new key immediately persists `apiKey: ''`; while typing, truncated keys are saved and the `.env` fallback can temporarily take over. Every keystroke round-trips an encrypted full-file write.
- Files: `src/renderer/settingsRenderer.js:251-257`, `src/main/store.js:126-141`
- Trigger: `input` listener debounced 400 ms calls `save({ apiKey: ... })`.
- Fix approach: Save on `change`/blur or an explicit Save button, and only when the trimmed value is non-empty (or when the user clears it deliberately).

**Day buckets can be off by one hour across DST:**
- Symptoms: Entries near midnight can land in the wrong day bucket on DST transition days.
- Files: `src/main/analytics.js:70-81`
- Trigger: `startOfDay(now - i * DAY_MS)` subtracts a fixed 86,400,000 ms from a local timestamp.
- Fix approach: Build day boundaries with `new Date(y, m, d - i)` rather than millisecond arithmetic.

**Dashboard is stale after desktop-side history changes:**
- Symptoms: Deleting or clearing history from the Electron History window leaves the open dashboard showing the old rows until it polls/reloads.
- Files: `src/main/main.js:618-619`, `src/main/dashboard.js:88`
- Trigger: `vf:delete-history` / `vf:clear-history` write to the store but publish no bus event, and the dashboard only re-renders on `dictation` / `error` / `info` events.
- Fix approach: Publish a `history-changed` event (or `info` with kind) from those IPC handlers.

**"Paste last" is empty after a restart:**
- Symptoms: `Alt+Shift+V` does nothing until a dictation is made in the current run.
- Files: `src/main/main.js:334-337`, `src/main/main.js:70`
- Trigger: `lastCleaned` lives only in memory; the store already has the newest entry in `history`.
- Fix approach: Fall back to `store.snapshot().history[0]?.cleaned`.

## Security Considerations

**Gemini API key crosses IPC in plaintext and is rendered into the DOM:**
- Risk: Any renderer compromise (or XSS in a future dashboard/renderer change) exfiltrates the key. DPAPI encryption protects the file at rest only.
- Files: `src/main/main.js:572`, `src/main/store.js:198-201`, `src/renderer/settingsRenderer.js:251`, `src/renderer/historyPreload.js:5`
- Current mitigation: `safeStorage` (DPAPI) encrypts the key on disk (`store.js:50-73`); `contextIsolation: true`, `nodeIntegration: false`.
- Recommendations: Stop returning `settings.apiKey` from `vf:get-store` — add a dedicated `vf:get-key-status` (boolean) and a write-only `vf:set-api-key`; remove `getStore` from the History window preload (it only needs history). Mask the value in the UI (show last 4 chars).

**Dashboard bearer token is treated as a URL parameter and written to the log:**
- Risk: The token lands in `%APPDATA%\Dictata\logs\dictata.log` (`console.log('[dashboard] serving', this.url)` is mirrored by the logger), in browser history, in the "Copy link" clipboard, and in any screenshot/support bundle. Anyone with the token can read every transcript over `/api/history`.
- Files: `src/main/dashboard.js:95-100`, `src/main/dashboard.js:126`, `src/main/main.js:89`, `src/main/logger.js:33-35`, `src/main/store.js:167-172`
- Current mitigation: Bound to `127.0.0.1`; `Host` allow-list blocks DNS rebinding (`dashboard.js:166-168`, `203-207`); token required on `/api/*`.
- Recommendations: Log only host/port (never the URL/token); add a "rotate token" action in Settings (call `getOrCreateToken` after clearing); prefer a same-site cookie set from a token-bearing landing redirect so the token is not kept in history; compare with `crypto.timingSafeEqual`.

**No Content-Security-Policy anywhere; no navigation guards:**
- Risk: All four HTML documents load scripts without CSP. Electron will warn (`Insecure Content-Security-Policy`). No `will-navigate` / `setWindowOpenHandler` guard exists, and the permission handler grants `media`/`microphone` to *every* webContents.
- Files: `src/renderer/status.html:198`, `src/renderer/settings.html:475`, `src/renderer/history.html:136`, `src/dashboard/index.html:186`, `src/main/main.js:171-176`
- Current mitigation: Renderers use `textContent`/`esc()` for transcripts; the dashboard never loads remote resources (enforced by `test/page.test.js`).
- Recommendations: Add `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'">` to each page; call `webContents.setWindowOpenHandler(() => ({ action: 'deny' }))` and block `will-navigate` for all app windows; scope the permission handler to `statusWindow.webContents` and deny everything else.

**Dashboard static-file guard uses string-prefix containment:**
- Risk: `path.join(ROOT, file).startsWith(ROOT)` is not a containment check — a sibling directory whose name begins with `dashboard` (e.g. `src/dashboard-backup/x`) passes. On Windows, backslash-bearing paths are normalized inconsistently between the URL parser and `path.join`.
- Files: `src/main/dashboard.js:185-188`
- Current mitigation: Server is loopback-only, and `URL` normalizes most `..` segments; the served directory contains only static assets.
- Recommendations: `const rel = path.relative(ROOT, full); if (rel.startsWith('..') || path.isAbsolute(rel)) return 403;` and reject `%00`.

**Unhandled exceptions are swallowed; malformed HTTP requests can hang a handler:**
- Risk: `process.on('uncaughtException')` only logs (`main.js:118-123`), so a corrupted pipeline stays "running" in an unknown state. `new URL(req.url, ...)` (`dashboard.js:162`) throws on malformed request targets; Node does not catch async handler rejections, so the request never gets a response.
- Files: `src/main/main.js:118-123`, `src/main/dashboard.js:161-168`
- Recommendations: Wrap `_handle` in `try/catch` returning 400; track a `pipelineHealthy` flag and force `setState(IDLE)` after a recovered exception; keep the swallow only for genuinely non-fatal errors.

**IPC handlers trust any renderer and any payload:**
- Risk: No handler checks `event.sender`. `vf:paste-entry` accepts arbitrary text and drives `SendKeys` into the previously focused app; `vf:update-settings` accepts arbitrary keys; `vf:set-dictionary`/`set-replacements` accept arbitrary shapes that are later interpolated into the Gemini prompt (`gemini.js:170-171`).
- Files: `src/main/main.js:570-621`, `src/renderer/historyPreload.js`, `src/renderer/settingsPreload.js`
- Recommendations: Validate `event.senderFrame` against the known windows; validate shapes (`Array<{term: string}>`, length caps) and reject non-strings; cap dictionary/replacement counts.

**PowerShell helper is spawned by bare name and silences its own errors:**
- Risk: `spawn('powershell.exe', ...)` resolves through `PATH` (binary planting if an attacker controls a PATH entry). `$ErrorActionPreference = 'SilentlyContinue'` plus a discarded stderr stream (`stdio: [..., 'ignore']`) means a failed `SendKeys` still emits `__END__` and is reported as success.
- Files: `src/main/winhelper.js:19`, `src/main/winhelper.js:79-82`, `src/main/winhelper.js:96-98`
- Recommendations: Spawn `path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')`; capture stderr; have the script return explicit `ok`/`fail` for `keys`.

**API key can come from a CWD `.env` and from an unencrypted fallback:**
- Risk: `require('dotenv').config()` reads `.env` from the process working directory, so launching from a folder containing a crafted `.env` changes which key is used. `encryptSecret` silently returns plaintext when `safeStorage` is unavailable (`store.js:51-61`), with no UI warning.
- Files: `src/main/main.js:13`, `src/main/main.js:31`, `src/main/store.js:50-73`
- Current mitigation: `.env` is gitignored (only `.env.example` is tracked); a `.env` file is present in the working tree (contents not inspected).
- Recommendations: Load dotenv only when `!app.isPackaged`, from `app.getAppPath()`; surface a warning/disable key entry if `safeStorage.isEncryptionAvailable()` is false.

**Unsigned installer, no auto-update, no integrity check:**
- Risk: `electron-builder` config has no code-signing settings and there is no updater, so updates are manual and SmartScreen will warn; a stale build artifact named `Voice Flow Setup 0.1.0.exe` still sits in `dist/` under the pre-rename product name.
- Files: `package.json:29-61`, `dist/`
- Recommendations: Sign the NSIS installer, add `electron-updater` (or document manual upgrade), and clean `dist/` before release.

## Performance Bottlenecks

**Whole-store synchronous rewrite on every save:**
- Problem: `_save()` serializes the entire data object (up to 500 transcripts + 500 events) and does `writeFileSync` + `renameSync` on the main thread, 150 ms after every history add, event add and settings change.
- Files: `src/main/store.js:126-141`, `src/main/store.js:174-189`
- Cause: Single JSON document, no incremental storage, no debounce longer than 150 ms.
- Improvement path: Write history/events to an append-only JSONL or SQLite; at minimum raise the debounce to 1-2 s and write off-thread; prune stored `raw` when it equals `cleaned`.

**Full `structuredClone` of the store on every read:**
- Problem: `snapshot()` clones all history/events/settings — including the decrypted API key — for every `vf:get-store`, every `updateTrayMenu()` (which only needs `stats`), and every dashboard `/api/state`.
- Files: `src/main/store.js:198-201`, `src/main/main.js:269`, `src/main/dashboard.js:214-237`
- Cause: Coarse accessor with no projection.
- Improvement path: Add `snapshot({ fields })` / `getStats()` / `getHistory()` and stop including `settings.apiKey`.

**Dashboard recomputes analytics on every request and after every event:**
- Problem: `/api/state` deep-clones history, sorts up to 1000 events in `collectEvents`, and runs `summarize` (7-day loops, maps) each time. The client calls it 400 ms after every dictation/error and on every retry.
- Files: `src/main/dashboard.js:46-70`, `src/main/dashboard.js:214-237`, `src/dashboard/app.js:267-272`
- Cause: No caching or incremental aggregation.
- Improvement path: Cache the summarized payload keyed by a store revision counter; compute rollups on write.

**Audio is held and copied several times, and the cap permits impossible recordings:**
- Problem: Float32 chunks (64 KB/s) are copied by IPC, retained in `_chunks`, converted to a 16-bit WAV (~32 KB/s), then base64-expanded (+33%) into one HTTPS request that `https.request` buffers.
- Files: `src/main/recorder.js:40-44`, `src/main/recorder.js:124-126`, `src/main/gemini.js:108`, `src/main/store.js:152`
- Cause: `maxRecordingSec` is clamped to 1800 s (30 min) while the inline-audio request has a practical ~20 MB limit (≈8 min of base64 WAV at 16 kHz/16-bit). Long dictations will fail after buffering ~100 MB.
- Improvement path: Cap the UI at the inline limit (~5-6 min, as the README claims), stream to a temp file, or switch to the Files API for long audio; avoid the intermediate base64 string copy.

**Synchronous logging on the main thread:**
- Problem: Every `console.log/warn/error` is mirrored with `fs.appendFileSync`, including startup, per-dictation and per-fallback messages.
- Files: `src/main/logger.js:33-47`
- Improvement path: Buffer lines and flush on a timer, or use an async stream.

**PowerShell startup cost and ready-race on the critical path:**
- Problem: The helper compiles `Add-Type` at launch (1-2 s) and every `_cmd` waits on a 4 s readiness race; `beginRecording` and `pasteInto` both issue `foregroundTarget()` synchronously in their flows.
- Files: `src/main/winhelper.js:96-111`, `src/main/winhelper.js:132-146`, `src/main/main.js:348`, `src/main/main.js:526`
- Improvement path: Warm the helper before the first hotkey and/or replace the PowerShell helper with a small native addon (koffi/node-gyp) or `nircmd`-style binary.

**No SSE client cap or backpressure handling:**
- Problem: `this.clients` grows with every open tab; `res.write()` backpressure is ignored, so a stalled tab accumulates buffered data in memory.
- Files: `src/main/dashboard.js:239-266`
- Improvement path: Cap clients (e.g. 8), check the `write()` return value, and drop/close slow consumers.

## Fragile Areas

**PowerShell stdio protocol can desynchronize:**
- Files: `src/main/winhelper.js:113-146`
- Why fragile: Commands are matched to replies by a FIFO queue terminated by `__END__`. On timeout the entry is removed from `this.queue`, but PowerShell still writes its late reply and `__END__`; the *next* command then consumes those stale lines and resolves with the previous command's output (or empty). On process exit, pending commands resolve `''`, which callers cannot distinguish from "no foreground window".
- Safe modification: Add a monotonic request id echoed by the script and ignore lines whose id does not match the head of the queue; reject rather than resolve `''` on exit/timeout.
- Test coverage: None.

**Paste can land in the wrong window, or report success when nothing happened:**
- Files: `src/main/paste.js:68-107`, `src/main/main.js:524-542`, `src/main/winhelper.js:79-82`
- Why fragile: `SendKeys` targets whatever is foreground at the instant it runs. `pasteInto` only detects "our own window" when the helper successfully reports `self`; if the helper is down/desynced (`self: false`, `hwnd: 0`), `allowKeys` stays true and Ctrl+V is sent to the focused Dictata window. `SendKeys` failures are silenced, so `pasted: true` can be returned after nothing was inserted. A focus change between the 40 ms focus verification and the keystroke (or a hung target app) sends the keys elsewhere.
- Safe modification: Treat an empty/unparsable `foregroundTarget` as "unknown" and refuse to send keys; send keys only after re-verifying `GetForegroundWindow()` inside the same helper command; return an explicit `keys ok|fail` result.
- Test coverage: Only `scripts/test-paste.js`, which is interactive and not run in CI.

**Clipboard restore races the user:**
- Files: `src/main/paste.js:92-104`
- Why fragile: Restore is a fixed 600 ms timer. Slow apps (remote desktop, Office) may not have read the clipboard yet; conversely, if the user copies something new within 600 ms, it is overwritten by the restore. When `restoreClipboard` is off, the user's previous clipboard is permanently replaced.
- Safe modification: Make the delay configurable, skip restore if the clipboard no longer equals the text we wrote, and/or restore only after the target app's paste is confirmed.
- Test coverage: `scripts/test-paste.js` only, with fixed sleeps.

**Tray app with no fallback UI:**
- Files: `src/main/main.js:165-166`, `src/main/main.js:259-266`
- Why fragile: `window-all-closed` is suppressed, so the tray icon is the only way to reach Settings/Quit. If `new Tray(...)` throws (missing/corrupt `assets/tray-icon.png`), the process keeps running invisibly with hotkeys registered and no way to quit. The status pill is `focusable: false` and click-through.
- Safe modification: Wrap `createTray()` in try/catch and quit (or show a normal window) on failure; add a `--settings` CLI escape hatch.
- Test coverage: None.

**Dashboard start/stop is racy:**
- Files: `src/main/dashboard.js:112-157`, `src/main/main.js:582-593`
- Why fragile: `start()` only guards on `this.server`, which is set after `await this._listen()`. Two rapid "enable" toggles (or tray click + settings change) can bind two servers and leak one; `stop()` during an in-flight `start()` leaves the app serving despite `dashboardEnabled = false`. Changing the port leaves old browser tabs pointed at a dead port.
- Safe modification: Serialize lifecycle with a `this._starting` promise; re-check `enabled` after `await`; publish a `dashboard-url` event so open pages can react.
- Test coverage: `test/dashboard.test.js` covers port fallback, not concurrent start/stop.

**Single-instance + startup migration runs before the app is ready:**
- Files: `src/main/main.js:40-65`, `src/main/main.js:111-115`
- Why fragile: `migrateUserData()` runs at module load and recursively copies the legacy folder; a partially copied legacy directory makes `fs.existsSync(target)` true forever, so the migration never finishes and the store may load truncated data. A second instance calls `app.quit()` and then `process.exit(0)`, skipping normal cleanup.
- Safe modification: Write a `.migration-complete` marker after a successful copy, migrate inside `whenReady()`, and let `app.quit()` run without `process.exit`.
- Test coverage: None.

**Hotkeys are configurable in the store but not in the UI:**
- Files: `src/renderer/settingsRenderer.js:112-123`, `src/main/hotkeys.js:81-94`
- Why fragile: Settings only *displays* chords; a hand-edited store value that is not `string[]` throws in `toAccelerator` during startup (`hotkeys.start()` is not wrapped in try/catch). Registration failures only warn to the log — the user sees "nothing happens" with no in-app indication.
- Safe modification: Validate chords before registering; surface registration failures in the tray/pill; either build the editor or remove the implication that shortcuts are customizable.
- Test coverage: `test/hotkeys.test.js` covers `toAccelerator` only.

## Scaling Limits

**History retention:**
- Current capacity: 500 entries (`HISTORY_LIMIT`, `store.js:46`), 500 persisted events (`EVENT_LIMIT`, `store.js:47`), 500 in-memory bus events (`main.js:82`), 300 in the dashboard timeline (`dashboard.js:69`).
- Limit: Beyond 500 dictations, analytics ("total words", 7-day charts, streak) silently omit older data while `stats.words` keeps counting.
- Scaling path: Per-day rollups in the store, or SQLite with indexed queries and a documented retention policy.

**Single-request audio size:**
- Current capacity: ~32 KB/s WAV; base64 request body ~43 KB/s; practical inline limit ~20 MB.
- Limit: `maxRecordingSec` allows 1800 s, which needs ~77 MB base64 — the request will be rejected or time out (30 s per attempt, 60 s total budget in `gemini.js:23-24`).
- Scaling path: Clamp the setting to the real limit, or upload via the Files API and reference the URI.

**Transcript length:**
- Current capacity: `MAX_OUTPUT_TOKENS = 4096` (`gemini.js:25`).
- Limit: Long dictations hit `MAX_TOKENS`; the code detects it and warns (`gemini.js:217`, `main.js:490-492`) but the user loses the tail.
- Scaling path: Chunk long audio into overlapping segments and stitch, or raise the limit where the model supports it.

**Model chain is hardcoded:**
- Current capacity: `gemini-2.5-flash` + `['gemini-2.5-flash','gemini-3.5-flash','gemini-3.6-flash']` (`gemini.js:21-22`).
- Limit: If Google retires or renames these, every dictation fails until an app update; `RETIRED` only maps `1.x`, `2.0`, and `pro-vision` (`gemini.js:28`).
- Scaling path: Query `models.list` once at startup, cache the result, and let Settings pick from what the key can actually use.

## Dependencies at Risk

**Electron `^44.9.0` (devDependency):**
- Risk: Major-version caret means a fresh `npm install` can jump minor/patch; Electron majors frequently change `clipboard` (already async-shimmed in `paste.js:20-56`) and `safeStorage` behaviour. No lockfile-independent constraint (`package-lock.json` exists, but CI/clean installs may update).
- Impact: Silent breakage of paste/encryption on reinstall.
- Migration plan: Pin exact Electron versions, test major upgrades via the `test:paste` script, and commit the lockfile (already present).

**`dotenv` `^18.0.8` (only production dependency):**
- Risk: Version range should be verified against npm at install time; dotenv is used only for dev fallback but is shipped as a runtime dependency. It also reads the process CWD.
- Impact: Install failure or surprising key source.
- Migration plan: Move to `devDependencies` or replace with a small `app.isPackaged`-gated reader; pin the version.

**`electron-builder` `^26.15.3`:**
- Risk: Build tooling drift changes NSIS output; no signing config, so releases are unsigned.
- Impact: SmartScreen warnings; unreproducible installers.
- Migration plan: Pin the version, add signing, and produce checksums in the release notes.

**Stale native-hook allow-list (`uiohook-napi`):**
- Risk: References a package that is not installed, implying native hooks that no longer exist.
- Impact: Confusion during dependency audits.
- Migration plan: Remove `allowScripts` from `package.json:26-28`.

## Missing Critical Features

**Context-aware insertion is stubbed:**
- Problem: `textBefore`/`textAfter` are hardcoded to `''` with a "Phase 2" comment, so the prompt's cursor-context block never activates.
- Files: `src/main/main.js:432-433`, `src/main/gemini.js:173`
- Blocks: True app-aware insertion (e.g. continuing a sentence, formatting into the right field).

**No raw-vs-cleaned transcript:**
- Problem: `transcribe` returns `raw: cleaned` (`gemini.js:147`), so History's "Show raw" toggle (`historyRenderer.js:26-33`) can never appear and users cannot recover filler words.
- Files: `src/main/gemini.js:146-152`
- Blocks: Verbatim recovery and prompt-debugging.

**No in-app shortcut editor:**
- Problem: `shortcuts` exist in the store and README documents them as defaults, but Settings only renders keycaps.
- Files: `src/renderer/settingsRenderer.js:112-123`
- Blocks: Resolving hotkey conflicts without hand-editing `dictata.json`.

**No export/backup, no per-entry retention control:**
- Problem: History can only be cleared wholesale (`vf:clear-history`); no export, no archive, no undo.
- Files: `src/main/main.js:618-619`, `src/renderer/historyRenderer.js:58-62`
- Blocks: Users migrating machines or preserving transcripts before a reset.

**No crash reporting or health surface:**
- Problem: Failures are only visible in `dictata.log`; the pill shows an error for 6 s and the tray balloon is best-effort.
- Files: `src/main/main.js:294-302`, `src/main/logger.js`
- Blocks: Diagnosing "it stopped working" reports without asking for the log file.

## Test Coverage Gaps

**Pipeline orchestration (`main.js`):**
- What's not tested: Session supersession (`sessionId`), cancel/abort, `targetPromise` resolution, paste-failure storage, tray updates, state transitions, IPC handlers.
- Files: `src/main/main.js`
- Risk: Regressions like the PTT-desync bug and the dead `vf:open-settings` channel are invisible.
- Priority: High.

**Paste + window targeting:**
- What's not tested: `allowKeys=false`, focus failure, malformed HWND, clipboard restore paths (HTML vs text vs empty), helper timeout desync.
- Files: `src/main/paste.js`, `src/main/winhelper.js`
- Risk: Text silently pasted into the wrong app; clipboard destroyed.
- Priority: High.

**Recorder state machine:**
- What's not tested: `_finish` watchdog, too-short audio, max-duration timeout, `rec:error` cleanup, chunk accumulation.
- Files: `src/main/recorder.js`
- Risk: The app can hang in "Processing" (the exact class of bug the comments say was already fixed once).
- Priority: High.

**Renderer audio capture:**
- What's not tested: `ensureContext` teardown (contains the known crash), device fallback, cancel-vs-stop sequencing.
- Files: `src/renderer/statusRenderer.js`, `src/renderer/recorderWorklet.js`
- Risk: Microphone dead after sleep; no automated signal at all.
- Priority: High.

**Store persistence and encryption:**
- What's not tested: `_save` debounce/flush, `encryptSecret`/`decryptSecret` round-trip, plaintext legacy migration, history/event caps, delete/clear stats consistency, token creation.
- Files: `src/main/store.js`
- Risk: API key lost or stored in the clear; history truncated unexpectedly.
- Priority: Medium-High.

**Dashboard security and error paths:**
- What's not tested: `Host` rejection (403), path traversal attempts, `/api/history`, 404 handling, malformed URL handling, concurrent start/stop, SSE client cleanup.
- Files: `src/main/dashboard.js`, `test/dashboard.test.js`
- Risk: Local data exposure or hung requests.
- Priority: Medium-High.

**Gemini fallback chain:**
- What's not tested: retry on 429/503, timeout hand-off to the next model, total-budget exhaustion, `retryAfter` parsing, non-200 body parsing, echo detection, truncation.
- Files: `src/main/gemini.js:98-153`, `test/gemini.test.js`
- Risk: A capacity blip surfaces as a hard failure; retry storms are unmeasured.
- Priority: Medium.

**Renderer UIs (settings/history/dashboard client):**
- What's not tested: settings save flows, dictionary/replacement add-remove, history re-render, dashboard reconnection/backoff, escaping of malicious transcripts.
- Files: `src/renderer/settingsRenderer.js`, `src/renderer/historyRenderer.js`, `src/dashboard/app.js`
- Risk: `test/page.test.js` only checks static strings; behaviour is unverified.
- Priority: Medium.

**Destructive dev script:**
- What's not tested / risky: `scripts/test-paste.js:79` runs `taskkill /IM notepad.exe /F`, killing **every** Notepad window (including unsaved user work). It also continues pasting even when the "Notepad is foreground" assertion fails (`:50-55`), so Ctrl+V can be sent into whatever app is focused.
- Files: `scripts/test-paste.js`
- Risk: Data loss on a developer machine.
- Fix: Record the spawned PID and kill only that process (or close via a WM_CLOSE), and abort the paste when the foreground check fails.
- Priority: High (developer safety).

---

*Concerns audit: 2026-10-22*
