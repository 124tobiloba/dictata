/**
 * dashboard.js — the local web dashboard.
 *
 * A tiny, dependency-free HTTP server (node:http) that serves the dashboard
 * page and streams the app's activity to it.
 *
 *   GET /                     the page
 *   GET /api/state            snapshot: app state, analytics, history, events
 *   GET /api/history          the full history
 *   DELETE /api/history/:id   delete one dictation or failed attempt
 *   DELETE /api/history       delete every dictation and failed attempt
 *   POST /api/settings/open   open the Settings window (the only mutation-free
 *                             POST: retention is configured there, not here)
 *   GET /api/events           SSE stream of live events
 *
 * It binds to 127.0.0.1 only and requires a token on every API call, so
 * nothing on the network (or a random web page in the browser) can read
 * your transcripts.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { summarize } = require('./analytics');

const ROOT = path.join(__dirname, '../dashboard');
const DEFAULT_PORT = 7788;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const HISTORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-z]+-[0-9a-z]+$/i;

/**
 * A traversal gate for a delete target, never a kind gate.
 *
 * The dashboard renders two id shapes: a history UUID and the event bus id
 * (`${Date.now().toString(36)}-${counter}`, e.g. `mhqk3z1a-0`). Anything
 * carrying a separator, an escape, a quote or a dot is rejected before it can
 * reach a filesystem-adjacent code path. Whether the id names a real row is
 * decided by the purge itself: an unknown id deletes nothing and becomes 404.
 *
 * @param {string} id
 * @returns {boolean}
 */
