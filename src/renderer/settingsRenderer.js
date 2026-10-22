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
  loadDataInfo();
}

/** The resolved data folder, read-only — it is a fact, not a form field. */
async function loadDataInfo() {
  const info = await window.vf.dataInfo();
  const el = document.getElementById('dataInfo');
  if (el) el.textContent = info?.storeDir || '—';
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

  inp.value = s.apiKey || '';

  let timer;
  inp.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => save({ apiKey: inp.value.trim() }), 400);
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
