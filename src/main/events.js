/**
 * events.js — the activity event bus.
 *
 * Everything the app does is published here as a typed event. The dashboard
 * server streams these to the browser, and the store keeps the interesting
 * ones so the history survives a restart.
 *
 * Events are deliberately flat and JSON-safe — they travel over SSE.
 */

const { EventEmitter } = require('events');

/** Events worth keeping on disk (state changes and partials are noise). */
const PERSISTED_TYPES = new Set(['dictation', 'error', 'info']);

const DEFAULT_LIMIT = 500;

let counter = 0;

class EventBus extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.limit]  how many events to keep in memory
   */
  constructor(opts = {}) {
    super();
    this.setMaxListeners(50);
    this.limit = opts.limit ?? DEFAULT_LIMIT;
    this.buffer = [];
  }

  /**
   * Publish an event.
   * @param {string} type  state | partial | dictation | error | info
   * @param {object} [payload]
   */
  publish(type, payload = {}) {
    const event = {
      id: `${Date.now().toString(36)}-${(counter++).toString(36)}`,
      ts: Date.now(),
      type,
      ...payload,
    };
    this.buffer.push(event);
    if (this.buffer.length > this.limit) {
      this.buffer.splice(0, this.buffer.length - this.limit);
    }
    this.emit('event', event);
    return event;
  }

  /**
   * The most recent events, newest first.
   * @param {number} [n]
   * @param {string[]} [types]  only these types
   */
  recent(n = 100, types = null) {
    const list = types ? this.buffer.filter((e) => types.includes(e.type)) : this.buffer;
    return list.slice(-n).reverse();
  }

  /** Only the events that are worth persisting. */
  persistable() {
    return this.buffer.filter((e) => PERSISTED_TYPES.has(e.type));
  }

  /** Drop one event — a deleted dictation must not come back over SSE. */
  forget(id) {
    this.buffer = this.buffer.filter((e) => e.id !== id);
  }

  /** Drop several events at once (a dictation id and its error rows). */
  forgetMany(ids) {
    const drop = new Set(ids || []);
    this.buffer = this.buffer.filter((e) => !drop.has(e.id));
  }

  /** Drop every buffered event, keeping the app-state properties intact. */
  forgetAll() {
    this.buffer = [];
  }

  clear() {
    this.buffer = [];
  }
}

module.exports = { EventBus, PERSISTED_TYPES };
