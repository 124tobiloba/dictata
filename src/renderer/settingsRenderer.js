// settingsRenderer.js — wires settings UI ↔ main-process store

let data = null; // full store snapshot

async function init() {
  data = await window.vf.getStore();
  loadGeneral();
  loadShortcuts();
  loadAI();
  loadDictionary();
  loadStats();
  loadPrivacy();
}

// ── Nav ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.panel}`).classList.add('active');
  });
});

// ── General ───────────────────────────────────────────────────────────────────
function loadGeneral() {
  const s = data.settings;
  bind('doubleTap',       s.doubleTapLocks,      (v) => save({ doubleTapLocks: v }));
  bind('restoreClipboard',s.restoreClipboard,    (v) => save({ restoreClipboard: v }));
  bind('sounds',          s.sounds,              (v) => save({ sounds: v }));
  bind('launchAtLogin',   s.launchAtLogin !== false, (v) => save({ launchAtLogin: v }));
  bindSelect('pasteMethod',s.pasteMethod,        (v) => save({ pasteMethod: v }));
  bindSelect('maxDuration', String(s.maxRecordingSec || 300), (v) => save({ maxRecordingSec: Number(v) }));
  bind('dashboardEnabled', s.dashboardEnabled !== false, (v) => save({ dashboardEnabled: v }));
  bindNumber('dashboardPort', s.dashboardPort || 7788, (v) => save({ dashboardPort: v }));
  bindText('userName',   s.userName || '',       (v) => save({ userName: v }));
  loadMicrophones(s.microphoneId || 'default');
  loadDashboardLink();
}

/** Show the dashboard URL so it can be bookmarked. */
async function loadDashboardLink() {
  const url = await window.vf.dashboardUrl();
  const el = document.getElementById('dashboardUrl');
  if (el) el.textContent = url || 'The dashboard is not running.';
  document.getElementById('openDashboard')?.addEventListener('click', async () => {
    await window.vf.openDashboard();
    loadDashboardLink();
  });
  document.getElementById('testDashboard')?.addEventListener('click', async () => {
    await window.vf.dashboardTest();
    const el = document.getElementById('dashboardUrl');
    if (el) el.textContent = 'Test event sent — watch the page.';
  });
  document.getElementById('copyDashboard')?.addEventListener('click', async () => {
    const url = await window.vf.dashboardUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      const el = document.getElementById('dashboardUrl');
      if (el) el.textContent = 'Link copied to the clipboard.';
    } catch {
      const el = document.getElementById('dashboardUrl');
      if (el) el.textContent = url;
    }
  });
}

/** Fill the microphone dropdown with the available inputs. */
async function loadMicrophones(selected) {
  const sel = document.getElementById('microphone');
  if (!sel) return;

  let devices = await listInputs();
  if (!devices.some((d) => d.label)) {
    // Labels are hidden until the microphone permission was granted.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      devices = await listInputs();
    } catch { /* permission denied — keep the default entry only */ }
  }

  const current = selected && selected !== 'default'
    ? devices.find((d) => d.deviceId === selected || d.label === selected)
    : null;

  sel.innerHTML = '';
  sel.appendChild(new Option('System default', 'default'));
  devices.forEach((d) => {
    const name = d.label || `Microphone ${d.deviceId.slice(0, 8)}`;
    sel.appendChild(new Option(name, d.deviceId));
  });

  sel.value = current ? current.deviceId : (selected || 'default');
  if (sel.value !== (current ? current.deviceId : (selected || 'default'))) {
    // The stored device is gone — fall back to the default.
    sel.value = 'default';
  }
  sel.onchange = () => save({ microphoneId: sel.value });
}

async function listInputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}

// ── Shortcuts ─────────────────────────────────────────────────────────────────
function loadShortcuts() {
  const sc = data.settings.shortcuts;
  setKbd('sc-ptt',    sc.pushToTalk);
  setKbd('sc-hf',     sc.handsFree);
  setKbd('sc-cancel', sc.cancel);
  setKbd('sc-paste',  sc.pasteLast);
}

function setKbd(id, chord) {
  document.getElementById(id).innerHTML =
    (chord || []).map((k) => `<kbd>${k}</kbd>`).join(' + ');
}

// ── AI ────────────────────────────────────────────────────────────────────────
function loadAI() {
  const s = data.settings;
  bindSelect('model',        s.model,          (v) => save({ model: v }));
  bindSelect('style',        s.style,          (v) => save({ style: v }));
  bindSelect('language',     s.language,       (v) => save({ language: v }));
  bind('appAwareStyle',      s.appAwareStyle,  (v) => save({ appAwareStyle: v }));
  loadApiKey(s);
}

