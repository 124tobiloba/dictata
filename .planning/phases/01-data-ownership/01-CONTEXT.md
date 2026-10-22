# Phase 1: Data Ownership - Context

**Gathered:** 2026-10-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Make the dictation record **erasable, expirable, relocatable, and exportable**, and make
every surface agree on what remains. Surfaces in scope: the local dashboard (feed, history,
analytics), the in-app History window, the persisted JSON store, and the in-memory event bus.

Deliverables: per-row delete with a hidden affordance, clear-all with confirmation,
retention window enforcement, configurable storage location, JSON/CSV history export,
and a metadata-only audit ledger with its own export.

**Not in scope:** search/filter/tagging of history, cloud backup, sync, automatic deletion
without an explicit retention setting, transcript redaction, or any change to the dictation
pipeline itself.

</domain>

<decisions>
## Implementation Decisions

### Where controls live
- **D-01:** The **Settings window owns configuration** — a new "Privacy & Data" panel holds
  retention, storage location, and both export actions. The **dashboard owns acting on the
  record** — per-row delete and clear-all only. — **Reversibility:** costly — moving these
  controls later touches both the Settings renderer and the dashboard server/UI, and the
  folder-picker path only exists in the main process.
- **D-02:** The dashboard displays the current retention window and storage path as
  **read-only facts with a link/button that opens Settings** — never duplicated as an
  editable form.

### Retention
- **D-03:** Default retention for an existing install is **keep forever**. Nothing is purged
  until the user opts into 30/90/365 days; the upgrade must not silently delete history.
- **D-04:** Retention options are exactly **30 / 90 / 365 days / keep forever**.
- **D-05:** Expiry is swept **on app launch and after each completed dictation** — no
  background timer, no dashboard-load-only purge. The dashboard must never show a row that
  the retention policy says is already expired.
- **D-06:** Deleting or expiring an entry **recomputes `stats` (words, sessions, msSpoken)
  from the remaining history**. This also fixes today's drift where the 500-entry cap drops
  rows but `stats.words` keeps climbing. `lifetimeWords` in analytics must equal the words
  in the stored record.

### Delete scope and safety
- **D-07:** **Failed-attempt rows are deletable** with the same affordance. They exist only
  as `error` events (no history entry), so deletion must support both id spaces.
- **D-08:** Single delete uses an **inline two-step confirm**: a trash affordance that is
  invisible at rest, revealed on row hover / row focus / keyboard focus; first activation
  turns the row into `Delete this dictation? [Delete] [Cancel]`. No modal, no undo toast.
- **D-09:** A delete must purge **all four surfaces**: `store.history`, `store.events`
  (persisted), the `EventBus` in-memory buffer (so the row cannot be re-sent over SSE), and
  recompute `stats`. The in-app History window must reflect the deletion without a restart.
- **D-10:** Clear-all uses an explicit confirmation that names the count
  ("Delete all N dictations?"). It clears history, persisted events, and the live bus
  buffer, and zeroes stats — but **does not clear the audit ledger** (see D-11).

### Audit ledger and export
- **D-11:** The audit log is a **separate metadata-only ledger**, persisted, containing
  timestamp, target app, duration, model, outcome (`pasted` / `failed`), and error kind when
  applicable. It contains **no transcript text, no raw audio, no partial text**. It
  **survives transcript deletion** — deleting text must not erase proof that a dictation
  happened. — **Reversibility:** one-way — once users rely on "deleted text, audit intact",
  folding the ledger back into history would silently destroy evidence.
- **D-12:** The ledger is kept **until explicitly cleared**, independent of the transcript
  retention window. A dedicated "Clear audit log" action (its own confirmation) is the only
  way it shrinks.
- **D-13:** History export ships **both JSON and CSV**, whole-record (no date-range picker in
  v1). The audit ledger has its own separate export in both formats. Export lives in
  Settings; files are written through a native save dialog (main process), not a browser
  download.

### Storage relocation
- **D-14:** Pointing storage at a new folder **moves** the existing record: write the store
  to the new location, verify it reads back, then remove the old file. No silent second copy
  left behind. Settings persist a small pointer so the app can find the store next launch.
  — **Reversibility:** one-way — undoing requires moving user data back and repairing a
  pointer file; a half-finished move must never lose the record.
- **D-15:** Logs are diagnostics, not transcripts, and stay in `%APPDATA%\Dictata\logs`
  regardless of where transcripts live.

### the agent's Discretion
- Exact filenames, CSV column order, and export file naming convention.
- Whether the ledger lives inside `dictata.json` or its own sidecar file (planner/researcher
  to choose based on atomicity and move semantics).
- Copy for the confirmation prompts, empty states, and the "Privacy & Data" panel layout.
- Whether clear-all and per-row delete emit an `info` event afterwards (recommended: yes,
  so the user sees that the action succeeded).
- Keyboard shortcut for delete (if any).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase and product intent
- `.planning/ROADMAP.md` — Phase 1 goal, success criteria, and requirement mapping
- `.planning/REQUIREMENTS.md` — DATA-01…05, COMP-01, COMP-02 acceptance language
- `.planning/PROJECT.md` — core value, out-of-scope list (no cloud, no telemetry, no demo data)

