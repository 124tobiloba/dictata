# Voice Flow

**Hold a hotkey, speak, and polished text appears wherever your cursor is.**
A Windows voice-dictation app built with Electron and Google Gemini.

Voice Flow records your microphone, sends the audio to Gemini in a single
streaming request that both transcribes *and* cleans up the text, then pastes
the result straight into the app you were typing in.

---

## Features

- **Push-to-talk** — one global shortcut to start and stop dictation.
- **Hands-free lock** — double-tap the shortcut to keep recording; press once
  more to stop.
- **Context-aware cleanup** — grammar and punctuation are fixed, filler words
  ("um", "uh") are removed, and the tone is adapted to the app you are in
  (Slack vs. email vs. code).
- **Personal dictionary** — terms that are always spelled exactly as you enter them.
- **Replacements** — short forms are expanded automatically (`teh` → `the`).
- **Multilingual** — auto-detect, or force a language.
- **History** — every dictation is stored and can be pasted again.
- **Status pill** — a small always-on-top bubble shows the state and streams
  the text as it arrives.
- **Tray app** — lives in the system tray, starts with Windows (optional).

## Requirements

- Windows 10/11
- Node.js 18+ (developed on Node 22)
- A free [Google AI Studio](https://aistudio.google.com/apikey) API key

## Getting started

```bash
npm install
npm start          # run the app
npm run dev        # run with dev flags
npm test           # unit tests (fast, no network, no microphone)
npm run test:api   # live check against the Gemini API
npm run test:paste # end-to-end check of the paste pipeline
npm run dist       # build a Windows installer (NSIS) into dist/
```

The key is entered once in **Settings → AI & Style** and stored encrypted
(Windows DPAPI via Electron `safeStorage`). A `.env` file with
`GEMINI_API_KEY=...` also works as a fallback for development — see
`.env.example`.

## Default shortcuts

| Action | Shortcut |
|---|---|
| Push-to-talk (press again to stop) | `Alt + Shift + D` |
| Hands-free lock (toggle) | `Alt + Shift + F` |
| Cancel | `Alt + Shift + C` |
| Paste the last dictation again | `Alt + Shift + V` |

Double-tap `Alt + Shift + D` to lock hands-free mode.

## How it works

```
hotkey ──► state machine (IDLE → LISTENING → PROCESSING)
              │
              ▼
   status-pill renderer                main process
   getUserMedia + AudioWorklet  ──IPC──►  PCM chunks → WAV (16 kHz mono)
                                            │
                                            ▼
                                   Gemini streamGenerateContent
                                   (SSE — one call, inline audio)
                                            │
                                            ▼
                              clipboard ──► SendKeys ^v ──► your app
```

| Module | Responsibility |
|---|---|
| `src/main/main.js` | Orchestration, state machine, IPC, windows, tray |
| `src/main/ptt.js` | Push-to-talk / hands-free rules (pure, tested) |
| `src/main/hotkeys.js` | Global shortcuts → actions |
| `src/main/recorder.js` | Chunk collection, length limit |
| `src/main/wav.js` | WAV encoding (pure, tested) |
| `src/main/gemini.js` | Gemini REST call, SSE streaming, retries |
| `src/main/sse.js` | SSE parser (pure, tested) |
| `src/main/paste.js` | Clipboard save → write → paste → restore |
| `src/main/winhelper.js` | Long-lived PowerShell helper (window focus, SendKeys) |
| `src/main/store.js` | Settings, dictionary, history (JSON in `userData`) |
| `src/main/events.js` | Activity event bus (typed events, rolling buffer) |
| `src/main/analytics.js` | Pure aggregation for the dashboard charts |
| `src/main/dashboard.js` | The local web dashboard (node:http + SSE) |
| `src/dashboard/` | The dashboard page (HTML/CSS/JS, no build step) |
| `src/main/logger.js` | Rolling file log in `%APPDATA%/voice-flow/logs/` |
| `src/renderer/status*` | Status pill + microphone capture |
| `src/renderer/settings*` | Settings window |
| `src/renderer/history*` | History window |

### Design notes

- **One model call, not two.** Transcription and cleanup happen in a single
  Gemini request with the audio inlined as base64. That halves the latency and
  the cost compared with STT → LLM.
- **Streaming.** The response is consumed as SSE, so the pill shows words while
  they are still being generated.
- **A long-lived PowerShell process.** Spawning `powershell.exe` costs 1–2 s;
  keeping one alive and talking to it over stdin makes every call ~20–50 ms.
  It is used to read the foreground window and to send the paste keystroke.
- **Everything testable is pure.** The interaction rules, the WAV encoder, the
  SSE parser, the prompt builder and the settings merge live in modules that
  have no Electron dependency, so they are covered by `node --test`.

## Web dashboard

Voice Flow serves a live activity dashboard on your own machine:

```
http://127.0.0.1:7788/?token=…
```

Open it from the tray menu (**Open Dashboard**) — the link contains a
per-session token. You can also find the URL in **Settings → Web dashboard**.

The page shows, live:

- every dictation as it lands, with its timing (`rec` / `transcribe` / `paste`)
  and the model that answered
- the words streaming in while the transcription is still running
- every error, grouped by cause
- charts: words per day, transcription latency, model usage, and the hours
  you tend to dictate
- counters: words today, sessions, speaking time, words per minute, average
  latency, error rate
- **your keyboard shortcuts**, read from the app's own settings — the page
  can never disagree with the app. The keycaps flash when a shortcut fires.
- the orb in the hero reacts to your **real microphone level**

If the app restarts, the page says so in a banner and reconnects by itself —
your data stays on screen the whole time.

### Privacy

The server binds to `127.0.0.1` only — it is not reachable from the network.
Every API call needs the token from the URL, and requests with a foreign
`Host` header are rejected, so a random web page in your browser cannot read
your transcripts. Nothing is sent anywhere: the dashboard reads the same
local store the app writes to.

The token is **stable across restarts** (it is stored in the app's data
folder), so a bookmarked dashboard URL keeps working.

| Route | Purpose |
|---|---|
| `GET /` | the page |
| `GET /api/state` | snapshot: app state, analytics, history, events |
| `GET /api/history` | the full history |
| `GET /api/events` | SSE stream of live events |

Turn it off in **Settings → Web dashboard**.

## Testing

Three levels, cheapest first:

| Command | What it covers | Needs |
|---|---|---|
| `npm test` | The pure logic: push-to-talk rules, WAV encoding, SSE parsing, prompt building, model resolution, settings merge, analytics | nothing |
| `npm run test:api` | The live Gemini request: audio encoding, request body, model selection, fallback chain, response parsing | network + API key |
| `npm run test:paste` | The paste pipeline end-to-end: window targeting, `SetForegroundWindow`, `SendKeys`, clipboard snapshot and restore | Windows desktop (it opens Notepad) |
| `npm run test:dashboard` | The dashboard server: page, auth, state endpoint, live SSE delivery, port fallback | nothing |
| `npm run test:mic` | Measures the real microphone level — tells a silent input device apart from a broken level calculation | a microphone |

`npm run test:paste` opens Notepad, dictates "into" it, then reads Notepad's
content back to prove the text arrived, and checks that the clipboard was
restored afterwards. It closes Notepad when it is done.

### Manual checklist

1. `npm start`, then press `Alt+Shift+D`, speak, press it again — the text
   lands in the app you were typing in.
2. Press `Alt+Shift+D` twice quickly — the pill shows **LOCKED** and keeps
   recording. Press once more to stop. (This is the double-tap fix.)
3. Press `Alt+Shift+C` during recording — recording stops, nothing is pasted.
4. Press `Alt+Shift+V` — the last transcript is pasted again.
5. Open **History**, click **Paste again** — the text goes to your app, not
   into the History window. Copy something before you start: the clipboard
   must be restored afterwards.
6. **Settings → AI & Style → Test** — reports "Key works ✓".
7. Say a long sentence and check that filler words are removed and
   punctuation is fixed.
8. Say a word from your **dictionary** and check that it is spelled correctly.
9. Dictate into an app that runs as administrator — pasting there is not
   possible with `SendKeys`; the text stays on the clipboard instead.

## Known limitations

- `SendKeys` cannot reach windows that run elevated (as administrator).
- Dictations are capped (5 minutes by default) because the audio is sent
  inline in a single request.
- The transcript is the cleaned text only — there is no separate raw version.

## Logs

Troubleshooting output is written to:

```
%APPDATA%\voice-flow\logs\voice-flow.log
```

## License

MIT
