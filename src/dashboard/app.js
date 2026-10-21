/**
 * app.js — the Voice Flow live activity dashboard.
 *
 * Vanilla JS, no build step. Connects to the app's local server:
 *   GET /api/state    → the current snapshot
 *   GET /api/events   → SSE stream of live activity
 *
 * A "demo" mode replays a scripted session so the page looks alive even
 * when the app is idle.
 */

const $ = (sel) => document.querySelector(sel);

const params = new URLSearchParams(location.search);
const token = params.get('token') || '';

const state = {
  app: { state: 'idle', model: null },
  analytics: null,
  history: [],
  events: [],
  partial: '',
  mode: 'live',
  connected: false,
};

// ── Formatting helpers ───────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── Data ─────────────────────────────────────────────────────────────────────

async function loadState() {
  try {
    const res = await fetch(`/api/state?token=${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.app = { ...state.app, ...data.app };
    state.analytics = data.analytics;
    state.history = data.history || [];
    state.events = data.events || [];
    renderAll();
  } catch (err) {
    setConnection('offline');
    if (err.message === 'HTTP 401') {
      showToast('Open the dashboard from the Voice Flow tray menu — the link contains the access token.');
    }
  }
}

function connect() {
  if (!token) {
    setConnection('offline');
    showToast('No access token in the URL. Use “Open Dashboard” in the Voice Flow tray menu.');
    return;
  }
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  es.addEventListener('hello', () => setConnection('live'));
  es.onmessage = (msg) => {
    let event;
    try { event = JSON.parse(msg.data); } catch { return; }
    if (state.mode === 'demo') return;          // the demo owns the screen
    handleEvent(event);
  };
  es.onerror = () => setConnection('reconnecting');
  es.addEventListener('open', () => setConnection('live'));
}

function handleEvent(event) {
  if (event.type === 'state') {
    state.app.state = event.state;
    state.app.handsFree = event.handsFree;
    state.partial = '';
    renderHero();
    return;
  }
  if (event.type === 'partial') {
    state.partial = event.text;
    renderHero();
    return;
  }
  if (event.type === 'dictation') {
    state.partial = '';
    state.events.unshift(event);
    state.history.unshift(event);
    if (state.events.length > 200) state.events.length = 200;
    renderFeed();
    renderHero();
    refreshAnalytics();
    return;
  }
  if (event.type === 'error' || event.type === 'info') {
    state.events.unshift(event);
    if (state.events.length > 200) state.events.length = 200;
    renderErrors();
    refreshAnalytics();
  }
}

/** Pull fresh analytics after a dictation (cheap, local). */
let analyticsTimer = null;
function refreshAnalytics() {
  clearTimeout(analyticsTimer);
  analyticsTimer = setTimeout(loadState, 250);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderAll() {
  renderHero();
  renderStats();
  renderFeed();
  renderErrors();
  renderCharts();
}

function setConnection(status) {
  state.connected = status === 'live';
  const chip = $('#statusChip');
  const text = $('#statusText');
  if (status === 'live') {
    chip.dataset.state = state.app.state || 'idle';
    text.textContent = labelFor(state.app.state);
  } else if (status === 'reconnecting') {
    chip.dataset.state = 'idle';
    text.textContent = 'Reconnecting…';
  } else {
    chip.dataset.state = 'idle';
    text.textContent = 'Offline';
  }
}

function labelFor(s) {
  return { idle: 'Idle', listening: 'Listening', processing: 'Processing' }[s] || 'Idle';
}

function renderHero() {
  const appState = state.app.state || 'idle';
  $('#orb').dataset.state = appState;
  $('#statusChip').dataset.state = appState;
  $('#statusText').textContent = labelFor(appState) + (state.app.handsFree ? ' · locked' : '');
  $('#modelChip').textContent = state.app.model || '—';

  const caption = $('#liveCaption .caption-text');
  if (state.partial) {
    caption.textContent = state.partial;
    caption.classList.add('typing');
  } else {
    caption.classList.remove('typing');
    caption.textContent = {
      idle: 'Waiting for activity…',
      listening: 'Listening — speak now…',
      processing: 'Transcribing…',
    }[appState] || 'Waiting for activity…';
  }

  const totals = state.analytics?.totals;
  if (totals) {
    $('#heroTotal').textContent = `${totals.words.toLocaleString()} words dictated`;
  }
  $('#heroUptime').textContent = `uptime ${fmtDuration(Date.now() - (state.app.startedAt || Date.now()))}`;
}

function renderStats() {
  const t = state.analytics?.totals;
  const host = $('#stats');
  if (!t) { host.innerHTML = ''; return; }

  const cards = [
    { label: 'Words today', value: t.todayWords.toLocaleString(), sub: `${t.todaySessions} sessions` },
    { label: 'Total words', value: t.words.toLocaleString(), sub: `${t.sessions} dictations` },
    { label: 'Speaking time', value: `${t.minutes}m`, sub: `${t.wpm} words/min` },
    { label: 'Avg latency', value: t.avgLatencyMs ? fmtDuration(t.avgLatencyMs) : '—', sub: 'transcription' },
    { label: 'Errors', value: String(t.errors), sub: `${t.errorRate}% of attempts`, tone: t.errors ? 'bad' : 'good' },
    { label: 'Models', value: String(state.analytics.models.length || 1), sub: (state.analytics.models[0]?.name) || '—' },
  ];

  host.innerHTML = cards.map((c) => `
    <div class="stat">
      <div class="stat-label">${esc(c.label)}</div>
      <div class="stat-value ${c.tone || ''}">${esc(c.value)}</div>
      <div class="stat-sub">${esc(c.sub)}</div>
    </div>`).join('');
}

function renderFeed() {
  const feed = $('#feed');
  const items = state.events.filter((e) => ['dictation', 'info'].includes(e.type)).slice(0, 40);

  if (!items.length && !state.partial) {
    feed.innerHTML = '<div class="empty">Nothing yet — dictate something with <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>.</div>';
    $('#feedCount').textContent = '';
    return;
  }

  const cards = [];

  // The live card — words arriving right now.
  if (state.partial) {
    cards.push(`
      <div class="entry live">
        <div class="entry-top"><span class="dot" style="background:var(--accent)"></span><span>Transcribing…</span></div>
        <div class="entry-text shimmer">${esc(state.partial)}</div>
      </div>`);
  }

  for (const e of items) {
    if (e.type === 'dictation') {
      const metrics = [];
      if (Number.isFinite(e.durationMs)) metrics.push(`<span class="tag">rec ${fmtDuration(e.durationMs)}</span>`);
      if (Number.isFinite(e.transcribeMs)) metrics.push(`<span class="tag">transcribe ${fmtDuration(e.transcribeMs)}</span>`);
      if (Number.isFinite(e.pasteMs)) metrics.push(`<span class="tag">paste ${fmtDuration(e.pasteMs)}</span>`);
      if (e.model) metrics.push(`<span class="tag model">${esc(e.model)}</span>`);
      if (e.pasted === false) metrics.push(`<span class="tag">not pasted</span>`);
      cards.push(`
        <div class="entry">
          <div class="entry-top">
            <span>${fmtTime(e.ts)}</span><span>·</span><span>${fmtAgo(e.ts)}</span>
          </div>
          <div class="entry-text">${esc(e.text || e.cleaned)}</div>
          <div class="entry-metrics">${metrics.join('')}</div>
        </div>`);
    } else if (e.type === 'info') {
      cards.push(`
        <div class="entry">
          <div class="entry-top"><span>${fmtTime(e.ts)}</span><span>·</span><span>note</span></div>
          <div class="entry-text" style="color:var(--muted);font-size:13.5px">${esc(e.message)}</div>
        </div>`);
    }
  }

  feed.innerHTML = cards.join('');
  $('#feedCount').textContent = `${items.length} shown`;
}

function renderErrors() {
  const host = $('#errors');
  const errors = state.events.filter((e) => e.type === 'error').slice(0, 30);
  const infos = state.events.filter((e) => e.type === 'info' && e.kind !== 'cancel').slice(0, 10);

  if (!errors.length && !infos.length) {
    host.innerHTML = '<div class="empty ok">No errors. 🎉</div>';
    $('#errorCount').textContent = '';
    return;
  }

  const items = [
    ...errors.map((e) => `
      <div class="error-item">
        <div class="error-msg">${esc(e.message)}</div>
        <div class="error-meta"><span>${fmtTime(e.ts)}</span><span>${fmtAgo(e.ts)}</span>${e.kind ? `<span>${esc(e.kind)}</span>` : ''}</div>
      </div>`),
    ...infos.map((e) => `
      <div class="error-item info">
        <div class="error-msg">${esc(e.message)}</div>
        <div class="error-meta"><span>${fmtTime(e.ts)}</span><span>${fmtAgo(e.ts)}</span></div>
      </div>`),
  ];

  host.innerHTML = items.join('');
  $('#errorCount').textContent = `${errors.length} error${errors.length === 1 ? '' : 's'}`;
}

// ── Charts (hand rolled SVG) ─────────────────────────────────────────────────

function renderCharts() {
  const a = state.analytics;
  if (!a) return;
  chartDays(a.days);
  chartLatency(a.latency);
  chartModels(a.models);
  chartHours(a.hours);
}

function chartDays(days) {
  const host = $('#chartDays');
  if (!days || !days.length) { host.innerHTML = '<div class="empty">No data yet</div>'; return; }
  const max = Math.max(...days.map((d) => d.words), 1);
  const W = 520; const H = 190; const pad = 26;
  const bw = (W - pad * 2) / days.length;

  const bars = days.map((d, i) => {
    const h = (d.words / max) * (H - 54);
    const x = pad + i * bw + bw * 0.18;
    const w = bw * 0.64;
    const y = H - 28 - h;
    return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="5"
              fill="url(#grad)" opacity="${0.45 + 0.55 * (d.words / max)}"></rect>
            <text class="value-label" x="${(x + w / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle">${d.words || ''}</text>
            <text class="axis-label" x="${(x + w / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  }).join('');

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Words per day">
    <defs><linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#a78bfa"/><stop offset="100%" stop-color="#38bdf8"/>
    </linearGradient></defs>
    ${bars}
  </svg>`;
}

function chartLatency(points) {
  const host = $('#chartLatency');
  if (!points || points.length < 2) {
    host.innerHTML = '<div class="empty">Not enough data yet</div>';
    $('#latencyNote').textContent = '—';
    return;
  }
  const W = 520; const H = 190; const pad = 30;
  const values = points.map((p) => p.ms);
  const max = Math.max(...values, 1);
  // Scale from zero — scaling between min and max would make two similar
  // values look like a dramatic spike.
  const x = (i) => pad + (i * (W - pad * 2)) / (points.length - 1);
  const y = (v) => H - 34 - (v / max) * (H - 66);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.ms).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - 34} L${x(0).toFixed(1)},${H - 34} Z`;
  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.ms).toFixed(1)}" r="2.6" fill="#a78bfa"></circle>`).join('');
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Transcription latency">
    <defs><linearGradient id="lat" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(167,139,250,0.42)"/><stop offset="100%" stop-color="rgba(167,139,250,0)"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#lat)"></path>
    <path d="${line}" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
    ${dots}
    <text class="axis-label" x="${pad}" y="${H - 10}">${fmtTime(points[0].ts)}</text>
    <text class="axis-label" x="${W - pad}" y="${H - 10}" text-anchor="end">${fmtTime(points[points.length - 1].ts)}</text>
    <text class="axis-label" x="${pad}" y="16">${fmtDuration(max)} worst</text>
  </svg>`;
  $('#latencyNote').textContent = `avg ${fmtDuration(avg)}`;
}

function chartModels(models) {
  const host = $('#chartModels');
  if (!models || !models.length) { host.innerHTML = '<div class="empty">No dictations yet</div>'; return; }
  const total = models.reduce((n, m) => n + m.count, 0);
  const R = 56; const C = 2 * Math.PI * R;
  const palette = ['#a78bfa', '#38bdf8', '#68d391', '#f6c177', '#fc8181'];

  let offset = 0;
  const arcs = models.map((m, i) => {
    const len = (m.count / total) * C;
    const arc = `<circle cx="90" cy="90" r="${R}" fill="none" stroke="${palette[i % palette.length]}" stroke-width="16"
      stroke-dasharray="${len.toFixed(1)} ${(C - len).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}"
      transform="rotate(-90 90 90)" stroke-linecap="butt"></circle>`;
    offset += len;
    return arc;
  }).join('');

  const legend = models.map((m, i) => `
    <div class="legend">
      <span class="swatch" style="background:${palette[i % palette.length]}"></span>
      <span class="name" title="${esc(m.name)}">${esc(m.name)}</span>
      <span class="value">${m.count} · ${Math.round((m.count / total) * 100)}%</span>
    </div>`).join('');

  host.innerHTML = `<div style="display:flex;align-items:center;gap:22px;width:100%">
    <svg viewBox="0 0 180 180" style="width:150px;flex:none" role="img" aria-label="Models used">${arcs}</svg>
    <div style="flex:1;min-width:0">${legend}</div>
  </div>`;
}

function chartHours(hours) {
  const host = $('#chartHours');
  if (!hours) { host.innerHTML = '<div class="empty">No data yet</div>'; return; }
  const max = Math.max(...hours, 1);
  const W = 520; const H = 130;
  const bw = W / 24;
  const bars = hours.map((h, i) => {
    const bh = (h / max) * (H - 40);
    const x = i * bw + 2;
    const y = H - 22 - bh;
    const op = h === 0 ? 0.08 : 0.3 + 0.7 * (h / max);
    return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${Math.max(bh, 2).toFixed(1)}" rx="3"
              fill="#a78bfa" opacity="${op.toFixed(2)}"></rect>`;
  }).join('');
  const labels = [0, 6, 12, 18].map((h) =>
    `<text class="axis-label" x="${(h * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${pad(h)}:00</text>`).join('');

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Dictations by hour of day">
    ${bars}${labels}
  </svg>`;
}

// ── Demo mode ────────────────────────────────────────────────────────────────

const DEMO = [
  { at: 400, do: () => demoState('listening') },
  { at: 1200, do: () => demoPartial('Can you help me write') },
  { at: 1900, do: () => demoPartial('Can you help me write the quarterly summary') },
  { at: 2700, do: () => demoPartial('Can you help me write the quarterly summary before Friday?') },
  { at: 3600, do: () => demoDictation({
      text: 'Can you help me write the quarterly summary before Friday?',
      words: 12, durationMs: 4200, transcribeMs: 2180, pasteMs: 84, model: 'gemini-2.5-flash',
    }) },
  { at: 5200, do: () => demoState('idle') },
  { at: 6200, do: () => demoDictation({
      text: 'Ship it, but let me know if the error rate goes above two percent.',
      words: 15, durationMs: 5100, transcribeMs: 1740, pasteMs: 76, model: 'gemini-2.5-flash',
    }) },
  { at: 8200, do: () => demoError('Gemini 429: Resource exhausted — the model is at capacity') },
  { at: 9800, do: () => demoInfo('gemini-3.5-flash was busy — gemini-2.5-flash answered instead') },
  { at: 11000, do: () => demoDictation({
      text: 'Reminder: the dashboard is served locally, nothing leaves this machine.',
      words: 12, durationMs: 3900, transcribeMs: 1520, pasteMs: 69, model: 'gemini-2.5-flash',
    }) },
  { at: 14000, do: () => demoState('idle') },
];

let demoTimers = [];
let demoLoop = 0;

function demoState(s) {
  state.app.state = s;
  state.partial = '';
  renderHero();
}

function demoPartial(text) {
  state.partial = text;
  state.app.state = 'processing';
  renderHero();
}

function demoDictation(entry) {
  state.partial = '';
  state.app.state = 'idle';
  state.events.unshift({ id: `demo-${Date.now()}`, ts: Date.now(), type: 'dictation', ...entry });
  renderFeed();
  renderHero();
}

function demoError(message) {
  state.events.unshift({ id: `demo-${Date.now()}`, ts: Date.now(), type: 'error', message, kind: 'api' });
  renderErrors();
}

function demoInfo(message) {
  state.events.unshift({ id: `demo-${Date.now()}`, ts: Date.now(), type: 'info', message });
  renderErrors();
}

function startDemo() {
  stopDemo();
  state.mode = 'demo';
  $('#modeToggle').classList.add('active');
  $('#modeToggle').textContent = 'Live';
  showToast('Demo mode — showing a scripted session');
  runDemo();
}

function runDemo() {
  demoTimers = DEMO.map((step) => setTimeout(step.do, step.at));
  demoLoop = setTimeout(() => { if (state.mode === 'demo') runDemo(); }, 16000);
}

function stopDemo() {
  demoTimers.forEach(clearTimeout);
  demoTimers = [];
  clearTimeout(demoLoop);
}

// ── Chrome ───────────────────────────────────────────────────────────────────

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, 6000);
}

$('#modeToggle').addEventListener('click', () => {
  if (state.mode === 'demo') {
    stopDemo();
    state.mode = 'live';
    $('#modeToggle').classList.remove('active');
    $('#modeToggle').textContent = 'Demo';
    loadState();
  } else {
    startDemo();
  }
});

$('#themeToggle').addEventListener('click', () => {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('vf-theme', next); } catch { /* private mode */ }
});

try {
  const saved = localStorage.getItem('vf-theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* private mode */ }

// Keep the relative timestamps fresh.
setInterval(() => {
  if (state.mode === 'live') { renderFeed(); renderErrors(); }
  renderHero();
}, 5000);

loadState();
connect();