### Existing code to extend
- `src/main/store.js` — persistence, `deleteHistory`, `clearHistory`, `stats` accounting, atomic tmp write
- `src/main/events.js` — event bus ring buffer, `persistable()`, needs a forget/remove path
- `src/main/dashboard.js` — HTTP server, `collectEvents()`, `_state()`, token/host checks; currently GET-only
- `src/main/analytics.js` — `summarize()` derives visible totals from history and `lifetimeWords` from stats
- `src/main/main.js` — IPC registration (`vf:delete-history`, `vf:clear-history`), pipeline where history/events are written
- `src/main/logger.js` — log location rule (logs stay in userData)
- `src/dashboard/app.js` — `timeline()`, `renderHistory()`, SSE handling, `esc()` escaping rule
- `src/dashboard/styles.css` — existing `.rec`, `.day-card`, `.chip` classes; hidden-affordance styles go here
- `src/renderer/history.html` / `src/renderer/historyRenderer.js` / `src/renderer/historyPreload.js` — in-app History window
- `src/renderer/settings.html` / `src/renderer/settingsRenderer.js` / `src/renderer/settingsPreload.js` — panel/nav pattern for "Privacy & Data"

### Tests and conventions
- `test/store.test.js` — store accounting and persistence expectations
- `test/dashboard.test.js` — route, token, host-header, and payload assertions
- `test/analytics.test.js` — summarize() contract
- `.planning/codebase/CONVENTIONS.md` — naming, error handling, logging, escaping rules
- `.planning/codebase/TESTING.md` — `node:test` patterns and how the dashboard server is exercised
- `.planning/codebase/CONCERNS.md` — stats-cap drift and other known debt this phase must not worsen

### Data-flow and privacy constraints
- `.planning/codebase/INTEGRATIONS.md` — the only outbound call is Gemini; exports and deletion are strictly local

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`Store`** — one JSON document with a debounced atomic write (`tmp` + rename). Extend it
  with `purgeEntry(id)`, `recomputeStats()`, ledger append/clear, and a configurable file
  path; do not introduce a second persistence mechanism.
- **`EventBus`** — add a narrow `forget(id)` (or `remove(ids)`) so a deleted row cannot
  reappear from the ring buffer. `clear()` already exists for clear-all.
- **`collectEvents()`** — already emits history rows with the history id, so purging
  `store.events` plus the bus buffer is sufficient for the feed; error-only rows need their
  event id handled directly.
- **`summarize()`** — visible totals already come from history; only `lifetimeWords` reads
  the stale counter, so recomputing stats fixes it without changing analytics' shape.
- **Settings panel pattern** — `data-panel` nav buttons + `<section id="panel-…">` + one
  renderer function; a sixth panel slots in without new infrastructure.
- **`esc()` in the dashboard** — every interpolated string must pass through it; delete
  controls must not introduce an unescaped id path.

### Established Patterns
- Pure modules (`analytics.js`, `ptt.js`, `wav.js`, `sse.js`) must not require Electron;
  put retention math and audit-row shaping in a pure helper so `node:test` can cover it.
- IPC changes require three edits: preload bridge, `ipcMain` registration, renderer caller.
- Dashboard routes are token-checked **before** dispatch and host-checked before everything;
  a new DELETE/POST route must follow the same order.
- Errors are published as `{ fatal: false }` events and surfaced in the tray; deletion
  failures must not throw into the pipeline.

### Integration Points
- New dashboard routes: `DELETE /api/history/:id` and `DELETE /api/history` (or POST with an
  action body) — must keep the server's loopback + token + Host guarantees.
- New IPC: retention set, storage picker/move, export history, export audit, clear audit.
- Pipeline: after `store.addHistory()` and after each error event, run the retention sweep
  and append a ledger row.
- Store bootstrap: resolve the custom storage path **before** `new Store()` reads the file;
  today `main.js` pins userData and `Store` hardcodes `dictata.json`.

</code_context>

<specifics>
## Specific Ideas

- The delete affordance must be **invisible at rest** — this was an explicit user request, not
  just a style preference. It should appear on hover, row focus, or keyboard focus, and be
  reachable by keyboard for accessibility.
- "Deleted" must mean deleted everywhere: a deleted transcript must not be re-pasteable from
  the tray History window, must not appear in the SSE feed, must not survive in
  `dictata.json`, and must not inflate any total.
- Audit export must be safe to hand to a compliance officer: metadata and outcomes only,
  never text. A reviewer should be able to read it and see that nothing sensitive is present.
- Moving storage must feel like "the record moved", not "the record started over". Verify
  before deleting the old file.

</specifics>

<deferred>
## Deferred Ideas

- **Date-range export and scheduled exports** — useful for quarterly compliance packets, but
  a new capability; backlog for a later phase.
- **Encrypted-at-rest transcript store** (password/DPAPI-encrypted history file) — strong fit
  for regulated buyers, but a separate hardening phase.
- **Per-entry detail view / transcript copy button** — dashboard enhancement, not required for
  data ownership.
- **Audit ledger viewer UI** — v1 exports the ledger; browsing it in-app is a later feature.
- **Automatic retention policy from a team admin** — belongs to the future Teams/Pro tier.

</deferred>

---

*Phase: 01-Data Ownership*
*Context gathered: 2026-10-22*
