/**
 * retention.js — the retention window rules (pure, no Electron, no I/O).
 *
 * Retention decides which rows are already expired, and nothing else: the
 * store removes them, the bus forgets them, and the main process decides when
 * to sweep. Keeping the arithmetic here means `node --test` can prove the
 * boundary rules without a display or a filesystem.
 *
 * Invariant: `0` means keep forever, so `cutoffFor(0, …)` must return `null`.
 * A sweep with a null cutoff removes nothing — an upgrade must never silently
 * delete an existing install's history.
 */

/** The only retention windows the UI may offer (days; 0 = keep forever). */
const RETENTION_CHOICES = [0, 30, 90, 365];

/**
 * Keep only a window we actually offer. Anything else — a corrupt stored
 * value, a string from the DOM, a hand-edited settings file — is keep forever.
 *
 * @param {*} value
 * @returns {number}  one of RETENTION_CHOICES
 */
function normalizeRetentionDays(value) {
  const days = Number(value);
  return RETENTION_CHOICES.includes(days) ? days : 0;
}

/**
 * The oldest timestamp that is still inside the window.
 *
 * `setDate` is used instead of subtracting milliseconds so a 30-day window
 * stays 30 calendar days across a DST change (the local clock time is
 * preserved, the wall-clock duration is not).
 *
 * @param {number} days   one of RETENTION_CHOICES
 * @param {number} now    clock override (tests)
 * @returns {number|null}  epoch ms, or null when nothing ever expires
 */
function cutoffFor(days, now) {
  if (!(Number(days) > 0)) return null;
  const cutoff = new Date(Number(now) || Date.now());
  cutoff.setDate(cutoff.getDate() - Number(days));
  return cutoff.getTime();
}

/**
 * Split history rows into survivors and expired ids.
 *
 * A row stamped exactly at the cutoff stays: the window is "the last N days",
 * inclusive of its boundary, so a sweep run twice in a row is idempotent.
 *
 * @param {object[]} [history]  newest first
 * @param {number} cutoff
 * @returns {{keep: object[], expiredIds: string[]}}
 */
function splitExpired(history = [], cutoff) {
  const keep = [];
  const expiredIds = [];
  for (const row of history) {
    if (!row) continue;
    if ((row.at || 0) < cutoff) {
      if (row.id) expiredIds.push(row.id);
      continue;
    }
    keep.push(row);
  }
  return { keep, expiredIds };
}

/**
 * The same split for persisted events. Expired error events matter as much as
 * expired dictations: their messages can quote what was said.
 *
 * @param {object[]} [events]
 * @param {number} cutoff
 * @returns {{keep: object[], expiredIds: string[]}}
 */
function splitExpiredEvents(events = [], cutoff) {
  const keep = [];
  const expiredIds = [];
  for (const event of events) {
    if (!event) continue;
    if ((event.ts || 0) < cutoff) {
      if (event.id) expiredIds.push(event.id);
      continue;
    }
    keep.push(event);
  }
  return { keep, expiredIds };
}

/**
 * The user-facing summary of one sweep, or null when nothing expired.
 *
 * D-05 covers both collections: an expired failed attempt is as visible on the
 * dashboard as an expired dictation, so an events-only sweep must still notify
 * an open tab to reload. Keeping the wording here makes that rule testable
 * without Electron.
 *
 * @param {object} input
 * @param {number} [input.historyRemoved]
 * @param {number} [input.eventsRemoved]
 * @param {number} input.days
 * @returns {string|null}
 */
function sweepSummary({ historyRemoved = 0, eventsRemoved = 0, days } = {}) {
  const dictations = Number(historyRemoved) || 0;
  const activities = Number(eventsRemoved) || 0;
  if (dictations === 0 && activities === 0) return null;

  const dictationText = `${dictations} dictation${dictations === 1 ? '' : 's'}`;
  const activityText = `${activities} old activit${activities === 1 ? 'y' : 'ies'}`;
  const what = dictations && activities
    ? `${dictationText} and ${activityText}`
    : (dictations ? dictationText : activityText);
  return `Expired ${what} older than ${days} days`;
}

module.exports = {
  RETENTION_CHOICES,
  normalizeRetentionDays,
  cutoffFor,
  splitExpired,
  splitExpiredEvents,
  sweepSummary,
};