// ── Dictionary ────────────────────────────────────────────────────────────────
function loadDictionary() {
  renderDictList();
  renderReplList();

  document.getElementById('dict-add').addEventListener('click', () => {
    const inp = document.getElementById('dict-input');
    const term = inp.value.trim();
    if (!term) return;
    data.dictionary = [...(data.dictionary || []), { term }];
    window.vf.setDictionary(data.dictionary);
    inp.value = '';
    renderDictList();
  });

  document.getElementById('repl-add').addEventListener('click', () => {
    const from = document.getElementById('repl-from').value.trim();
    const to   = document.getElementById('repl-to').value.trim();
    if (!from || !to) return;
    data.replacements = [...(data.replacements || []), { from, to }];
    window.vf.setReplacements(data.replacements);
    document.getElementById('repl-from').value = '';
    document.getElementById('repl-to').value = '';
    renderReplList();
  });
}

function renderDictList() {
  const list = document.getElementById('dict-list');
  list.innerHTML = '';
  (data.dictionary || []).forEach(({ term }, i) => {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.innerHTML = `${esc(term)} <button class="tag-del" title="Remove">×</button>`;
    tag.querySelector('button').onclick = () => {
      data.dictionary.splice(i, 1);
      window.vf.setDictionary(data.dictionary);
      renderDictList();
    };
    list.appendChild(tag);
  });
}

