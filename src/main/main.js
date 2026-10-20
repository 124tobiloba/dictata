/**
 * main.js — Electron entry point / pipeline orchestrator
 *
 * State machine:
 *   IDLE → (ptt-start | hands-free ON) → LISTENING
 *   LISTENING → (ptt-stop | hands-free OFF | done) → PROCESSING
 *   PROCESSING → (paste finished) → IDLE
 *   Any state → (cancel) → IDLE
 */

require('dotenv').config();
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, screen, session } = require('electron');
const path = require('path');
const crypto = require('crypto');

const { Store } = require('./store');
const { HotkeyService } = require('./hotkeys');
const { Recorder } = require('./recorder');
const { transcribe, testKey } = require('./gemini');
const { pasteText } = require('./paste');
const { winHelper } = require('./winhelper');

const IS_DEV = process.argv.includes('--dev');
const getApiKey = () => (store.settings.apiKey || '').trim() || process.env.GEMINI_API_KEY || '';

// ── State ────────────────────────────────────────────────────────────────────
const STATE = { IDLE: 'idle', LISTENING: 'listening', PROCESSING: 'processing' };
let state = STATE.IDLE;
let lastCleaned = '';
let lastRaw = '';
let handsFreeOn = false;
let appNamePromise = Promise.resolve('');

// ── Singletons ────────────────────────────────────────────────────────────────
const store = new Store();
const recorder = new Recorder();
const hotkeys = new HotkeyService(store);

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

app.whenReady().then(() => {
  createStatusWindow();
  createTray();
  setupIPC();
  hotkeys.start();
  winHelper.start();
  applyLoginItem();
  if (!getApiKey()) createSettingsWindow();   // first run: ask for the key
});

app.on('before-quit', () => {
  hotkeys.stop();
  recorder.cancel();
  winHelper.stop();
});

function applyLoginItem() {
  if (IS_DEV || !app.isPackaged) return;   // only the installed app auto-starts
  app.setLoginItemSettings({ openAtLogin: !!store.settings.launchAtLogin });
}

// Keep app alive even when all windows are closed (tray app).
app.on('window-all-closed', (e) => e.preventDefault());

// ── Status pill window (always on top, frameless, transparent) ─────────────
function createStatusWindow() {
  // Grant microphone access for getUserMedia in the renderer
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'microphone');
  });

  const { width } = screen.getPrimaryDisplay().workAreaSize;
  statusWindow = new BrowserWindow({
    width: 320,
    height: 90,
    x: Math.round((width - 300) / 2),
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
  recorder.on('error', (err) => {
    console.error('[recorder]', err.message);
    state = STATE.IDLE;
    sendToStatus('vf:status', { state: 'error', message: err.message });
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

function createHistoryWindow() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.focus();
    return;
  }
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
    { label: 'History', click: createHistoryWindow },
    { label: 'Settings', click: createSettingsWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

// ── Hotkey events → state machine ─────────────────────────────────────────────
hotkeys.on('ptt-start', () => {
  if (state !== STATE.IDLE) return;
  setState(STATE.LISTENING);
  recorder.start();
  appNamePromise = winHelper.foregroundApp().catch(() => '');
});

hotkeys.on('ptt-stop', () => {
  if (state !== STATE.LISTENING) return;
  recorder.stop();
  setState(STATE.PROCESSING);
});

hotkeys.on('handsfree', (on) => {
  handsFreeOn = on;
  if (on && state === STATE.IDLE) {
    setState(STATE.LISTENING);
    recorder.start();
    appNamePromise = winHelper.foregroundApp().catch(() => '');
  } else if (!on && state === STATE.LISTENING) {
    recorder.stop();
    setState(STATE.PROCESSING);
  }
});

hotkeys.on('cancel', () => {
  recorder.cancel();
  setState(STATE.IDLE);
});

hotkeys.on('paste-last', () => {
  if (!lastCleaned) return;
  pasteText({
    text: lastCleaned,
    restore: store.settings.restoreClipboard,
    method: store.settings.pasteMethod,
  }).catch(console.error);
});

// ── Recording done → Gemini → paste ──────────────────────────────────────────
async function onRecordingDone({ wav, durationMs }) {
  if (state !== STATE.PROCESSING) {
    setState(STATE.IDLE);
    return;
  }

  const tStart = Date.now();
  console.log(`[pipeline] recorded ${durationMs} ms, wav ${(wav?.length / 1024 || 0).toFixed(0)} KB`);
  sendToStatus('vf:status', { state: 'processing', subtext: 'Transcribing…' });

  // App name was looked up while the user was speaking
  const appName = await appNamePromise;

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
      appName,
      textBefore: '',   // Phase 2: accessibility context
      textAfter: '',
      // Stream partial cleaned text to the pill in real time
      onPartial: (partial) => {
        sendToStatus('vf:status', { state: 'processing', subtext: partial.slice(0, 40) });
      },
    });

    lastRaw = result.raw;
    lastCleaned = result.cleaned;

    const id = crypto.randomUUID();
    store.addHistory({ id, raw: result.raw, cleaned: result.cleaned, durationMs, at: Date.now() });
    updateTrayMenu();

    await pasteText({
      text: result.cleaned,
      restore: s.restoreClipboard,
      method: s.pasteMethod,
    });

    console.log(`[pipeline] stop → pasted in ${Date.now() - tStart} ms`);
    sendToStatus('vf:status', { state: 'done', text: result.cleaned });
    notifyHistory();
  } catch (err) {
    console.error('[pipeline]', err);
    sendToStatus('vf:status', { state: 'error', message: err.message });
  } finally {
    setState(STATE.IDLE);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setState(s) {
  state = s;
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
  ipcMain.handle('vf:update-settings', (_e, patch) => {
    const next = store.updateSettings(patch);
    if ('launchAtLogin' in patch) applyLoginItem();
    return next;
  });
  ipcMain.handle('vf:test-key', (_e, key) => testKey((key || '').trim() || getApiKey()));
  ipcMain.handle('vf:set-dictionary', (_e, list) => { store.setDictionary(list); });
  ipcMain.handle('vf:set-replacements', (_e, list) => { store.setReplacements(list); });

  // History
  ipcMain.handle('vf:delete-history', (_e, id) => store.deleteHistory(id));
  ipcMain.handle('vf:clear-history', () => store.clearHistory());
  ipcMain.handle('vf:paste-entry', (_e, text) =>
    pasteText({ text, restore: store.settings.restoreClipboard, method: store.settings.pasteMethod })
  );

  // Open settings / history from renderer
  ipcMain.on('vf:open-settings', createSettingsWindow);
  ipcMain.on('vf:open-history', createHistoryWindow);
}
