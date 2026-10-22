/**
 * analytics.js — pure aggregation of the activity data.
 *
 * No Electron, no I/O: the dashboard server and the tests both use this,
 * so the numbers on the page and the numbers in the tests can never drift
 * apart.
 */

const DAY_MS = 86400000;

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isoDate(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Collapse similar messages so the error breakdown is readable. */
function normalizeError(message) {
  const m = String(message || 'Unknown error');
  const gem = /^Gemini (\d{3})/.exec(m);
  if (gem) return `Gemini ${gem[1]}`;
  if (/timed out/i.test(m)) return 'Request timed out';
  if (/no speech/i.test(m)) return 'No speech detected';
  if (/microphone|mic /i.test(m)) return 'Microphone unavailable';
  if (/network|ENOTFOUND|ECONN/i.test(m)) return 'Network error';
  if (/record.*short|no audio/i.test(m)) return 'No audio captured';
  return m.split(':')[0].slice(0, 48);
}

function average(list) {
  if (!list.length) return null;
  return Math.round(list.reduce((a, b) => a + b, 0) / list.length);
}

/**
 * The single word rule: the stored count when present, else a recount.
 *
 * `computeStats` (the stored record) and `summarize` (the page) must use this
 * same reduction or `lifetimeWords` can disagree with the page total on any
 * row whose stored `words` is stale (D-06 / WR-04).
 *
 * @param {object} h  a history row
 * @returns {number}
 */
function wordsOf(h) {
  return Number.isFinite(h.words) ? h.words : wordCount(h.cleaned || h.raw);
}

/**
 * The totals that belong in the stored record.
 *
 * This is the single source of truth for `store.stats`: deleting or expiring a
 * row recomputes from the survivors instead of subtracting, so the counter can
 * never drift away from the history it is supposed to describe. It uses the
 * same word reduction as `summarize()` so the stored record and the page agree.
 *
 * @param {object[]} [history]  newest first
 * @returns {{words: number, sessions: number, msSpoken: number}}
 */
function computeStats(history = []) {
  const entries = history.filter(Boolean);
  const words = entries.reduce((n, h) => n + wordsOf(h), 0);
  const msSpoken = entries.reduce((n, h) => n + (h.durationMs || 0), 0);
  return { words, sessions: entries.length, msSpoken };
}

/**
 * The text the paste-last hotkey may replay. Only a row that still exists in
 * the history can supply it, so a deleted transcript is never re-pasted.
 *
 * @param {object[]} [history]  newest first
 * @returns {{cleaned: string, raw: string}}
 */
function lastTarget(history = []) {
  const newest = history.filter(Boolean)[0];
  if (!newest) return { cleaned: '', raw: '' };
  return { cleaned: newest.cleaned || '', raw: newest.raw || '' };
}

/**
 * Build everything the page needs.
 *
 * @param {object} input
 * @param {object[]} [input.history]  newest first
 * @param {object[]} [input.events]   any order
 * @param {object}   [input.stats]
 */
function summarize({ history = [], events = [], stats = {}, fallbackModel = null } = {}) {
  const now = Date.now();
  const entries = history.filter(Boolean);
  const modelOf = (h) => h.model || fallbackModel || 'unknown';

  const words = entries.reduce((n, h) => n + wordsOf(h), 0);
  const msSpoken = entries.reduce((n, h) => n + (h.durationMs || 0), 0);
  const latencies = entries
    .map((h) => h.transcribeMs)
    .filter((n) => Number.isFinite(n) && n > 0);
  const errors = events.filter((e) => e.type === 'error');

  const todayStart = startOfDay(now);
  const todayEntries = entries.filter((h) => (h.at || 0) >= todayStart);

  // ── Words per day, last 7 days (oldest first) ──────────────────────────
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const start = startOfDay(now - i * DAY_MS);
    const end = start + DAY_MS;
    const dayEntries = entries.filter((h) => (h.at || 0) >= start && (h.at || 0) < end);
    days.push({
      date: isoDate(start),
      label: new Date(start).toLocaleDateString(undefined, { weekday: 'short' }),
      words: dayEntries.reduce((n, h) => n + wordsOf(h), 0),
      sessions: dayEntries.length,
    });
  }

  // ── Latency of the last 40 dictations (oldest first) ────────────────────
  const latency = entries.slice(0, 40).reverse()
    .filter((h) => Number.isFinite(h.transcribeMs))
    .map((h) => ({ ts: h.at || 0, ms: h.transcribeMs }));

  // ── Model distribution ──────────────────────────────────────────────────
  const modelCounts = new Map();
  for (const h of entries) {
    const name = modelOf(h);
    modelCounts.set(name, (modelCounts.get(name) || 0) + 1);
  }
  const models = [...modelCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // ── When the user dictates (24 hour buckets) ────────────────────────────
  const hours = new Array(24).fill(0);
  for (const h of entries) {
    if (!h.at) continue;
    hours[new Date(h.at).getHours()]++;
  }

  // ── Error breakdown ─────────────────────────────────────────────────────
  const groups = new Map();
  for (const e of errors) {
    const key = normalizeError(e.message);
    const g = groups.get(key) || { message: key, count: 0, lastTs: 0 };
    g.count++;
    g.lastTs = Math.max(g.lastTs, e.ts || 0);
    groups.set(key, g);
  }
  const errorGroups = [...groups.values()].sort((a, b) => b.count - a.count);

  const attempts = entries.length + errors.length;

  return {
    totals: {
      words,
      sessions: entries.length,
      minutes: Math.round((msSpoken / 60000) * 10) / 10,
      wpm: msSpoken > 0 ? Math.round(words / (msSpoken / 60000)) : 0,
      avgLatencyMs: average(latencies),
      errors: errors.length,
      errorRate: attempts > 0 ? Math.round((errors.length / attempts) * 100) : 0,
      todayWords: todayEntries.reduce((n, h) => n + wordsOf(h), 0),
      todaySessions: todayEntries.length,
      lifetimeWords: stats.words || 0,
    },
    days,
    latency,
    models,
    hours,
    errorGroups,
  };
}

module.exports = {
  summarize,
  computeStats,
  lastTarget,
  wordCount,
  normalizeError,
  startOfDay,
  isoDate,
};
