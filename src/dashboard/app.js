/**
 * app.js — the Dictata dictation dashboard.
 *
 * Vanilla JS, no build step. Talks to the app's local server:
 *   GET /api/state    → the current snapshot (history, analytics, events)
 *   GET /api/events   → SSE stream of live activity
 *
 * The keyboard is the primary interface, so the shortcuts on this page are
 * read from the app's own settings — the page can never disagree with the app.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const params = new URLSearchParams(location.search);
const token = params.get('token') || '';

const state = {
  app: { state: 'idle', model: null, shortcuts: null, handsFree: false },
  analytics: null,
  events: [],
  history: [],
  partial: '',
  connection: 'connecting',   // connecting | live | reconnecting | offline
  level: 0,
  levelTarget: 0,
  levelAt: 0,
  tab: 'live',
};

// ── Formatting ───────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

/** 6:58pm — the time format the Wispr Flow history uses. */
function fmtClock(ts) {
  const d = new Date(ts);
  const h = d.getHours();
  const suffix = h < 12 ? 'am' : 'pm';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${pad(d.getMinutes())}${suffix}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDay(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 950) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function fmtAgo(ts) {
  const diff = Date.now() - ts;
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
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

function num(n) {
  return Number(n || 0).toLocaleString();
}

/** Turn a technical failure into the phrase the history should show. */
function problemLabel(message) {
  const m = String(message || 'Something went wrong');
  if (/no audio from microphone/i.test(m)) return 'Audio is silent';
  if (/recording too short/i.test(m)) return 'Recording was too short';
  if (/no speech detected/i.test(m)) return 'No speech detected';
  if (/microphone/i.test(m)) return 'Microphone unavailable';
  if (/not pasted|clipboard/i.test(m)) return 'Could not paste';
  return m;
}

const ICONS = {
  words: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h9"/></svg>',
  speed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4a8 8 0 1 0 8 8"/><path d="M12 12l5-3"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s5 4.2 5 9a5 5 0 0 1-10 0c0-1.7.7-3 1.5-4 .2 1.3 1 2 1.8 2 1 0 1.7-.9 1.7-2.2 0-1.7-1-3.2-1-4.8Z"/></svg>',
};

const icon = (name) => `<span class="stat-icon" aria-hidden="true">${ICONS[name] || ''}</span>`;

// ── Shortcuts ────────────────────────────────────────────────────────────────

const SHORTCUT_INFO = [
  { key: 'pushToTalk', label: 'Dictate', hint: 'press again to stop & paste' },
  { key: 'handsFree', label: 'Hands-free', hint: 'lock the mic open' },
  { key: 'cancel', label: 'Cancel', hint: 'abort the recording' },
  { key: 'pasteLast', label: 'Paste again', hint: 're-paste the last text' },
];

function keycaps(chord) {
  if (!chord || !chord.length) return '';
  return chord
    .map((k) => `<kbd class="key" data-key="${esc(k)}">${esc(k)}</kbd>`)
    .join('<span class="key-plus" aria-hidden="true">+</span>');
}

/** Flash the keycaps of a shortcut, so the keys that did something light up. */
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
  const shortcuts = state.app.shortcuts || {};

  $('#shortcutList').innerHTML = SHORTCUT_INFO.map(({ key, label, hint }) => {
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
    if (res.status === 401 || res.status === 403) { setConnection('offline'); return false; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.app = { ...state.app, ...(data.app || {}) };
    state.analytics = data.analytics || null;
    state.events = data.events || [];
    state.history = data.history || [];
    renderAll();
    return true;
  } catch {
    setConnection('reconnecting');
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
    if (es !== source) return;               // a superseded connection
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
    if (es !== source) return;               // a stale connection must not
                                             // disturb the live one
    if (es.readyState === EventSource.CLOSED) {
      scheduleRetry();                       // refused (401) or unreachable
    } else {
      setConnection('reconnecting');         // it is retrying on its own
    }
  };
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  // A dead link keeps its full-page explanation: downgrading it to the
  // quieter "reconnecting" banner would show both at once.
  if (state.connection !== 'offline') setConnection('reconnecting');
  retryTimer = setTimeout(async () => {
    const ok = await loadState();
    connect();
    retryDelay = ok ? 1000 : Math.min(retryDelay * 2, 15000);
  }, retryDelay);
}

function handleEvent(event) {
  if (event.type === 'state') {
    state.app.state = event.state;
    state.app.handsFree = !!event.handsFree;
    state.partial = '';
    flashShortcut(event.action);
    renderLive();
    return;
  }
  if (event.type === 'level') {
    state.levelTarget = Math.min(1, (event.level || 0) * 6);
    state.levelAt = Date.now();
    return;
  }
  if (event.type === 'partial') {
    state.partial = event.text;
    renderLive();
    return;
  }
  if (event.type === 'dictation') {
    state.partial = '';
    pushEvent(event);
    flashShortcut('stop');
    renderLive();
    renderFeed();
    renderHistory();
    renderStats();
    refreshAnalytics();
    return;
  }
  if (event.type === 'error' || event.type === 'info') {
    pushEvent(event);
    renderFeed();
    renderErrors();
    renderHistory();
    renderStats();
    refreshAnalytics();
  }
}

function pushEvent(event) {
  state.events = [event, ...state.events.filter((e) => e.id !== event.id)].slice(0, 300);
}

/** Pull fresh analytics shortly after something happens (cheap, local). */
let analyticsTimer = null;
function refreshAnalytics() {
  clearTimeout(analyticsTimer);
  analyticsTimer = setTimeout(loadState, 400);
}

// ── Connection state ─────────────────────────────────────────────────────────

function setConnection(status, detail = '') {
  state.connection = status;

  const pill = $('#statusPill');
  const text = $('#statusText');
  const banner = $('#banner');
  const takeover = $('#takeover');
  const layout = $('#layout');
  const footer = $('.footer');

  if (status === 'live') {
    pill.dataset.state = state.app.state || 'idle';
    text.textContent = labelFor(state.app.state) + (state.app.handsFree ? ' · locked' : '');
    banner.hidden = true;
    takeover.hidden = true;
    layout.hidden = false;
    footer.hidden = false;
    return;
  }

  if (status === 'offline') {
    // A dead link gets the whole screen — never a half-empty dashboard.
    pill.dataset.state = 'offline';
    text.textContent = 'Not connected';
    banner.hidden = true;
    takeover.hidden = false;
    layout.hidden = true;
    footer.hidden = true;
    if (detail) $('#takeoverBody').textContent = detail;
    return;
  }

  // Reconnecting: keep the data on screen, say so quietly.
  pill.dataset.state = 'idle';
  text.textContent = 'Reconnecting';
  banner.hidden = false;
}

function labelFor(s) {
  return { idle: 'Idle', listening: 'Listening', processing: 'Processing' }[s] || 'Idle';
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function setTab(name, { focus = false } = {}) {
  if (!['live', 'history', 'insights'].includes(name)) name = 'live';
  state.tab = name;

  for (const panel of $$('.panel')) panel.hidden = panel.dataset.panel !== name;
  for (const tab of $$('.tab')) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
    if (active && focus) tab.focus();
  }

  try { localStorage.setItem('vf-tab', name); } catch { /* private mode */ }
  history.replaceState(null, '', `#${name}`);

  if (name === 'insights') renderCharts();
  if (name === 'history') renderHistory();
}

for (const tab of $$('.tab')) {
  tab.addEventListener('click', () => setTab(tab.dataset.tab));
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderAll() {
  renderLive();
  renderShortcuts();
  renderStats();
  renderSetup();
  renderFeed();
  renderHistory();
  renderErrors();
  renderCharts();
}

function renderLive() {
  const appState = state.app.state || 'idle';
  $('#orb').dataset.state = appState;
  $('#statusPill').dataset.state = state.connection === 'live' ? appState : $('#statusPill').dataset.state;

  if (state.connection === 'live') {
    $('#statusText').textContent = labelFor(appState) + (state.app.handsFree ? ' · locked' : '');
  }
  $('#modelPill').textContent = state.app.model || '—';

  $('#liveCaption').textContent = state.partial
    ? 'Hearing you…'
    : ({
      idle: 'Waiting for you',
      listening: 'Listening — speak now',
      processing: 'Transcribing…',
    }[appState] || 'Waiting for you');

  const liveText = $('#liveText');
  liveText.hidden = !state.partial;
  if (state.partial) liveText.textContent = state.partial;
}

/** Every dictation and every failed attempt, newest first. */
function timeline() {
  const byId = new Map();
  const add = (e) => { if (e && e.id && !byId.has(e.id)) byId.set(e.id, e); };

  for (const e of state.events) add(e);
  for (const h of state.history) add({ ...h, type: 'dictation', text: h.cleaned || h.raw, ts: h.at });

  return [...byId.values()]
    .filter((e) => e.type === 'dictation' || (e.type === 'error' && e.kind !== 'cancel'))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

function dailyEntries(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = new Date(e.ts || 0).toDateString();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return groups;
}

function renderHistory() {
  const host = $('#history');
  const entries = timeline();

  if (!entries.length) {
    host.innerHTML = state.connection === 'live'
      ? `<div class="card empty empty-centered">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
             <path d="M12 3.5a2.75 2.75 0 0 0-2.75 2.75v6a2.75 2.75 0 0 0 5.5 0v-6A2.75 2.75 0 0 0 12 3.5Z"/>
             <path d="M18 10.5v1a6 6 0 0 1-12 0v-1"/><path d="M12 17.5V20"/><path d="M9 20h6"/>
           </svg>
           <span>No dictations yet — press your shortcut and start talking.</span>
         </div>`
      : `<div class="card empty empty-centered"><span>Waiting for the app to come back…</span></div>`;
    $('#historySub').textContent = '';
    return;
  }

  const groups = dailyEntries(entries);
  const blocks = [];

  for (const [, items] of groups) {
    const rows = items.map((e) => {
      if (e.type === 'error') {
        return `<div class="rec is-problem">
          <div class="rec-time">${fmtClock(e.ts)}</div>
          <div class="rec-problem" title="${esc(e.message)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"/><path d="M12 8.4v4.4"/><path d="M12 16.2h.01"/>
            </svg>
            <span>${esc(problemLabel(e.message))}</span>
          </div>
        </div>`;
      }

      const words = Number.isFinite(e.words) ? e.words : wordCount(e.text);
      const chips = [];
      if (words) chips.push(`<span class="chip">${num(words)} words</span>`);
      if (Number.isFinite(e.durationMs)) chips.push(`<span class="chip">rec ${fmtDuration(e.durationMs)}</span>`);
      if (Number.isFinite(e.transcribeMs)) chips.push(`<span class="chip">transcribe ${fmtDuration(e.transcribeMs)}</span>`);
      if (e.pasted === false) chips.push(`<span class="chip">not pasted</span>`);
      if (e.model) chips.push(`<span class="chip chip-model">${esc(e.model)}</span>`);

      return `<div class="rec">
        <div class="rec-time">${fmtClock(e.ts)}</div>
        <div>
          <p class="rec-text">${esc(e.text || e.cleaned || '')}</p>
          ${chips.length ? `<div class="rec-meta">${chips.join('')}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    blocks.push(`<section>
      <h3 class="day-label">${esc(fmtDay(items[0].ts))}</h3>
      <div class="day-card">${rows}</div>
    </section>`);
  }

  host.innerHTML = blocks.join('');

  const dictations = entries.filter((e) => e.type === 'dictation');
  const words = dictations.reduce((n, e) => n + (Number.isFinite(e.words) ? e.words : wordCount(e.text)), 0);
  const failed = entries.length - dictations.length;
  $('#historySub').textContent = [
    `${num(dictations.length)} dictation${dictations.length === 1 ? '' : 's'}`,
    `${num(words)} words`,
    failed ? `${failed} failed attempt${failed === 1 ? '' : 's'}` : null,
    `last one ${fmtAgo(entries[0].ts)}`,
  ].filter(Boolean).join(' · ');
}

function renderFeed() {
  const feed = $('#feed');
  const items = state.events
    .filter((e) => ['dictation', 'info'].includes(e.type))
    .slice(0, 25);

  if (!items.length && !state.partial) {
    feed.innerHTML = state.connection === 'live'
      ? `<div class="empty empty-centered">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
             <path d="M12 3.5a2.75 2.75 0 0 0-2.75 2.75v6a2.75 2.75 0 0 0 5.5 0v-6A2.75 2.75 0 0 0 12 3.5Z"/>
             <path d="M18 10.5v1a6 6 0 0 1-12 0v-1"/><path d="M12 17.5V20"/><path d="M9 20h6"/>
           </svg>
           <span>Nothing yet — press your shortcut and start talking.</span>
         </div>`
      : `<div class="empty empty-centered"><span>Waiting for the app to come back…</span></div>`;
    $('#feedCount').textContent = '';
    return;
  }

  const rows = [];

  if (state.partial) {
    rows.push(`<div class="entry is-live">
      <div class="entry-top"><span>Transcribing…</span></div>
      <div class="entry-text">${esc(state.partial)}</div>
    </div>`);
  }

  for (const e of items) {
    if (e.type === 'dictation') {
      const chips = [];
      if (Number.isFinite(e.durationMs)) chips.push(`<span class="chip">rec ${fmtDuration(e.durationMs)}</span>`);
      if (Number.isFinite(e.transcribeMs)) chips.push(`<span class="chip">transcribe ${fmtDuration(e.transcribeMs)}</span>`);
      if (Number.isFinite(e.pasteMs)) chips.push(`<span class="chip">paste ${fmtDuration(e.pasteMs)}</span>`);
      if (e.pasted === false) chips.push(`<span class="chip">not pasted</span>`);
      if (e.model) chips.push(`<span class="chip chip-model">${esc(e.model)}</span>`);
      rows.push(`<div class="entry">
        <div class="entry-top"><span>${fmtClock(e.ts)}</span><span>·</span><span>${fmtAgo(e.ts)}</span></div>
        <div class="entry-text">${esc(e.text || e.cleaned)}</div>
        ${chips.length ? `<div class="entry-metrics">${chips.join('')}</div>` : ''}
      </div>`);
    } else if (e.type === 'info') {
      rows.push(`<div class="entry">
        <div class="entry-top"><span>${fmtClock(e.ts)}</span><span>·</span><span>note</span></div>
        <div class="entry-text" style="color:var(--ink-soft);font-size:13.5px">${esc(e.message)}</div>
      </div>`);
    }
  }

  feed.innerHTML = rows.join('');
  $('#feedCount').textContent = `${items.length} shown`;
}

/** The rail: the big serif numbers Wispr Flow puts beside your history. */
function renderStats() {
  const t = state.analytics?.totals;
  if (!t) { $('#stats').innerHTML = ''; return; }

  const streak = dayStreak(state.history);
  const errorTone = t.errors ? 'is-bad' : 'is-good';

  $('#stats').innerHTML = `
    <div class="stat-row">${icon('words')}<span class="stat-num">${num(t.words)}</span><span class="stat-label">total words</span></div>
    <div class="stat-row">${icon('speed')}<span class="stat-num">${num(t.wpm)}</span><span class="stat-label">words per minute</span></div>
    <div class="stat-row">${icon('flame')}<span class="stat-num">${num(streak)}</span><span class="stat-label">${streak === 1 ? 'day' : 'day'} streak</span></div>
    <div class="stat-divider"></div>
    <div class="fact"><span class="fact-label">Words today</span><span class="fact-value">${num(t.todayWords)}</span></div>
    <div class="fact"><span class="fact-label">Dictations today</span><span class="fact-value">${num(t.todaySessions)}</span></div>
    <div class="fact"><span class="fact-label">Speaking time</span><span class="fact-value">${t.minutes} min</span></div>
    <div class="fact"><span class="fact-label">Average latency</span><span class="fact-value">${t.avgLatencyMs ? fmtDuration(t.avgLatencyMs) : '—'}</span></div>
    <div class="fact"><span class="fact-label">Errors</span><span class="fact-value ${errorTone}">${num(t.errors)}</span></div>`;
}

/** A voice-profile style card: how reliably the text reaches the cursor. */
function renderSetup() {
  const t = state.analytics?.totals;
  if (!t) { $('#setup').innerHTML = ''; return; }

  const dictations = t.sessions || 0;
  const successRate = dictations + t.errors > 0
    ? Math.round((dictations / (dictations + t.errors)) * 100)
    : 100;

  const pasted = state.history.filter((h) => h.pasted === true).length;
  const judged = state.history.filter((h) => typeof h.pasted === 'boolean').length;
  const pastedPct = judged ? Math.round((pasted / judged) * 100) : null;

  $('#setup').innerHTML = `
    <h3 class="profile-title">Your voice profile</h3>
    <p class="profile-caption">How reliably your speech becomes text where the cursor is.</p>
    <div class="bar-track"><div class="bar-fill" style="width:${successRate}%"></div></div>
    <div class="profile-foot">
      <span>${successRate}% success</span>
      <span>${t.errorRate}% errors</span>
    </div>
    <div class="stat-divider"></div>
    <div class="fact"><span class="fact-label">Model</span><span class="fact-value">${esc(state.app.model || '—')}</span></div>
    <div class="fact"><span class="fact-label">Dictations</span><span class="fact-value">${num(dictations)}</span></div>
    <div class="fact"><span class="fact-label">Longest recording</span><span class="fact-value">${fmtDuration(longestRecording(state.history))}</span></div>
    <div class="fact"><span class="fact-label">Pasted automatically</span><span class="fact-value">${pastedPct === null ? '—' : `${pastedPct}%`}</span></div>`;
}

function longestRecording(history) {
  return history.reduce((max, h) => (Number.isFinite(h.durationMs) && h.durationMs > max ? h.durationMs : max), 0);
}

/** Consecutive days that ended with at least one dictation. */
function dayStreak(history) {
  const days = new Set(history.filter((h) => h.at).map((h) => new Date(h.at).toDateString()));
  if (!days.size) return 0;
  const cursor = new Date();
  if (!days.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(cursor.toDateString())) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function renderErrors() {
  const host = $('#errors');
  const errors = state.events.filter((e) => e.type === 'error').slice(0, 30);
  const notes = state.events.filter((e) => e.type === 'info' && e.kind !== 'cancel').slice(0, 6);

  if (!errors.length && !notes.length) {
    host.innerHTML = `<div class="empty empty-centered">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>
      </svg>
      <span>Nothing has failed. Every attempt went through.</span></div>`;
    $('#errorCount').textContent = '';
    return;
  }

  host.innerHTML = [
    ...errors.map((e) => `<div class="error-item">
      <div class="error-msg">${esc(e.message)}</div>
      <div class="error-meta"><span>${fmtClock(e.ts)}</span><span>${fmtAgo(e.ts)}</span>${e.kind ? `<span>${esc(e.kind)}</span>` : ''}</div>
    </div>`),
    ...notes.map((e) => `<div class="error-item is-note">
      <div class="error-msg">${esc(e.message)}</div>
      <div class="error-meta"><span>${fmtClock(e.ts)}</span><span>${fmtAgo(e.ts)}</span></div>
    </div>`),
  ].join('');

  // Count only what is genuinely an error — notes are listed separately.
  $('#errorCount').textContent = errors.length
    ? `${errors.length} error${errors.length === 1 ? '' : 's'}`
    : `${notes.length} note${notes.length === 1 ? '' : 's'}`;
}

// ── Charts (hand-rolled SVG) ─────────────────────────────────────────────────

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
  const W = 360, H = 172, padX = 20;
  const bw = (W - padX * 2) / days.length;

  const bars = days.map((d, i) => {
    const h = (d.words / max) * (H - 56);
    const x = padX + i * bw + bw * 0.22;
    const w = bw * 0.56;
    const y = H - 28 - h;
    return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(h, 2).toFixed(1)}" rx="5"
              style="fill:var(--chart-1)" opacity="${(0.4 + 0.6 * (d.words / max)).toFixed(2)}"></rect>
            ${d.words ? `<text class="value-label" x="${(x + w / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle">${d.words}</text>` : ''}
            <text class="axis-label" x="${(x + w / 2).toFixed(1)}" y="${H - 9}" text-anchor="middle">${esc(d.label)}</text>`;
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

  const W = 560, H = 172, padX = 26;
  const values = points.map((p) => p.ms);
  const max = Math.max(...values, 1);
  const x = (i) => padX + (i * (W - padX * 2)) / (points.length - 1);
  const y = (v) => H - 32 - (v / max) * (H - 62);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.ms).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - 32} L${x(0).toFixed(1)},${H - 32} Z`;
  const dots = points.map((p, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(p.ms).toFixed(1)}" r="2.4" style="fill:var(--chart-1)"></circle>`).join('');
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Transcription latency over time">
    <defs><linearGradient id="latFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" style="stop-color:var(--chart-1);stop-opacity:0.3"/>
      <stop offset="100%" style="stop-color:var(--chart-1);stop-opacity:0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#latFill)"></path>
    <path d="${line}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" style="stroke:var(--chart-1)"></path>
    ${dots}
    <text class="axis-label" x="${padX}" y="${H - 9}">${fmtClock(points[0].ts)}</text>
    <text class="axis-label" x="${W - padX}" y="${H - 9}" text-anchor="end">${fmtClock(points[points.length - 1].ts)}</text>
    <text class="axis-label" x="${padX}" y="14">worst ${fmtDuration(max)}</text>
  </svg>`;

  $('#latencyNote').textContent = `avg ${fmtDuration(avg)}`;
}

function chartModels(models) {
  const host = $('#chartModels');
  if (!models || !models.length) { host.innerHTML = '<span class="chart-empty">No dictations yet</span>'; return; }

  const total = models.reduce((n, m) => n + m.count, 0);
  const R = 48, C = 2 * Math.PI * R;
  const palette = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'];

  let offset = 0;
  const arcs = models.map((m, i) => {
    const len = (m.count / total) * C;
    const arc = `<circle cx="78" cy="78" r="${R}" fill="none" stroke-width="14"
      stroke-dasharray="${len.toFixed(1)} ${(C - len).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}"
      transform="rotate(-90 78 78)" style="stroke:var(${palette[i % palette.length]})"></circle>`;
    offset += len;
    return arc;
  }).join('');

  const legend = models.map((m, i) => `<div class="legend">
    <span class="swatch" style="background:var(${palette[i % palette.length]})"></span>
    <span class="name" title="${esc(m.name)}">${esc(m.name)}</span>
    <span class="value">${m.count} · ${Math.round((m.count / total) * 100)}%</span>
  </div>`).join('');

  host.innerHTML = `<div style="display:flex;align-items:center;gap:16px;width:100%">
    <svg viewBox="0 0 156 156" style="width:112px;flex:none" role="img" aria-label="Models used">${arcs}</svg>
    <div style="flex:1;min-width:0">${legend}</div>
  </div>`;
}

function chartHours(hours) {
  const host = $('#chartHours');
  if (!hours) { host.innerHTML = '<span class="chart-empty">No data yet</span>'; return; }

  const max = Math.max(...hours, 1);
  const W = 360, H = 138, bw = W / 24;
  const bars = hours.map((h, i) => {
    const bh = (h / max) * (H - 40);
    const x = i * bw + 2.5;
    const y = H - 22 - bh;
    const op = h === 0 ? 0.12 : 0.35 + 0.65 * (h / max);
    return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 5).toFixed(1)}" height="${Math.max(bh, 2).toFixed(1)}" rx="3"
              style="fill:var(--chart-2)" opacity="${op.toFixed(2)}"></rect>`;
  }).join('');
  const labels = [0, 6, 12, 18].map((h) =>
    `<text class="axis-label" x="${(h * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${pad(h)}:00</text>`).join('');

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Dictations by hour of day">${bars}${labels}</svg>`;
}

// ── The orb follows the real microphone level ────────────────────────────────

/**
 * Levels arrive as discrete measurements (~12/s). The orb eases towards the
 * newest one and only decays once the microphone has gone quiet.
 */
function animateLevel() {
  const now = Date.now();
  if (now - state.levelAt > 250) state.levelTarget *= 0.95;
  state.level += (state.levelTarget - state.level) * 0.18;
  $('#orbCore').style.setProperty('--level-scale', (1 + state.level * 0.55).toFixed(3));
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

$('#takeoverRetry').addEventListener('click', () => {
  clearTimeout(retryTimer);
  retryDelay = 1000;
  loadState().then((ok) => { if (ok) connect(); });
});

try {
  const savedTheme = localStorage.getItem('vf-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
} catch { /* private mode */ }

// Keep the relative timestamps honest without re-rendering everything.
setInterval(() => {
  if (state.connection !== 'live') return;
  if (state.tab === 'history') renderHistory();
  else if (state.tab === 'live') renderFeed();
}, 5000);

const initialTab = location.hash.slice(1) || (() => {
  try { return localStorage.getItem('vf-tab') || 'live'; } catch { return 'live'; }
})();
setTab(initialTab);

loadState().then(() => connect());
animateLevel();
