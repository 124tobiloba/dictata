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
npm test           # run the unit tests
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