function renderReplList() {
  const list = document.getElementById('repl-list');
  list.innerHTML = '';
  (data.replacements || []).forEach(({ from, to }, i) => {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.innerHTML = `<kbd>${esc(from)}</kbd> → ${esc(to)} <button class="tag-del" title="Remove">×</button>`;
    tag.querySelector('button').onclick = () => {
      data.replacements.splice(i, 1);
      window.vf.setReplacements(data.replacements);
      renderReplList();
    };
    list.appendChild(tag);
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function loadStats() {
  const st = data.stats || {};
  document.getElementById('stat-words').textContent    = (st.words || 0).toLocaleString();
  document.getElementById('stat-sessions').textContent = (st.sessions || 0).toLocaleString();
  document.getElementById('stat-min').textContent      = Math.round((st.msSpoken || 0) / 60000).toLocaleString();
}

// ── Privacy & Data ────────────────────────────────────────────────────────────
// This window owns the retention control (D-01); the dashboard only displays
// the resulting facts. Saving goes through vf:set-retention, which clamps the
// value and sweeps immediately, so the new window takes effect on this click.
function loadPrivacy() {
  const s = data.settings || {};
  bindSelect('retentionDays', String(s.retentionDays || 0), async (value) => {
    const result = await window.vf.setRetention(Number(value));
    data.settings.retentionDays = result.retentionDays;
    document.getElementById('retentionDays').value = String(result.retentionDays);
    loadDataInfo();
  });
  document.getElementById('clearAudit')?.addEventListener('click', clearAuditLog);
  document.getElementById('changeStorage')?.addEventListener('click', changeStorage);
  document.getElementById('exportHistoryJson')?.addEventListener('click', () => runExport('history', 'json'));
  document.getElementById('exportHistoryCsv')?.addEventListener('click', () => runExport('history', 'csv'));
  document.getElementById('exportAuditJson')?.addEventListener('click', () => runExport('audit', 'json'));
  document.getElementById('exportAuditCsv')?.addEventListener('click', () => runExport('audit', 'csv'));
  loadDataInfo();
}

/** The resolved data folder and the audit count, read-only — facts, not fields. */
async function loadDataInfo() {
  const info = await window.vf.dataInfo();
  const el = document.getElementById('storagePath');
  if (el) el.textContent = info?.storeDir || '—';
  renderAuditCount(info?.auditCount);
}

/**
 * Point storage at another folder. The main process validates the target,
 * copies, verifies the copy and only then removes the old files; this window
 * reports the result.
 *
 * A successful move writes the returned folder into `storagePath` BEFORE the
 * message is shown, so the window that started the move cannot keep displaying
 * the folder the record has already left.
 */
async function changeStorage() {
  const status = document.getElementById('storageStatus');
  if (status) status.textContent = 'Choose a folder…';

  let target;
  try {
    target = await window.vf.chooseStorageDir();
  } catch {
    if (status) status.textContent = 'Could not open the folder picker — try again.';
    return;
  }
  if (!target) {
    if (status) status.textContent = 'No folder chosen — nothing was moved.';
    return;
  }

  if (status) status.textContent = 'Moving dictations and verifying the copy…';
  let result;
  try {
    result = await window.vf.moveStorage(target);
  } catch {
    if (status) status.textContent = 'The move failed — your record is still in its original folder.';
    return;
  }

  if (result?.moved && result.dir) {
    const field = document.getElementById('storagePath');
    if (field) field.textContent = result.dir;
    await loadDataInfo();
  }
  if (status) status.textContent = result?.message || (result?.moved ? 'Storage moved.' : 'Nothing was moved.');
}

function renderAuditCount(value) {
  const count = Number(value) || 0;
  const el = document.getElementById('auditCount');
  if (el) el.textContent = `${count.toLocaleString()} audit record${count === 1 ? '' : 's'}`;
}

/**
 * Clearing the audit log is its own confirmed action (D-12). The confirmation
 * names the count and says explicitly that transcripts are untouched, because
 * the two records have separate lifecycles.
 */
async function clearAuditLog() {
  const info = await window.vf.dataInfo();
  const count = Number(info?.auditCount) || 0;
  const label = `${count.toLocaleString()} audit record${count === 1 ? '' : 's'}`;
  if (!confirm(`Delete ${label}? Your dictations are not touched.`)) return;
  await window.vf.clearAudit();
  await loadDataInfo();
}

/**
 * Export one record through the native save dialog. The window picks only the
 * format; the main process asks for the path and writes the file, so the page
 * never chooses a destination.
 */
async function runExport(kind, format) {
  const status = document.getElementById('exportStatus');
  if (status) status.textContent = 'Preparing export…';
  try {
    const result = kind === 'audit'
      ? await window.vf.exportAudit(format)
      : await window.vf.exportHistory(format);
    if (status) status.textContent = result?.message || (result?.saved ? 'Export saved.' : 'Export cancelled.');
  } catch {
    if (status) status.textContent = 'Export failed — try again.';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function save(patch) {
  data.settings = await window.vf.updateSettings(patch);
}

function bind(id, initial, onChange) {
  const el = document.getElementById(id);
  el.checked = !!initial;
  el.addEventListener('change', () => onChange(el.checked));
}

function bindSelect(id, initial, onChange) {
  const el = document.getElementById(id);
  el.value = initial;
  el.addEventListener('change', () => onChange(el.value));
}

function bindText(id, initial, onChange) {
  const el = document.getElementById(id);
  el.value = initial;
  let timer;
  el.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => onChange(el.value), 400);
  });
}

function bindNumber(id, initial, onChange) {
  const el = document.getElementById(id);
  el.value = initial;
  let timer;
  el.addEventListener('change', () => {
    clearTimeout(timer);
    timer = setTimeout(() => onChange(Number(el.value) || 0), 400);
  });
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── API Key ──────────────────────────────────────────────────────────────────
function loadApiKey(s) {
  const inp = document.getElementById('apiKey');
  const status = document.getElementById('keyStatus');
  const testBtn = document.getElementById('testKey');
  const toggleBtn = document.getElementById('toggleKeyVis');
  const link = document.getElementById('aiStudioLink');

  const hadKey = Boolean((s.apiKey || '').trim());
  let guided = false;

  inp.value = s.apiKey || '';

  let timer;
  inp.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const key = inp.value.trim();
      await save({ apiKey: key });
      // First run: the moment the empty key field becomes a real key is where a
      // new user expects the app to continue. Verify it first, then open the
      // dashboard — a typo should keep them here with the reason instead of
      // dropping them into an app that cannot dictate.
      if (!hadKey && !guided && key) {
        guided = true;
        status.textContent = 'Checking your key…';
        status.style.color = 'var(--muted)';
        const r = await window.vf.testKey(key);
        status.textContent = r.ok ? `${r.message} Opening your dashboard…` : r.message;
        status.style.color = r.ok ? 'var(--green)' : '#fc8181';
        if (r.ok) window.vf.openDashboard();
        else guided = false;   // let them correct it and try again
      }
    }, 400);
  });

  toggleBtn.addEventListener('click', () => {
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  testBtn.addEventListener('click', async () => {
    status.textContent = 'Testing…';
    status.style.color = 'var(--muted)';
    const r = await window.vf.testKey(inp.value.trim());
    status.textContent = r.message;
    status.style.color = r.ok ? 'var(--green)' : '#fc8181';
  });

  link?.addEventListener('click', (e) => {
    e.preventDefault();
    // Open in the real browser (not in an Electron window)
    window.vf.openExternal('https://aistudio.google.com/apikey');
  });
}

init();
