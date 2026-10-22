---
last_mapped_commit: 0439ed1ae6b93347340f8af55ab3cb3f630a64f4
last_mapped_at: 2026-10-22
---
# External Integrations

**Analysis Date:** 2026-10-22

## APIs & External Services

**Speech-to-text + text cleanup (the only production network API):**
- Google Gemini API — takes the recorded WAV inline (base64) and returns the cleaned transcript in a single streaming call that both transcribes and edits.
  - SDK/Client: none — raw `https.request` in `src/main/gemini.js:180-279`
  - Host: `generativelanguage.googleapis.com` (`src/main/gemini.js:17`)
  - Endpoint: `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` (`src/main/gemini.js:109`)
  - Auth: `x-goog-api-key` header (`src/main/gemini.js:196`). Key source: encrypted value from the JSON store, falling back to `process.env.GEMINI_API_KEY` (`src/main/main.js:31`). Key entry UI is in `src/renderer/settingsRenderer.js`; verification via `testKey()` (`src/main/gemini.js:295-323`) behind IPC `vf:test-key` (`src/main/main.js:601`).
  - Models: default `gemini-2.5-flash`, fallback chain `['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.6-flash']` (`src/main/gemini.js:21-22`). Retired model ids are remapped (`RETIRED` regex, `src/main/gemini.js:28-36`).
  - Request shape: `systemInstruction` (prompt built in `buildSystemPrompt`, `src/main/gemini.js:155-177`), `inlineData` `audio/wav`, `temperature: 0.1`, `maxOutputTokens: 4096`, `thinkingConfig.thinkingLevel: "minimal"` only for Gemini 3.x (`src/main/gemini.js:51-69`).
  - Reliability: 30 s per-request timeout, 60 s total budget, retry on 408/429/500/502/503/504 plus network/timeouts, honours `Retry-After` (`src/main/gemini.js:23-29`, `111-132`, `236-240`).
  - Cancellation: `AbortSignal` from `src/main/main.js:406-407`, destroyed request in `src/main/gemini.js:261-268`.
  - Live smoke test: `scripts/test-api.js` (`npm run test:api`).

**Documentation / key acquisition (outbound links only):**
- `https://aistudio.google.com/apikey` — opened in the system browser via `shell.openExternal` when the user clicks "get a key". IPC `vf:open-external` validates `^https?://` first (`src/main/main.js:606-608`); call site `src/renderer/settingsRenderer.js:274`.

**Web fonts (renderer-side outbound requests):**
- `https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap` — CSS `@import` in `src/renderer/history.html:8` and `src/renderer/settings.html:8`. This is a third-party network request made by the Electron windows (the dashboard itself uses only the system font stack — `src/dashboard/index.html`, `src/dashboard/styles.css`).

**Not present:**
- No OpenAI, Deepgram, Whisper, Azure Speech, or other STT vendor.
- No payments, email, SMS, push-notification, or cloud-storage API.
- No telemetry/crash-reporting SaaS (Sentry/PostHog/Segment/etc. absent). `src/main/analytics.js` is purely local aggregation for the dashboard.

## Data Storage

**Databases:**
- None. No SQL/NoSQL engine and no ORM.
- Persistence is a single JSON document written atomically (`.tmp` + `rename`) with a 150 ms debounce: `%APPDATA%/Dictata/dictata.json` (`src/main/store.js:97`, `126-141`).
- Schema/limits: `settings`, `dictionary`, `replacements`, `history` (max 500), `events` (max 500), `dashboardToken`, `stats` (`src/main/store.js:11-48`).
- One-time migration from the pre-rename folder `%APPDATA%/voice-flow` (`voice-flow.json`, `logs/voice-flow.log`) in `src/main/main.js:37-65`.

**File Storage:**
- Local filesystem only. No audio is persisted — WAV buffers live in memory and are discarded after transcription (`src/main/recorder.js:98-109`).
- Writable locations: `userData` JSON (`store.js`), logs at `%APPDATA%/Dictata/logs/dictata.log` (`src/main/logger.js:18-24`), app code/assets read-only.

**Caching:**
- None. Session state is in-memory only: `EventBus` rolling buffer of 500 (`src/main/main.js:82`), `lastCleaned`/`lastTargetHwnd`/`sessionId` globals (`src/main/main.js:70-76`).

## Authentication & Identity

**Auth Provider:**
- None (no user accounts, login, OAuth, or SSO).
- The only credential is the user's Gemini API key. Stored encrypted with Electron `safeStorage` (Windows DPAPI), prefixed `enc:` (`src/main/store.js:48-73`); legacy plaintext values are decrypted transparently and re-encrypted on the next save.
- Local dashboard access uses a self-issued bearer-style token: 16 random bytes hex, generated once and persisted so bookmarked URLs survive restarts (`src/main/store.js:167-172`, `src/main/dashboard.js:83-85`). Passed as `?token=` query parameter and compared with `===` in `_authorised()` (`src/main/dashboard.js:209-212`).

## Monitoring & Observability

