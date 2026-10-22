---
last_mapped_commit: 0439ed1ae6b93347340f8af55ab3cb3f630a64f4
last_mapped_at: 2026-10-22
---
# Technology Stack

**Analysis Date:** 2026-10-22

## Languages

**Primary:**
- JavaScript (Node.js, CommonJS `require`/`module.exports`) — all main-process modules, scripts, and tests. No TypeScript, no ESM, no transpilation.
- JavaScript (browser/DOM) — renderer windows (`src/renderer/*.js`) and the local dashboard (`src/dashboard/app.js`), loaded directly by `<script src>` with no build step.

**Secondary:**
- HTML5 — `src/renderer/status.html`, `src/renderer/settings.html`, `src/renderer/history.html`, `src/dashboard/index.html`, `scripts/mic-probe.html`
- CSS3 — `src/dashboard/styles.css` and inline `<style>` blocks in the renderer HTML files
- PowerShell — embedded as a string in `src/main/winhelper.js` (Win32 P/Invoke + `System.Windows.Forms.SendKeys`)

## Runtime

**Environment:**
- Electron `44.9.0` (Chromium multi-process: main + renderer + preload; `nodeIntegration: false`, `contextIsolation: true` in every window — see `src/main/main.js:191-195`, `224-228`, `248-252`)
- Node.js for tooling/tests: `>= 22.12.0` (required by `@electron/asar` and Electron 44's dev toolchain in `package-lock.json`; the repo was developed on Node `v22.21.1`). `README.md` states Node 18+ as the user-facing minimum.
- Attempted runtime target: Windows 10/11 x64 only (`README.md:30`, `package.json:40-50`)

**Package Manager:**
- npm
- Lockfile: present (`package-lock.json`, `lockfileVersion: 3`)

## Frameworks

**Core:**
- Electron `^44.9.0` — desktop shell, tray, global shortcuts, IPC, clipboard, `safeStorage` (DPAPI), single-instance lock, login-item registration
- No UI framework (no React/Vue/Svelte), no CSS framework, no bundler (no Vite/Webpack/Rollup), no template engine. Everything is hand-written vanilla DOM code.

**Testing:**
- `node:test` (Node built-in test runner) + `node:assert` — configured in `package.json:10` as `node --test "test/**/*.test.js"`. No Jest/Vitest/Mocha.
- Test files: `test/analytics.test.js`, `test/dashboard.test.js`, `test/gemini.test.js`, `test/hotkeys.test.js`, `test/page.test.js`, `test/ptt.test.js`, `test/sse.test.js`, `test/store.test.js`, `test/wav.test.js`

**Build/Dev:**
- `electron-builder` `^26.15.3` — Windows NSIS installer (`package.json:9`, `29-61`); output directory `dist/`
- macOS/Linux builder packages (`dmg-builder`, `electron-winstaller`, `@electron/notarize`, `@electron/osx-sign`) are transitive dependencies of `electron-builder`, not used by this project's scripts.

## Key Dependencies

**Critical:**
- `dotenv` `^18.0.8` — the only production dependency. Loads `GEMINI_API_KEY` from `.env` as a development fallback (`src/main/main.js:13`, `src/main/main.js:31`; `scripts/test-api.js:10-14`).
- `electron` `^44.9.0` — dev dependency that is the actual runtime (app is launched via `electron .`, not bundled).

**Infrastructure:**
- Node built-ins only for everything else: `https` (Gemini streaming request — `src/main/gemini.js:14`), `http` (dashboard server — `src/main/dashboard.js:17`), `crypto` (UUIDs, dashboard token — `src/main/main.js:16`, `src/main/store.js:9`), `fs`/`path` (JSON store, logger, static files), `child_process` (PowerShell helper — `src/main/winhelper.js:12`), `events` (EventEmitter services).
- **No native addons.** `package.json:26-28` still contains an `allowScripts` entry for `uiohook-napi@1.5.5`, but `uiohook-napi` is not in `dependencies`, `devDependencies`, or `package-lock.json`. Global hotkeys use Electron `globalShortcut` (`src/main/hotkeys.js:14`), and keystroke injection uses PowerShell instead of `robotjs` (`src/main/paste.js:109-116`).

## Configuration

**Environment:**
- `.env` and `.env.example` exist at the repo root (values not inspected; `.env` is gitignored via `.gitignore`).
- Single required variable: `GEMINI_API_KEY`. Resolution order in `src/main/main.js:31`: encrypted value in the JSON store → `process.env.GEMINI_API_KEY`.
- No `NODE_ENV` usage; dev mode is a CLI flag: `electron . --dev` → `IS_DEV = process.argv.includes('--dev')` (`src/main/main.js:30`).

**Runtime settings** (not env vars) live in `DEFAULTS` in `src/main/store.js:11-44` and are persisted to `%APPDATA%/Dictata/dictata.json`: shortcut chords, double-tap behavior, model, style, language, dictionary, replacements, clipboard restore, paste method, mic device, launch-at-login, max recording seconds (300), dashboard enabled/port (7788), API key (encrypted).

**Build:**
- `package.json` `"build"` block (`package.json:29-61`): appId `com.vilian.dictata`, productName `Dictata`, NSIS target x64, one-click installer, `perMachine: false`, icon `assets/icon.ico`, packaged files limited to `src/**/*`, `assets/**/*`, `package.json`.
- No `engines` field, no `.nvmrc`, no TypeScript config, no lint/format config (`.eslintrc*`, `.prettierrc*`, `biome.json`, `tsconfig.json` all absent), no CI configuration (`.github/` absent).
- Line endings normalized to LF by `.gitattributes` (`* text=auto eol=lf`); PNG/ICO marked binary.

## Platform Requirements

**Development:**
- Node.js 22.12+ and npm
- Windows 10/11 x64 (the PowerShell helper, `SendKeys`, DPAPI-backed `safeStorage`, tray, and login-item APIs are Windows-specific)
- Working microphone; a Google AI Studio API key for live checks
- `npm start` / `npm run dev` (no build step), `npm run dist` for the installer

**Production:**
- Windows 10/11 x64, installed as an NSIS package (current artifacts in `dist/`: `Voice Flow Setup 0.1.0.exe` from a pre-rename build, plus `dist/win-unpacked/`)
- Runs as a tray app; optional auto-start via `app.setLoginItemSettings` (`src/main/main.js:156-159`)
- Outbound HTTPS to `generativelanguage.googleapis.com` is required for all dictation

---

*Stack analysis: 2026-10-22*
