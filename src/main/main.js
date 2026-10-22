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
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, screen, session, dialog } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const logger = require('./logger');
const { Store } = require('./store');
const { HotkeyService } = require('./hotkeys');
const { Recorder } = require('./recorder');
const { transcribe, testKey } = require('./gemini');
const { pasteText } = require('./paste');
const { winHelper } = require('./winhelper');
const { EventBus } = require('./events');
const { DashboardServer } = require('./dashboard');
const { wordCount, lastTarget } = require('./analytics');
const { normalizeRetentionDays, cutoffFor, splitExpired, splitExpiredEvents } = require('./retention');
const { createLedger } = require('./ledger');
const { createStorage, samePath } = require('./storage');
const { toCsv, historyRows, auditRows } = require('./exporter');

const IS_DEV = process.argv.includes('--dev');
const getApiKey = () => (store.settings.apiKey || '').trim() || process.env.GEMINI_API_KEY || '';

// ── Identity + one-time data migration ────────────────────────────────────────
// The app used to be called "voice-flow". Its settings, API key, history and
// dashboard token must survive the rename, and userData is pinned to one stable
// folder in both dev runs and packaged builds.
const USER_DATA_DIR = 'Dictata';
const LEGACY_USER_DATA_DIR = 'voice-flow';

function migrateUserData() {
  try {
    const appData = app.getPath('appData');           // %APPDATA%
    const target = path.join(appData, USER_DATA_DIR);
    const legacy = path.join(appData, LEGACY_USER_DATA_DIR);

    app.setPath('userData', target);

    // Already migrated, or a genuinely fresh install.
    if (fs.existsSync(target) || !fs.existsSync(legacy)) return;

    fs.cpSync(legacy, target, { recursive: true });
    const oldStore = path.join(target, 'voice-flow.json');
    const newStore = path.join(target, 'dictata.json');
    if (fs.existsSync(oldStore) && !fs.existsSync(newStore)) fs.renameSync(oldStore, newStore);
    const oldLog = path.join(target, 'logs', 'voice-flow.log');
    const newLog = path.join(target, 'logs', 'dictata.log');
    if (fs.existsSync(oldLog) && !fs.existsSync(newLog)) fs.renameSync(oldLog, newLog);
    console.log('[dictata] migrated user data from', legacy);
  } catch (e) {
    // Never block startup on this — the store has its own fallback.
    console.error('[dictata] user-data migration failed:', e.message);
  }
}

migrateUserData();

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
// storage.json lives in app-data and decides where the record lives. Resolving
// it before `new Store()` is what lets a moved record be read on the next
// launch — and finishes or discards an interrupted move first (D-14).
const defaultStoreDir = app.getPath('userData');
const storage = createStorage({ userDataDir: defaultStoreDir });
const resolvedStoreDir = storage.resolveStoreDir();

// CR-01: a relocated record that is not there is not a fresh install — the
// drive is unplugged or the share has not mounted yet. Building a writable
// store here would replace the real record with an empty default as soon as
// the location returns, so the store is created read-only instead.
const storeUnavailable = !samePath(resolvedStoreDir, defaultStoreDir)
  && !fs.existsSync(path.join(resolvedStoreDir, 'dictata.json'));
const STORE_UNAVAILABLE_MESSAGE = `Your dictation folder is unavailable (${resolvedStoreDir}) — reconnect it, then restart Dictata. Nothing will be saved until it is back.`;

const store = new Store({
  dir: resolvedStoreDir,
  userDataDir: defaultStoreDir,
  defaultDir: defaultStoreDir,
  readonly: storeUnavailable,
});
// The audit ledger lives beside the store so a storage move takes it along
// (plan 03), but nothing that deletes a transcript ever opens it (D-11).
const ledger = createLedger({ file: path.join(resolvedStoreDir, 'dictata-audit.ndjson') });
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
  // Every surface deletes through the same main-process functions.
  onPurge: purgeEntry,
  onClearAll: clearAll,
  // Read-only facts (D-02) and the only dashboard action that configures
  // anything: opening the window that owns the controls.
  getPrivacyFacts,
  onOpenSettings: () => createSettingsWindow(),
});

// The bus carries a little app state so the dashboard can render it.
bus.appState = 'idle';
bus.handsFree = false;
bus.startedAt = Date.now();
bus.version = app.getVersion();

// Paste-last starts from whatever survived on disk — never a stale pointer.
rederiveLast();