**Error Tracking:**
- None external.
- `process.on('uncaughtException')` / `process.on('unhandledRejection')` log and keep the tray app alive (`src/main/main.js:118-123`).
- Errors surface to the user through the status pill, tray balloon (`notifyError`, `src/main/main.js:295-302`), and the dashboard event stream.

**Logs:**
- `src/main/logger.js` monkey-patches `console.log/warn/error` and appends to `%APPDATA%/Dictata/logs/dictata.log`, rotated at 512 KB to `dictata.log.1`.
- Persistent activity events (errors/info) are also kept in the JSON store via `bus.on('event')` (`src/main/main.js:100-102`).

## CI/CD & Deployment

**Hosting:**
- Desktop distribution only. No server component. The "web dashboard" is served from the desktop app on `127.0.0.1` (`src/main/dashboard.js:26`, `135-146`).
- Local build artifacts: `dist/Voice Flow Setup 0.1.0.exe` (NSIS, produced before the rename to Dictata) and `dist/win-unpacked/`.

**CI Pipeline:**
- None detected (no `.github/`, no other CI config). Release builds are run locally with `npm run dist` (`electron-builder --win`).

## Environment Configuration

**Required env vars:**
- `GEMINI_API_KEY` — optional at runtime, used only when no key is stored in Settings (`src/main/main.js:31`); required for `npm run test:api` (`scripts/test-api.js:14-19`).
- `.env` and `.env.example` are present at the repo root (contents not inspected; `.env` is gitignored).

**Secrets location:**
- Primary: `settings.apiKey` inside `%APPDATA%/Dictata/dictata.json`, encrypted via Electron `safeStorage` (DPAPI) with the `enc:` prefix (`src/main/store.js:50-73`, `133`).
- Development fallback: `.env` at repo root.
- Dashboard token: `dashboardToken` in the same JSON file (`src/main/store.js:167-172`).

## Webhooks & Callbacks

**Incoming:**
- No external webhooks. No public listener.
- Local-only HTTP endpoints, bound to `127.0.0.1` with DNS-rebinding protection (Host allowlist) in `src/main/dashboard.js:203-207`:

| Route | Purpose | Auth |
|---|---|---|
| `GET /` | dashboard page + static assets from `src/dashboard/` | none (token required by the client for API calls) |
| `GET /api/state` | app state, analytics, history, events snapshot | `?token=` |
| `GET /api/history` | full history array | `?token=` |
| `GET /api/events` | SSE stream of live events (`text/event-stream`, 25 s ping, `retry: 2000`) | `?token=` |

- Port: `7788` by default, falling back to the next three ports (or OS-assigned) when taken (`src/main/dashboard.js:112-133`; setting `dashboardPort` in `src/main/store.js:34`).

**Outgoing:**
- Outgoing HTTP requests are the Gemini streaming call (`src/main/gemini.js`) and the Google Fonts stylesheet loads in `src/renderer/history.html` / `src/renderer/settings.html`.
- Outgoing SSE consumption: the Gemini `alt=sse` stream is parsed by `src/main/sse.js`.

## OS & Desktop Integrations (Windows)

**Global hotkeys:**
- Electron `globalShortcut` with accelerator strings converted from chord arrays in `toAccelerator()` (`src/main/hotkeys.js:22-31`). Defaults: `Alt+Shift+D` (push-to-talk), `Alt+Shift+F` (hands-free), `Alt+Shift+C` (cancel), `Alt+Shift+V` (paste last) (`src/main/store.js:14-19`).

**PowerShell sidecar (long-lived):**
- `src/main/winhelper.js` spawns one `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -` process and speaks a line protocol over stdin (`target`, `focus <hwnd>`, `keys <sendkeys>`), with `__READY__` / `__END__` framing and per-command timeouts.
- Uses `user32.dll` P/Invoke (`GetForegroundWindow`, `SetForegroundWindow`, `AttachThreadInput`, `ShowWindow`, `IsIconic`) and `System.Windows.Forms.SendKeys`.
- Exposed as a singleton `winHelper` (`src/main/winhelper.js:185`).

**Clipboard & paste:**
- Electron `clipboard` read/write/restore (`src/main/paste.js:25-56`), 600 ms restore delay; keystroke `^v` or `+{INSERT}` via the PowerShell helper (`src/main/paste.js:113-116`).
- Known limit: `SendKeys` cannot reach elevated (admin) windows (`README.md:226`).

**Microphone capture:**
- Renderer `navigator.mediaDevices.getUserMedia` + `AudioWorklet` at 16 kHz mono (`src/renderer/statusRenderer.js:147-169`, `src/renderer/recorderWorklet.js`), streamed to main over IPC (`src/main/recorder.js:40-58`). Permission handler grants only `media`/`microphone` (`src/main/main.js:171-176`).

**Other desktop hooks:**
- System tray with context menu (`src/main/main.js:259-281`), tray balloon notifications (`295-302`), login item (`156-159`), single-instance lock (`111-115`), always-on-top frameless pill window (`169-199`), external link opening (`606-608`).

---

*Integration audit: 2026-10-22*
