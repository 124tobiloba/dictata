/**
 * main.js — Electron entry point / pipeline orchestrator
 *
 * State machine:
 *   IDLE → (ptt-start | hands-free ON) → LISTENING
 *   LISTENING → (ptt-stop | hands-free OFF | done) → PROCESSING
 *   PROCESSING → (paste finished) → IDLE
 *   Any state → (cancel) → IDLE
 *
 * The push-to-talk / hands-free interaction rules live in ./ptt.js.
 */

require('dotenv').config();
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, screen, session } = require('electron');
const path = require('path');
const crypto = require('crypto');

const logger = require('./logger');
const { Store } = require('./store');
const { HotkeyService } = require('./hotkeys');
const { Recorder } = require('./recorder');
const { transcribe, testKey } = require('./gemini');
const { pasteText } = require('./paste');
const { winHelper } = require('./winhelper');
const { EventBus } = require('./events');
const { DashboardServer } = require('./dashboard');
const { wordCount } = require('./analytics');

const IS_DEV = process.argv.includes('--dev');
const getApiKey = () => (store.settings.apiKey || '').trim() || process.env.GEMINI_API_KEY || '';

// ── State ────────────────────────────────────────────────────────────────────
const STATE = { IDLE: 'idle', LISTENING: 'listening', PROCESSING: 'processing' };
let state = STATE.IDLE;
let lastCleaned = '';
let lastRaw = '';
let handsFreeOn = false;
let targetPromise = Promise.resolve(null);   // foreground window at dictation time
let lastTargetHwnd = 0;                       // where the text should go
let activeAbort = null;                       // AbortController of the live request
let sessionId = 0;                              // bumped for every recording session

// ── Singletons ────────────────────────────────────────────────────────────────
const store = new Store();
const recorder = new Recorder();
const hotkeys = new HotkeyService(store);
const bus = new EventBus({ limit: 500 });
bus.lastAction = null;
const dashboard = new DashboardServer({
  store,
  bus,
  port: store.settings.dashboardPort,
  // Stable across restarts, so a bookmarked dashboard URL keeps working.
  token: store.getOrCreateToken(),
});

// The bus carries a little app state so the dashboard can render it.
bus.appState = 'idle';
bus.handsFree = false;
bus.startedAt = Date.now();
bus.version = app.getVersion();

// Errors and notes are kept on disk so the dashboard has a history even
// after a restart. Dictations live in the history array already.
bus.on('event', (event) => {
  if (event.type === 'error' || event.type === 'info') store.addEvent(event);
});

let statusWindow = null;
let settingsWindow = null;
let historyWindow = null;
let tray = null;

// ── App lifecycle ─────────────────────────────────────────────────────────────
// Only one copy may run — a second copy can't get the hotkeys or cache folder.
if (!app.requestSingleInstanceLock()) {
  console.log('[voice-flow] Already running (check the system tray). Close it first, then run again.');
  app.quit();
  process.exit(0);
}

// A crash in a tray app is invisible — log it and keep running.
process.on('uncaughtException', (err) => {
  console.error('[voice-flow] uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[voice-flow] unhandled rejection:', err);
});

app.whenReady().then(() => {
  logger.init(app);
  createStatusWindow();
  createTray();
  setupIPC();
  hotkeys.start();
  winHelper.start();
  applyLoginItem();
  applyRecorderLimits();
  startDashboard();
  if (!getApiKey()) createSettingsWindow();   // first run: ask for the key
});

/** The local web dashboard that shows everything the app is doing. */
async function startDashboard() {
  if (!store.settings.dashboardEnabled) return;
  try {
    await dashboard.start();
    updateTrayMenu();
  } catch (err) {
    console.error('[dashboard] could not start:', err.message);
  }
}

app.on('before-quit', () => {
  hotkeys.stop();
  recorder.cancel();
  winHelper.stop();
  dashboard.stop();
});

function applyLoginItem() {
  if (IS_DEV || !app.isPackaged) return;   // only the installed app auto-starts
  app.setLoginItemSettings({ openAtLogin: !!store.settings.launchAtLogin });
}

function applyRecorderLimits() {
  recorder.setMaxMs((Number(store.settings.maxRecordingSec) || 300) * 1000);
}

// Keep app alive even when all windows are closed (tray app).
app.on('window-all-closed', (e) => e.preventDefault());