// Errors and notes are kept on disk so the dashboard has a history even
// after a restart. Dictations live in the history array already.
bus.on('event', (event) => {
  if (event.type === 'error' || event.type === 'info') store.addEvent(event);
});

// An unavailable relocated folder is the one startup condition a tray app
// must not swallow: the user has to reconnect the drive before anything is
// saved. Publish it so the dashboard feed carries the reason too.
if (storeUnavailable) {
  bus.publish('error', { message: STORE_UNAVAILABLE_MESSAGE, kind: 'storage', fatal: false });
}

let statusWindow = null;
let settingsWindow = null;
let historyWindow = null;
let tray = null;

// ── App lifecycle ─────────────────────────────────────────────────────────────
// Only one copy may run — a second copy can't get the hotkeys or cache folder.
if (!app.requestSingleInstanceLock()) {
  console.log('[dictata] Already running (check the system tray). Close it first, then run again.');
  app.quit();
  process.exit(0);
}

// Expired rows must be gone before anything can render them — including the
// first /api/state after a restart. Keep-forever (the default) is a no-op, and
// this runs after the single-instance lock so a second copy never rewrites the
// record the running copy owns.
sweepRetention();

// A crash in a tray app is invisible — log it and keep running.
process.on('uncaughtException', (err) => {
  console.error('[dictata] uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[dictata] unhandled rejection:', err);
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
  if (storeUnavailable) {
    // Name the cause and the remedy, in the two places a tray app is seen.
    notifyError(STORE_UNAVAILABLE_MESSAGE);
    dialog.showErrorBox('Dictata — dictation folder unavailable', STORE_UNAVAILABLE_MESSAGE);
  } else if (!getApiKey()) {
    createSettingsWindow();   // first run: ask for the key
  }
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
  // Flush first: a delete inside the 150 ms save debounce must already be on
  // disk before the process goes away.
  store.flush();
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
    title: 'Dictata Settings',
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
    title: 'Dictata History',
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
  tray.setToolTip('Dictata');
  updateTrayMenu();
}

function updateTrayMenu() {
  const stats = store.snapshot().stats;
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'Dictata', enabled: false },
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
      title: 'Dictata',
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
  // Fall back to the surviving history, never to a deleted string.
  let text = lastCleaned;
  if (!text) {
    const { cleaned, raw } = lastTarget(store.snapshot().history);
    text = cleaned || raw;
  }
  if (!text) return;
  pasteInto(text).catch(console.error);
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
    // One audit fact per dictation attempt: metadata only, never the text
    // (D-11 / T-01-08). A transcription that could not paste is still a
    // `failed` outcome — `errorKind` carries the distinction.
    appendAudit({
      ts: entry.at,
      id,
      outcome: pasted ? 'pasted' : 'failed',
      targetApp: appName,
      durationMs,
      words: entry.words,
      model: entry.model,
      errorKind: pasted ? undefined : 'paste',
    });
    // Sweep before publishing: the new row must not appear in the feed next to
    // an expired one. No timer runs this — it is call-site driven (D-05).
    sweepRetention();

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
    // A failed attempt still happened: audit the attempt, not the content.
    // `Cancelled` returned above, so a cancel leaves no row (A3).
    appendAudit({
      ts: Date.now(),
      id: crypto.randomUUID(),
      outcome: 'failed',
      targetApp: appName,
      durationMs,
      model: store.settings.model,
      errorKind: 'api',
    });
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
 * first, so the text never lands in Dictata itself.
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

// ── Deleting the record ───────────────────────────────────────────────────────
// One mutation path for every destructive action. The dashboard routes and the
// History-window IPC both land here, so store, disk, bus, stats, tray and the
// History window cannot disagree about what still exists.

/** Point the paste-last target at a row that still exists. */
function rederiveLast() {
  const { cleaned, raw } = lastTarget(store.snapshot().history);
  lastCleaned = cleaned;
  lastRaw = raw;
}

/**
 * Delete one dictation or failed attempt and purge it from every surface.
 *
 * @param {string} id
 * @returns {number}  how many rows were removed
 */
function purgeEntry(id) {
  const { removed, wasLast, ids } = store.purgeEntry(id);
  // The live bus feeds /api/state and SSE — a row that survives there would
  // reappear on the next snapshot.
  bus.forgetMany(ids);
  if (wasLast) rederiveLast();
  notifyHistory();
  updateTrayMenu();
  if (removed) bus.publish('info', { message: 'Dictation deleted', kind: 'history' });
  return removed;
}

/**
 * Delete every dictation and failed attempt. Settings, the API key, the
 * dictionary and the dashboard token stay exactly as they were.
 *
 * @returns {number}  how many history rows were removed
 */
function clearAll() {
  const removed = store.clearAll();
  bus.forgetAll();
  rederiveLast();
  notifyHistory();
  updateTrayMenu();
  if (removed) {
    bus.publish('info', {
      message: `Cleared ${removed} dictation${removed === 1 ? '' : 's'}`,
      kind: 'history',
    });
  }
  return removed;
}

// ── Retention ─────────────────────────────────────────────────────────────────
/**
 * Apply the retention window to everything that expires at once.
 *
 * Call-site driven (no timer): launch, after every dictation and when the
 * setting changes. Two surfaces have to move together — the file and the live
 * bus — or an expired row keeps appearing in /api/state and over SSE until the
 * next restart.
 *
 * The audit ledger is deliberately exempt: audit facts outlive transcripts
 * (D-11 / D-12) and only the explicit clear action shrinks them.
 *
 * @returns {number}  how many history rows were removed
 */
function sweepRetention() {
  const days = normalizeRetentionDays(store.settings.retentionDays);
  const cutoff = cutoffFor(days, Date.now());
  if (cutoff === null) return 0;   // keep forever sweeps nothing

  const snapshot = store.snapshot();
  const history = snapshot.history || [];
  const events = snapshot.events || [];

  // One snapshot, both splitters: the history ids and the event ids have to be
  // forgotten from the bus together, after the same cutoff.
  const { expiredIds } = splitExpired(history, cutoff);
  const { expiredIds: expiredEventIds } = splitExpiredEvents(events, cutoff);
  const newestId = history[0]?.id;

  const removed = expiredIds.length ? store.purgeExpired(expiredIds) : 0;
  // The durable cut also re-applies the event cap, so it always runs.
  store.pruneEvents(cutoff);
  // Persisted events are rewritten above; the live buffer is what the feed
  // actually reads, so expired failed attempts must be forgotten from it too.
  bus.forgetMany([...expiredIds, ...expiredEventIds]);

  if (newestId && expiredIds.includes(newestId)) rederiveLast();

  if (removed) {
    notifyHistory();
    updateTrayMenu();
    bus.publish('info', {
      message: `Expired ${removed} dictation${removed === 1 ? '' : 's'} older than ${days} days`,
      kind: 'history',
    });
  }
  return removed;
}

/**
 * The facts the dashboard may display about the record (D-02).
 *
 * Runs inside every /api/state response, so it must stay O(1): the audit count
 * is a cached number, never a parse of the ledger file.
 *
 * @returns {{retentionDays: number, storeDir: string, auditCount: number}}
 */
function getPrivacyFacts() {
  return {
    retentionDays: store.settings.retentionDays,
    storeDir: path.dirname(store.file),
    auditCount: ledger.count(),
  };
}

// ── Audit ledger ──────────────────────────────────────────────────────────────
/**
 * Append one metadata-only audit row.
 *
 * Wrapped so a ledger failure can never reach the dictation pipeline: auditing
 * observes a dictation, it must never break one. The row itself is sanitised by
 * the ledger's allow-list, so no transcript text can be persisted.
 *
 * @param {object} row
 */
function appendAudit(row) {
  try {
    ledger.append(row);
  } catch (e) {
    console.warn('[ledger] append failed:', e.message);
  }
}

// ── Exporting the record ──────────────────────────────────────────────────────
/**
 * Ask for a path through the native dialog and write one full export there.
 *
 * The renderer only chooses the format. The path comes back from the dialog,
 * never from the page, so a renderer cannot direct a write at an arbitrary
 * file. A cancelled dialog writes nothing.
 *
 * @param {'history'|'audit'} kind
 * @param {'json'|'csv'} format
 * @returns {Promise<{saved: boolean, path?: string, canceled?: boolean, message: string}>}
 */
async function exportRecord(kind, format) {
  if (format !== 'json' && format !== 'csv') {
    return { saved: false, message: 'Choose JSON or CSV to export.' };
  }

  const isAudit = kind === 'audit';
  const date = new Date().toISOString().slice(0, 10);
  const name = `dictata-${kind}-${date}.${format}`;
  let defaultPath = name;
  try {
    defaultPath = path.join(app.getPath('documents'), name);   // dialog remembers the last folder
  } catch { /* a missing Documents folder is not a reason to refuse an export */ }

  const filters = format === 'csv'
    ? [{ name: 'CSV', extensions: ['csv'] }]
    : [{ name: 'JSON', extensions: ['json'] }];

  try {
    let count;
    let data;
    if (isAudit) {
      const records = ledger.read();   // export is the one caller allowed to read the whole ledger
      count = records.length;
      data = format === 'csv'
        ? toCsv(auditRows(records))
        : JSON.stringify({
          exportedAt: new Date().toISOString(),
          count,
          note: 'Audit records begin when this version was installed — earlier dictations are not backfilled.',
          audit: records,
        }, null, 2);
    } else {
      const history = store.snapshot().history || [];
      count = history.length;
      data = format === 'csv'
        ? toCsv(historyRows(history))
        : JSON.stringify({ exportedAt: new Date().toISOString(), count, history }, null, 2);
    }

    const options = {
      title: isAudit ? 'Export audit log' : 'Export dictation history',
      defaultPath,
      filters,
    };
    const owner = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return { saved: false, canceled: true, message: 'Export cancelled — nothing was written.' };
    }

    fs.writeFileSync(result.filePath, data, 'utf8');
    const noun = isAudit ? 'audit record' : 'dictation';
    return {
      saved: true,
      path: result.filePath,
      message: `Exported ${count} ${noun}${count === 1 ? '' : 's'} to ${result.filePath}`,
    };
  } catch (e) {
    // A filesystem failure is a message for the person clicking, not a
    // rejected promise in the renderer.
    console.warn('[export] failed:', e.message);
    return { saved: false, message: 'Export failed — check the folder is writable and try again.' };
  }
}