function validRowId(id) {
  if (typeof id !== 'string' || !id || id.length > 64) return false;
  if (/[/%\\\s'"]/.test(id)) return false;
  if (id.includes('.')) return false;
  return HISTORY_ID.test(id) || EVENT_ID.test(id);
}

/**
 * One ordered stream out of three sources:
 *   • the stored history (older dictations)
 *   • the persisted events (errors and notes)
 *   • the live bus (what is happening right now)
 * Newest first, de-duplicated by id.
 */
function collectEvents(history = [], persisted = [], live = []) {
  const map = new Map();

  for (const h of history) {
    if (!h) continue;
    map.set(h.id, {
      id: h.id,
      ts: h.at || 0,
      type: 'dictation',
      text: h.cleaned || h.raw || '',
      durationMs: h.durationMs,
      transcribeMs: h.transcribeMs,
      pasteMs: h.pasteMs,
      model: h.model,
      pasted: h.pasted,
    });
  }
  for (const e of [...persisted, ...live]) {
    if (e && e.id) map.set(e.id, e);
  }

  return [...map.values()]
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 300);
}

class DashboardServer {
  /**
   * @param {object} opts
   * @param {object} opts.store       the Store instance
   * @param {object} opts.bus         the EventBus
   * @param {number} [opts.port]
   * @param {string} [opts.token]
   * @param {Function} [opts.onPurge]   (id) → removed count
   * @param {Function} [opts.onClearAll] () → removed count
   * @param {Function} [opts.getPrivacyFacts] () → { retentionDays, storeDir, auditCount }
   * @param {Function} [opts.onOpenSettings] () → open the Settings window
   */
  constructor(opts = {}) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.port = opts.port ?? DEFAULT_PORT;
    // A stable token keeps bookmarked dashboard links working across
    // restarts. Fall back to a random one if none was given.
    this.token = opts.token || crypto.randomBytes(16).toString('hex');
    // Deletion lives in the main process; the server only injects the call.
    this.onPurge = opts.onPurge || (() => 0);
    this.onClearAll = opts.onClearAll || (() => 0);
    // D-02: the dashboard states the policy, it never edits it. The facts come
    // from the main process so there is one source of truth for both surfaces.
    this.getPrivacyFacts = opts.getPrivacyFacts || (() => null);
    this.onOpenSettings = opts.onOpenSettings || (() => {});
    this.server = null;
    this.clients = new Set();
    this._onEvent = (event) => this._broadcast(event);
  }

  get running() {
    return !!this.server;
  }

  /** The URL to open in a browser (contains the access token). */
  get url() {
    if (!this.server) return null;
    const { port } = this.server.address();
    return `http://${HOST}:${port}/?token=${this.token}`;
  }

  get baseUrl() {
    if (!this.server) return null;
    const { port } = this.server.address();
    return `http://${HOST}:${port}`;
  }

  /**
   * Start the server. Falls back to the next free port when the preferred
   * one is taken.
   */
  async start() {
    if (this.server) return this.url;

    const preferred = this.port;
    const candidates = preferred
      ? [preferred, preferred + 1, preferred + 2, preferred + 3]
      : [0];                       // 0 → let the OS pick a free port
    let lastError = null;

    for (const port of candidates) {
      try {
        await this._listen(port);
        this.port = this.server.address().port;
        this.bus.on('event', this._onEvent);
        console.log(`[dashboard] serving ${this.url}`);
        return this.url;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('could not start the dashboard server');
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      server.on('error', reject);
      server.listen(port, HOST, () => {
        server.removeListener('error', reject);
        server.on('error', (err) => console.error('[dashboard]', err.message));
        this.server = server;
        resolve();
      });
    });
  }

  stop() {
    if (!this.server) return;
    this.bus.off('event', this._onEvent);
    for (const res of this.clients) {
      try { res.end(); } catch { /* already closed */ }
    }
    this.clients.clear();
    try { this.server.close(); } catch { /* ignore */ }
    this.server = null;
  }

  // ── Request handling ──────────────────────────────────────────────────────

  async _handle(req, res) {
    const url = new URL(req.url, `http://${HOST}:${this.port}`);
    const pathname = url.pathname;

    // Block DNS rebinding: only accept requests addressed to us.
    if (!this._hostAllowed(req.headers.host)) {
      return this._json(res, 403, { error: 'Host not allowed' });
    }

    if (pathname === '/api/events') {
      if (!this._authorised(url)) return this._json(res, 401, { error: 'Bad token' });
      return this._events(req, res);
    }

    if (pathname === '/api/state') {
      if (!this._authorised(url)) return this._json(res, 401, { error: 'Bad token' });
      return this._json(res, 200, this._state());
    }

    if (req.method === 'DELETE' && pathname === '/api/history') {
      if (!this._authorised(url)) return this._json(res, 401, { error: 'Bad token' });
      const removed = await this.onClearAll();
      return this._json(res, 200, { removed: Number(removed) || 0 });
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/history/')) {
      if (!this._authorised(url)) return this._json(res, 401, { error: 'Bad token' });
      // Take the raw segment — never decode it. Decoding first would turn an
      // encoded traversal into a path.
      const id = pathname.slice('/api/history/'.length);
      if (!validRowId(id)) return this._json(res, 400, { error: 'Bad id' });
      const removed = await this.onPurge(id);
      if (!removed) return this._json(res, 404, { error: 'Not found' });
      return this._json(res, 200, { removed });
    }

    if (req.method === 'GET' && pathname === '/api/history') {
      if (!this._authorised(url)) return this._json(res, 401, { error: 'Bad token' });
      return this._json(res, 200, { history: this.store.snapshot().history });
    }

    if (req.method === 'POST' && pathname === '/api/settings/open') {
      if (!this._authorised(url)) return this._json(res, 401, { error: 'Bad token' });
      // A token in the URL does not prove a browser page is ours: any site can
      // POST to loopback. A foreign Origin on a state-changing method is
      // refused, and the callback can only open an existing window — it never
      // touches the store (T-01-06).
      if (!this._originAllowed(req.headers.origin)) {
        return this._json(res, 403, { error: 'Origin not allowed' });
      }
      await this.onOpenSettings();
      return this._json(res, 200, { ok: true });
    }

    // Static files
    const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const full = path.join(ROOT, file);
    if (!full.startsWith(ROOT)) return this._json(res, 403, { error: 'Forbidden' });

    try {
      const data = fs.readFileSync(full);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  }

  _hostAllowed(host) {
    if (!host) return false;
    const allowed = [`${HOST}:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
    return allowed.includes(host);
  }

  _authorised(url) {
    const token = url.searchParams.get('token');
    return !!token && token === this.token;
  }

  /**
   * A non-GET request must come from our own page. A request with no Origin
   * header is not a browser cross-site POST (the token already gates it), so
   * only a present-and-foreign Origin is refused.
   */
  _originAllowed(origin) {
    if (!origin) return true;
    return [`http://${HOST}:${this.port}`, `http://localhost:${this.port}`].includes(origin);
  }

  _state() {
    const snapshot = this.store.snapshot();
    const live = this.bus.recent(200);
    const events = collectEvents(snapshot.history, snapshot.events || [], live);
    const settings = snapshot.settings || {};
    return {
      app: {
        state: this.bus.appState || 'idle',
        handsFree: !!this.bus.handsFree,
        model: settings.model || null,
        shortcuts: settings.shortcuts || null,
        startedAt: this.bus.startedAt || null,
        version: this.bus.version || null,
      },
      analytics: summarize({
        history: snapshot.history,
        events,
        stats: snapshot.stats,
        fallbackModel: settings.model || null,
      }),
      // Read-only facts (D-02). O(1) — the audit count is a cached number.
      privacy: this.getPrivacyFacts ? this.getPrivacyFacts() : null,
      history: snapshot.history,
      events,
    };
  }

  _events(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    this.clients.add(res);

    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* client gone */ }
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      this.clients.delete(res);
    });
  }

  _broadcast(event) {
    if (!this.clients.size) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try { res.write(payload); } catch { this.clients.delete(res); }
    }
  }

  _json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  }
}

module.exports = { DashboardServer, DEFAULT_PORT, HOST };