// ── Status pill window (always on top, frameless, transparent) ─────────────
function createStatusWindow() {
  // Grant microphone access for getUserMedia in the renderer
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'microphone');
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media' || permission === 'microphone';
  });

  const { width } = screen.getPrimaryDisplay().workAreaSize;
  statusWindow = new BrowserWindow({
    width: 320,
    height: 90,
    x: Math.round((width - 320) / 2),
    y: 32,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../renderer/statusPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  statusWindow.setIgnoreMouseEvents(true, { forward: true });
  statusWindow.loadFile(path.join(__dirname, '../renderer/status.html'));
  recorder.attach(statusWindow);

  recorder.on('done', onRecordingDone);
  recorder.on('level', (level) => publishLevel(level));
  recorder.on('error', (err) => {
    console.error('[recorder]', err.message);
    state = STATE.IDLE;
    bus.appState = 'idle';
    bus.publish('error', { message: err.message, kind: 'microphone', fatal: false });
    sendToStatus('vf:status', { state: 'error', message: err.message });
    notifyError(err.message);
  });
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 700,
    height: 560,
    minWidth: 600,
    minHeight: 500,
    title: 'Voice Flow Settings',
    webPreferences: {
      preload: path.join(__dirname, '../renderer/settingsPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

async function createHistoryWindow() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.focus();
    return;
  }
  // Remember where the user was BEFORE this window takes the focus, so
  // "Paste again" can go back to their app.
  const target = await winHelper.foregroundTarget();
  if (target && !target.self && target.hwnd) lastTargetHwnd = target.hwnd;

  historyWindow = new BrowserWindow({
    width: 580,
    height: 700,
    title: 'Voice Flow History',
    webPreferences: {
      preload: path.join(__dirname, '../renderer/historyPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  historyWindow.loadFile(path.join(__dirname, '../renderer/history.html'));
  historyWindow.on('closed', () => { historyWindow = null; });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, '../../assets/tray-icon.png')
  ).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Voice Flow');
  updateTrayMenu();
}

function updateTrayMenu() {
  const stats = store.snapshot().stats;
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'Voice Flow', enabled: false },
    { type: 'separator' },
    { label: `${stats.words.toLocaleString()} words dictated`, enabled: false },
    { type: 'separator' },
    { label: dashboard.running ? 'Open Dashboard' : 'Start Dashboard', click: () => openDashboard() },
    { label: 'History', click: () => createHistoryWindow() },
    { label: 'Settings', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

/** Open the web dashboard in the default browser. */
async function openDashboard() {
  if (!dashboard.running) await startDashboard();
  const url = dashboard.url;
  if (url) {
    shell.openExternal(url);
  } else {
    notifyError('The dashboard could not be started — check the log file.');
  }
}

/** Surface an error that the 2-second pill would otherwise swallow. */
function notifyError(message) {
  try {
    tray?.displayBalloon?.({
      title: 'Voice Flow',
      content: String(message).slice(0, 180),
    });
  } catch { /* not supported on this platform */ }
}

// ── Hotkey actions → state machine ───────────────────────────────────────────
hotkeys.on('action', ({ action }) => {
  bus.lastAction = action;
  switch (action) {
    case 'start':
    case 'start-lock':
      if (state !== STATE.IDLE) return;
      handsFreeOn = action === 'start-lock';
      beginRecording();
      break;

    case 'lock':
      // Second tap of a double-tap: keep recording, release the toggle.
      handsFreeOn = true;
      setState(STATE.LISTENING);
      break;

    case 'stop':
      if (state !== STATE.LISTENING) return;
      handsFreeOn = false;
      recorder.stop();
      setState(STATE.PROCESSING);
      break;

    case 'cancel':
      cancelCurrent();
      break;
  }
});

hotkeys.on('paste-last', () => {
  if (!lastCleaned) return;
  pasteInto(lastCleaned).catch(console.error);
});

function beginRecording() {
  sessionId++;
  cancelActiveRequest();
  lastPartialText = '';
  lastPartialAt = 0;
  setState(STATE.LISTENING);
  recorder.start();
  // The foreground window is looked up while the user is speaking, so the
  // lookup cost is off the critical path.
  targetPromise = winHelper.foregroundTarget().catch(() => null);
}

function cancelCurrent() {
  cancelActiveRequest();
  recorder.cancel();
  setState(STATE.IDLE);
}

function cancelActiveRequest() {
  if (!activeAbort) return;
  try { activeAbort.abort(); } catch { /* ignore */ }
  activeAbort = null;
}

// Partial transcripts arrive in bursts — throttle them so the dashboard
// stream stays readable.
let lastPartialText = '';
let lastPartialAt = 0;
function publishPartial(text) {
  const now = Date.now();
  if (!text || text === lastPartialText) return;
  if (now - lastPartialAt < 120) return;
  lastPartialText = text;
  lastPartialAt = now;
  bus.publish('partial', { text });
}

// The microphone level drives the dashboard's orb — ~12 updates a second is
// plenty, and it keeps the event stream small.
let lastLevelAt = 0;
function publishLevel(level) {
  const now = Date.now();
  if (now - lastLevelAt < 80) return;
  lastLevelAt = now;
  bus.publish('level', { level: Number(level) || 0 });
}

// ── Recording done → Gemini → paste ──────────────────────────────────────────
async function onRecordingDone({ wav, durationMs, timedOut }) {
  const mySession = sessionId;
  if (state !== STATE.PROCESSING || mySession !== sessionId) {
    if (mySession === sessionId) setState(STATE.IDLE);
    return;
  }

  const tStart = Date.now();
  console.log(`[pipeline] recorded ${durationMs} ms, wav ${(wav?.length / 1024 || 0).toFixed(0)} KB`);
  sendToStatus('vf:status', {
    state: 'processing',
    subtext: timedOut ? 'Length limit reached — transcribing…' : 'Transcribing…',
  });

  // Where the text is going, and which app we are typing into.
  const target = await targetPromise;
  const appName = target && !target.self ? (target.name || '') : '';
  if (target && !target.self && target.hwnd) lastTargetHwnd = target.hwnd;

  const controller = new AbortController();
  activeAbort = controller;

  // A slow model must not look frozen — show the elapsed time while we wait.
  let lastPartialAt = Date.now();
  const keepAlive = setInterval(() => {
    if (Date.now() - lastPartialAt < 3000) return;   // partial text is showing
    const secs = Math.round((Date.now() - tStart) / 1000);
    sendToStatus('vf:status', { state: 'processing', subtext: `Still working… ${secs}s` });
  }, 2000);

  try {
    const s = store.settings;
    const snap = store.snapshot();

    const result = await transcribe({
      wav,
      apiKey: getApiKey(),
      model: s.model,
      style: s.style,
      language: s.language,
      userName: s.userName,
      dictionary: snap.dictionary,
      replacements: snap.replacements,
      prevCleaned: lastCleaned,
      appName: s.appAwareStyle ? appName : '',
      textBefore: '',   // Phase 2: accessibility context
      textAfter: '',
      signal: controller.signal,
      // Stream partial cleaned text to the pill in real time
      onPartial: (partial) => {
        lastPartialAt = Date.now();
        sendToStatus('vf:status', { state: 'processing', subtext: partial.slice(0, 40) });
        publishPartial(partial);
      },
    });

    if (mySession !== sessionId) return;      // superseded by a newer session
    if (controller.signal.aborted) return;   // cancelled while transcribing

    lastRaw = result.raw;
    lastCleaned = result.cleaned;

    const id = crypto.randomUUID();
    const transcribeMs = Date.now() - tStart;
    const entry = {
      id,
      raw: result.raw,
      cleaned: result.cleaned,
      durationMs,
      transcribeMs,
      model: result.model,
      at: Date.now(),
    };
    updateTrayMenu();

    const pasteStart = Date.now();
    const { pasted } = await pasteInto(result.cleaned);
    const pasteMs = Date.now() - pasteStart;

    // Stored after pasting so the history keeps the complete picture (the
    // dashboard's history view reads these entries).
    entry.pasteMs = pasteMs;
    entry.pasted = pasted;
    entry.words = wordCount(entry.cleaned);
    store.addHistory(entry);

    console.log(`[pipeline] stop → pasted in ${Date.now() - tStart} ms`);
    bus.publish('dictation', {
      ...entry,
      pasteMs,
      pasted,
      truncated: !!result.truncated,
      words: entry.words,
    });
    if (result.model && result.model !== s.model) {
      bus.publish('info', {
        message: `${s.model} was busy — ${result.model} answered instead`,
        model: result.model,
      });
    }
    sendToStatus('vf:status', {
      state: 'done',
      text: result.cleaned,
      message: result.truncated
        ? 'Transcript cut off — try shorter dictations'
        : (pasted ? '' : 'Text copied — press Ctrl+V in your app'),
    });
    if (!pasted) {
      const message = 'Could not paste automatically — the text is on your clipboard.';
      bus.publish('error', { message, kind: 'paste', fatal: false });
      notifyError(message);
    }
    notifyHistory();
  } catch (err) {
    if (err?.message === 'Cancelled') {
      console.log('[pipeline] cancelled');
      bus.publish('info', { message: 'Dictation cancelled', kind: 'cancel' });
      return;
    }
    console.error('[pipeline]', err);
    bus.publish('error', { message: err.message, kind: 'api', fatal: true });
    sendToStatus('vf:status', { state: 'error', message: err.message });
    notifyError(err.message);
  } finally {
    clearInterval(keepAlive);
    if (activeAbort === controller) activeAbort = null;
    // Only clear the state when this session is still the current one —
    // a newer recording must not be interrupted by an old one finishing.
    if (mySession === sessionId) setState(STATE.IDLE);
  }
}

/**
 * Paste into the app the user was in. When one of our own windows has the
 * focus (e.g. the History window) the remembered target window is focused
 * first, so the text never lands in Voice Flow itself.
 */
async function pasteInto(text) {
  const s = store.settings;
  const fg = await winHelper.foregroundTarget();
  let hwnd = 0;
  let allowKeys = true;
  if (fg && fg.self) {
    // One of our own windows has the focus (e.g. the History window):
    // go back to the app the user was in — or don't paste at all.
    if (lastTargetHwnd) hwnd = lastTargetHwnd;
    else allowKeys = false;
  }
  return pasteText({
    text,
    restore: s.restoreClipboard,
    method: s.pasteMethod,
    hwnd,
    allowKeys,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setState(s) {
  state = s;
  if (s === STATE.IDLE) {
    handsFreeOn = false;
    hotkeys.reset();
  }
  bus.appState = s;
  bus.handsFree = handsFreeOn;
  bus.publish('state', { state: s, handsFree: handsFreeOn, action: bus.lastAction });
  sendToStatus('vf:status', { state: s, handsFree: handsFreeOn });
}

function sendToStatus(channel, payload) {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.webContents.send(channel, payload);
  }
}

function notifyHistory() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.webContents.send('vf:history-updated', store.snapshot().history);
  }
}

// ── IPC from renderers ────────────────────────────────────────────────────────
function setupIPC() {
  // Settings
  ipcMain.handle('vf:get-store', () => store.snapshot());
  ipcMain.handle('vf:get-settings', () => {
    const s = store.settings;
    return { sounds: !!s.sounds, microphoneId: s.microphoneId || 'default' };
  });
  ipcMain.handle('vf:update-settings', (_e, patch) => {
    const next = store.updateSettings(patch);
    if ('launchAtLogin' in patch) applyLoginItem();
    if ('maxRecordingSec' in patch) applyRecorderLimits();
    if (patch.shortcuts) hotkeys.reload();
    if ('dashboardEnabled' in patch) {
      if (next.dashboardEnabled) startDashboard();
      else {
        dashboard.stop();
        updateTrayMenu();
      }
    }
    if ('dashboardPort' in patch && dashboard.running) {
      dashboard.stop();
      dashboard.port = Number(next.dashboardPort) || 7788;
      startDashboard();
    }
    sendToStatus('vf:settings', {
      sounds: !!next.sounds,
      microphoneId: next.microphoneId || 'default',
    });
    return next;
  });
  ipcMain.handle('vf:dashboard-url', () => dashboard.url || null);
  ipcMain.handle('vf:test-key', (_e, key) => testKey((key || '').trim() || getApiKey()));
  ipcMain.handle('vf:set-dictionary', (_e, list) => { store.setDictionary(list); });
  ipcMain.handle('vf:set-replacements', (_e, list) => { store.setReplacements(list); });

  // External links (e.g. Google AI Studio) open in the real browser
  ipcMain.handle('vf:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // The local dashboard
  ipcMain.handle('vf:open-dashboard', () => openDashboard());
  ipcMain.handle('vf:dashboard-test', () => {
    bus.publish('info', { message: 'Dashboard test — the live stream is working.' });
    return true;
  });

  // History
  ipcMain.handle('vf:delete-history', (_e, id) => store.deleteHistory(id));
  ipcMain.handle('vf:clear-history', () => store.clearHistory());
  ipcMain.handle('vf:paste-entry', (_e, text) => pasteInto(text));
}