// ── Storage relocation ────────────────────────────────────────────────────────
/**
 * Point the record at another folder chosen in the native picker.
 *
 * The path string does come back from the renderer, so it is treated as
 * untrusted: `storage.moveTo` owns every check (absolute, real path, a folder
 * not a file, no containment, writability, COPYFILE_EXCL) and is the only
 * validation path. Flushing first makes the copy the whole record.
 *
 * @param {string} target
 * @returns {{moved: boolean, dir?: string, message: string}}
 */
function moveStorage(target) {
  if (typeof target !== 'string' || !target.trim()) {
    return { moved: false, message: 'Choose a folder first — nothing was moved.' };
  }

  store.flush();   // the copy must not race the 150 ms save debounce

  const result = storage.moveTo(target);
  if (!result.moved) return { moved: false, message: result.message };

  const dir = result.dir;
  store.setFile(path.join(dir, 'dictata.json'));
  ledger.setFile(path.join(dir, 'dictata-audit.ndjson'));
  store.flush();

  // No path in the payload: the persisted event log is part of the record and
  // must not learn the user's folder layout. The dashboard re-reads /api/state
  // on this event (kind: 'storage').
  bus.publish('info', {
    message: 'Storage moved — dictations now save in the new folder.',
    kind: 'storage',
  });
  updateTrayMenu();
  return { moved: true, dir, message: `Dictations now save in ${dir}` };
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
    if ('retentionDays' in patch) sweepRetention();
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

  // Privacy & Data
  ipcMain.handle('vf:data-info', () => getPrivacyFacts());
  ipcMain.handle('vf:set-retention', (_e, days) => {
    // Clamp before persisting: a hand-edited value or a stray renderer call
    // must not become an unlisted (and therefore unbounded) window.
    const retentionDays = normalizeRetentionDays(days);
    store.updateSettings({ retentionDays });
    const removed = sweepRetention();
    return { retentionDays, removed };
  });
  // The only action that shrinks the audit log (T-01-09); it never touches
  // a transcript.
  ipcMain.handle('vf:clear-audit', () => {
    ledger.clear();
    return { cleared: true };
  });
  // Exports go through a native save dialog; the renderer only names a format.
  ipcMain.handle('vf:export-history', (_e, format) => exportRecord('history', format));
  ipcMain.handle('vf:export-audit', (_e, format) => exportRecord('audit', format));

  // Storage relocation (COMP-02). The window only chooses a folder in the
  // native dialog; the path it hands back is untrusted input to moveTo.
  ipcMain.handle('vf:choose-storage-dir', async () => {
    const options = {
      title: 'Choose a folder for your dictations',
      properties: ['openDirectory', 'promptToCreate'],
      defaultPath: storage.currentDir(),
    };
    const owner = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
  ipcMain.handle('vf:move-storage', (_e, target) => moveStorage(target));

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
  ipcMain.handle('vf:delete-history', (_e, id) => purgeEntry(id));
  ipcMain.handle('vf:clear-history', () => clearAll());
  ipcMain.handle('vf:paste-entry', (_e, text) => pasteInto(text));
}
