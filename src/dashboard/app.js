/**
 * app.js — the Voice Flow live activity dashboard.
 *
 * Vanilla JS, no build step. Talks to the app's local server:
 *   GET /api/state    → the current snapshot
 *   GET /api/events   → SSE stream of live activity
 *
 * The keyboard shortcuts are the primary interface, so they are read from
 * the app's own settings — the page can never disagree with the app.
 */

const $ = (sel) => document.querySelector(sel);

const params = new URLSearchParams(location.search);
const token = params.get('token') || '';

const state = {
  app: { state: 'idle', model: null, shortcuts: null, handsFree: false },
  analytics: null,
  events: [],
  partial: '',
  connection: 'connecting',   // connecting | live | reconnecting | offline
  level: 0,
  levelTarget: 0,
  levelAt: 0,
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

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

// ── Shortcuts ────────────────────────────────────────────────────────────────

const SHORTCUT_INFO = [
  { key: 'pushToTalk', label: 'Dictate', hint: 'press again to stop & paste' },
  { key: 'handsFree', label: 'Hands-free', hint: 'lock the mic open' },
  { key: 'cancel', label: 'Cancel', hint: 'abort the recording' },
  { key: 'pasteLast', label: 'Paste again', hint: 're-paste the last text' },
];

function keycaps(chord) {
  if (!chord || !chord.length) return '';
  return chord.map((k) => `<kbd class="key" data-key="${esc(k)}">${esc(k)}</kbd>`).join('');
}

/** Flash the keycaps of a shortcut so the user sees which key did what. */
function flashShortcut(action) {
  const map = {
    start: 'pushToTalk', stop: 'pushToTalk', lock: 'pushToTalk', 'start-lock': 'pushToTalk',
    cancel: 'cancel', pasteLast: 'pasteLast',
  };
  const name = map[action];
  if (!name) return;
  const chord = state.app.shortcuts?.[name];
  if (!chord) return;
  for (const key of chord) {
    const el = document.querySelector(`.key[data-key="${CSS.escape(key)}"]`);
    if (!el) continue;
    el.dataset.fired = 'true';
    setTimeout(() => { el.dataset.fired = 'false'; }, 220);
  }
}

function renderShortcuts() {
  const list = $('#shortcutList');
  const shortcuts = state.app.shortcuts || {};
  list.innerHTML = SHORTCUT_INFO.map(({ key, label, hint }) => {
    const chord = shortcuts[key];
    if (!chord || !chord.length) return '';
    return `<li class="shortcut">
      <span class="keys">${keycaps(chord)}</span>
      <span class="label">${esc(label)}</span>
      <span class="hint">${esc(hint)}</span>
    </li>`;
  }).join('');

  const ptt = shortcuts.pushToTalk;
  $('#heroKeys').innerHTML = ptt ? keycaps(ptt) : '';
}

// ── Data ─────────────────────────────────────────────────────────────────────

async function loadState() {
  try {
    const res = await fetch(`/api/state?token=${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.app = { ...state.app, ...data.app };
    state.analytics = data.analytics;
    state.events = data.events || [];
    renderAll();
    return true;
  } catch (err) {
    if (err.message === 'HTTP 401') setConnection('offline');
    else setConnection('reconnecting');
    return false;
  }
}

let source = null;
let retryDelay = 1000;
let retryTimer = null;

function connect() {
  if (!token) {
    setConnection('offline', 'This page was opened without an access token.');
    return;
  }
  if (source) { source.close(); source = null; }

  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  source = es;

  es.addEventListener('hello', () => {
    if (es !== source) return;          // a superseded connection
    retryDelay = 1000;
    setConnection('live');
  });
  es.onmessage = (msg) => {
    if (es !== source) return;
    let event;
    try { event = JSON.parse(msg.data); } catch { return; }
    handleEvent(event);
  };
  es.onerror = () => {
    if (es !== source) return;          // a stale connection must not
                                        // affect the live one
    // A closed stream means the server refused us (a 401) — retry slowly.
    if (es.readyState === EventSource.CLOSED) {
      scheduleRetry();
    } else {
      setConnection('reconnecting');
    }
  };
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  setConnection('reconnecting');
  retryTimer = setTimeout(async () => {
    const ok = await loadState();
    connect();
    if (ok) retryDelay = 1000;
    else retryDelay = Math.min(retryDelay * 2, 15000);
  }, retryDelay);
}

function handleEvent(event) {
  if (event.type === 'state') {
    state.app.state = event.state;
    state.app.handsFree = event.handsFree;
    state.partial = '';
    flashShortcut(event.action);
    renderHero();
    return;
  }
  if (event.type === 'level') {
    state.levelTarget = Math.min(1, (event.level || 0) * 6);
    state.levelAt = Date.now();
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
    if (state.events.length > 200) state.events.length = 200;
    flashShortcut('stop');
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
  analyticsTimer = setTimeout(loadState, 300);
}

// ── Connection state ─────────────────────────────────────────────────────────

function setConnection(status, detail = '') {
  state.connection = status;
  const pill = $('#statusPill');
  const text = $('#statusText');
  const banner = $('#banner');

  if (status === 'live') {
    pill.dataset.state = state.app.state || 'idle';
    text.textContent = labelFor(state.app.state) + (state.app.handsFree ? ' · locked' : '');
    banner.hidden = true;
    $('#bento').classList.remove('is-stale');
    return;
  }

  pill.dataset.state = status === 'offline' ? 'offline' : 'idle';
  text.textContent = status === 'offline' ? 'Not connected' : 'Reconnecting';
  $('#bento').classList.add('is-stale');

  banner.hidden = false;
  $('#bannerTitle').textContent = status === 'offline'
    ? 'This dashboard link is no longer valid'
    : 'Lost the connection to Voice Flow';
  $('#bannerBody').textContent = status === 'offline'
    ? (detail || 'Open “Open Dashboard” from the Voice Flow tray menu to get a fresh link.')
    : 'Retrying automatically — the page will catch up on its own.';
}

function labelFor(s) {
  return { idle: 'Idle', listening: 'Listening', processing: 'Processing' }[s] || 'Idle';
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderAll() {
  renderHero();
  renderShortcuts();
  renderStats();
  renderFeed();
  renderErrors();
  renderCharts();
}

function renderHero() {
  const appState = state.app.state || 'idle';
  $('#orb').dataset.state = appState;
  $('#statusPill').dataset.state = appState;
  if (state.connection === 'live') {
    $('#statusText').textContent = labelFor(appState) + (state.app.handsFree ? ' · locked' : '');
  }

  $('#modelPill').textContent = state.app.model || '—';

  const caption = $('#liveCaption');
  if (state.partial) {
    caption.innerHTML = `<span class="typing">${esc(state.partial)}</span>`;
  } else {
    caption.textContent = {
      idle: 'Waiting for you',
      listening: 'Listening — speak now',
      processing: 'Transcribing…',
    }[appState] || 'Waiting for you';
  }
}

function renderStats() {
  const t = state.analytics?.totals;
  const host = $('#stats');
  if (!t) { host.innerHTML = ''; return; }

  const cards = [
    { label: 'Words today', value: t.todayWords.toLocaleString(), sub: `${t.todaySessions} sessions` },
    { label: 'Total words', value: t.words.toLocaleString(), sub: `${t.sessions} dictations` },
    { label: 'Speaking time', value: `${t.minutes}m`, sub: `${t.wpm} words/min` },
    { label: 'Avg latency', value: t.avgLatencyMs ? fmtDuration(t.avgLatencyMs) : '—', sub: 'per dictation' },
    { label: 'Errors', value: String(t.errors), sub: `${t.errorRate}% of attempts`, tone: t.errors ? 'is-bad' : 'is-good' },
    { label: 'Models', value: String(state.analytics.models.length || 1), sub: state.analytics.models[0]?.name || '—' },
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

  if (!items.length) {
    feed.innerHTML = state.connection === 'live'
      ? `<div class="empty empty-centered">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
                stroke-linejoin="round" aria-hidden="true">
             <path d="M12 3.5a2.75 2.75 0 0 0-2.75 2.75v6a2.75 2.75 0 0 0 5.5 0v-6A2.75 2.75 0 0 0 12 3.5Z"/>
             <path d="M18 10.5v1a6 6 0 0 1-12 0v-1"/><path d="M12 17.5V20"/><path d="M9 20h6"/>
           </svg>
           <span>Nothing yet — press the shortcut above and start talking.</span>
         </div>`
      : `<div class="empty empty-centered"><span>Waiting for the app to come back…</span></div>`;
    $('#feedCount').textContent = '';
    return;
  }

  const cards = [];

  if (state.partial) {
    cards.push(`
      <div class="entry entry-live">
        <div class="entry-top"><span>Transcribing…</span></div>
        <div class="entry-text">${esc(state.partial)}</div>
      </div>`);
  }

  for (const e of items) {
    if (e.type === 'dictation') {
      const metrics = [];
      if (Number.isFinite(e.durationMs)) metrics.push(`<span class="tag">rec ${fmtDuration(e.durationMs)}</span>`);
      if (Number.isFinite(e.transcribeMs)) metrics.push(`<span class="tag">transcribe ${fmtDuration(e.transcribeMs)}</span>`);
      if (Number.isFinite(e.pasteMs)) metrics.push(`<span class="tag">paste ${fmtDuration(e.pasteMs)}</span>`);
      if (e.model) metrics.push(`<span class="tag tag-model">${esc(e.model)}</span>`);
      if (e.pasted === false) metrics.push(`<span class="tag">not pasted</span>`);
      cards.push(`
        <div class="entry">
          <div class="entry-top">
            <span>${fmtTime(e.ts)}</span><span>·</span><span>${fmtAgo(e.ts)}</span>
          </div>
          <div class="entry-text">${esc(e.text || e.cleaned)}</div>
          ${metrics.length ? `<div class="entry-metrics">${metrics.join('')}</div>` : ''}
        </div>`);
    } else if (e.type === 'info') {
      cards.push(`
        <div class="entry">
          <div class="entry-top"><span>${fmtTime(e.ts)}</span><span>·</span><span>note</span></div>
          <div class="entry-text" style="color:var(--text-2);font-size:13.5px">${esc(e.message)}</div>
        </div>`);
    }
  }

  feed.innerHTML = cards.join('');
  $('#feedCount').textContent = `${items.length} shown`;
}

function renderErrors() {
  const host = $('#errors');
  const errors = state.events.filter((e) => e.type === 'error').slice(0, 30);
  const notes = state.events.filter((e) => e.type === 'info' && e.kind !== 'cancel').slice(0, 8);

  if (!errors.length && !notes.length) {
    host.innerHTML = `<div class="empty empty-centered">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>
      </svg>
      <span>No errors</span></div>`;
    $('#errorCount').textContent = '';
    return;
  }

  const items = [
    ...errors.map((e) => `
      <div class="error-item">
        <div class="error-msg">${esc(e.message)}</div>
        <div class="error-meta"><span>${fmtTime(e.ts)}</span><span>${fmtAgo(e.ts)}</span>${e.kind ? `<span>${esc(e.kind)}</span>` : ''}</div>
      </div>`),
    ...notes.map((e) => `
      <div class="error-item is-note">
        <div class="error-msg">${esc(e.message)}</div>
        <div class="error-meta"><span>${fmtTime(e.ts)}</span><span>${fmtAgo(e.ts)}</span></div>
      </div>`),
  ];

  host.innerHTML = items.join('');
  // Count only what is actually an error — notes are listed separately.
  $('#errorCount').textContent = errors.length
    ? `${errors.length} error${errors.length === 1 ? '' : 's'}`
    : `${notes.length} note${notes.length === 1 ? '' : 's'}`;
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
  if (!days || !days.length) { host.innerHTML = '<span class="chart-empty">No data yet</span>'; return; }
  const max = Math.max(...days.map((d) => d.words), 1);
  const W = 340; const H = 168; const pad = 24;
  const bw = (W - pad * 2) / days.length;

  const bars = days.map((d, i) => {
    const h = (d.words / max) * (H - 52);
    const x = pad + i * bw + bw * 0.2;
    const w = bw * 0.6;
    const y = H - 26 - h;
    return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(h, 2).toFixed(1)}" rx="4"
              fill="#0071e3" opacity="${(0.35 + 0.65 * (d.words / max)).toFixed(2)}"></rect>
            ${d.words ? `<text class="value-label" x="${(x + w / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle">${d.words}</text>` : ''}
            <text class="axis-label" x="${(x + w / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  }).join('');

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Words per day">${bars}</svg>`;
}

function chartLatency(points) {
  const host = $('#chartLatency');
  if (!points || points.length < 2) {
    host.innerHTML = '<span class="chart-empty">Not enough data yet</span>';
    $('#latencyNote').textContent = '—';
    return;
  }
  const W = 620; const H = 168; const pad = 26;
  const values = points.map((p) => p.ms);
  const max = Math.max(...values, 1);
  const x = (i) => pad + (i * (W - pad * 2)) / (points.length - 1);
  const y = (v) => H - 30 - (v / max) * (H - 58);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.ms).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - 30} L${x(0).toFixed(1)},${H - 30} Z`;
  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.ms).toFixed(1)}" r="2.4" fill="#0071e3"></circle>`).join('');
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Transcription latency over time">
    <defs><linearGradient id="lat" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0071e3" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#0071e3" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#lat)"></path>
    <path d="${line}" fill="none" stroke="#0071e3" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
    ${dots}
    <text class="axis-label" x="${pad}" y="${H - 8}">${fmtTime(points[0].ts)}</text>
    <text class="axis-label" x="${W - pad}" y="${H - 8}" text-anchor="end">${fmtTime(points[points.length - 1].ts)}</text>
    <text class="axis-label" x="${pad}" y="14">${fmtDuration(max)} worst</text>
  </svg>`;
  $('#latencyNote').textContent = `avg ${fmtDuration(avg)}`;
}

function chartModels(models) {
  const host = $('#chartModels');
  if (!models || !models.length) { host.innerHTML = '<span class="chart-empty">No dictations yet</span>'; return; }
  const total = models.reduce((n, m) => n + m.count, 0);
  const R = 50; const C = 2 * Math.PI * R;
  const palette = ['#0071e3', '#5e5ce6', '#34c759', '#ff9f0a', '#ff3b30'];

  let offset = 0;
  const arcs = models.map((m, i) => {
    const len = (m.count / total) * C;
    const arc = `<circle cx="80" cy="80" r="${R}" fill="none" stroke="${palette[i % palette.length]}" stroke-width="14"
      stroke-dasharray="${len.toFixed(1)} ${(C - len).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}"
      transform="rotate(-90 80 80)"></circle>`;
    offset += len;
    return arc;
  }).join('');

  const legend = models.map((m, i) => `
    <div class="legend">
      <span class="swatch" style="background:${palette[i % palette.length]}"></span>
      <span class="name" title="${esc(m.name)}">${esc(m.name)}</span>
      <span class="value">${m.count} · ${Math.round((m.count / total) * 100)}%</span>
    </div>`).join('');

  host.innerHTML = `<div style="display:flex;align-items:center;gap:16px;width:100%">
    <svg viewBox="0 0 160 160" style="width:118px;flex:none" role="img" aria-label="Models used">${arcs}</svg>
    <div style="flex:1;min-width:0">${legend}</div>
  </div>`;
}

function chartHours(hours) {
  const host = $('#chartHours');
  if (!hours) { host.innerHTML = '<span class="chart-empty">No data yet</span>'; return; }
  const max = Math.max(...hours, 1);
  const W = 340; const H = 132;
  const bw = W / 24;
  const bars = hours.map((h, i) => {
    const bh = (h / max) * (H - 38);
    const x = i * bw + 2;
    const y = H - 20 - bh;
    const op = h === 0 ? 0.1 : 0.32 + 0.68 * (h / max);
    return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${Math.max(bh, 2).toFixed(1)}" rx="2.5"
              fill="#5e5ce6" opacity="${op.toFixed(2)}"></rect>`;
  }).join('');
  const labels = [0, 6, 12, 18].map((h) =>
    `<text class="axis-label" x="${(h * bw + bw / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${pad(h)}:00</text>`).join('');

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Dictations by hour of day">${bars}${labels}</svg>`;
}

// ── The orb follows the real microphone level ────────────────────────────────

/**
 * The level arrives as discrete measurements (~12/s). The orb eases towards
 * the latest one and only decays when the microphone has gone quiet.
 */
function animateLevel() {
  const now = Date.now();
  if (now - state.levelAt > 250) state.levelTarget *= 0.95;   // the mic went quiet
  state.level += (state.levelTarget - state.level) * 0.18;
  const scale = 1 + state.level * 0.55;
  $('#orbCore').style.setProperty('--level-scale', scale.toFixed(3));
  requestAnimationFrame(animateLevel);
}

// ── Chrome ───────────────────────────────────────────────────────────────────

$('#themeToggle').addEventListener('click', () => {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('vf-theme', next); } catch { /* private mode */ }
});

$('#bannerRetry').addEventListener('click', () => {
  clearTimeout(retryTimer);
  retryDelay = 1000;
  loadState().then(() => connect());
});

try {
  const saved = localStorage.getItem('vf-theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* private mode */ }

// Keep the relative timestamps fresh.
setInterval(() => {
  if (state.connection === 'live') { renderFeed(); renderErrors(); }
}, 5000);

loadState().then(() => connect());
animateLevel();
