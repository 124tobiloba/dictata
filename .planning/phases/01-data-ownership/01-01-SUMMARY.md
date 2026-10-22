---
phase: 01-data-ownership
plan: 01
subsystem: data-ownership
tags: [electron, vanilla-js, deletion, event-bus, http-routes, node-test]

# Dependency graph
requires:
  - phase: none
    provides: brownfield Dictata 0.1.0 baseline (store, event bus, dashboard server)
provides:
  - one main-process mutation path for deleting one dictation or every dictation
  - derived `stats` recomputed from the surviving history (fixes cap drift)
  - `flush()` so destructive writes reach disk before the call returns
  - `EventBus.forget/forgetMany/forgetAll` so a deleted row cannot return over SSE
  - `DELETE /api/history/:id` and `DELETE /api/history` behind host + token + id-shape gates
  - hidden, keyboard-reachable two-step delete affordance on dashboard rows
  - clear-all behind a count-naming confirmation on both the dashboard and History window
  - paste-last re-derived from surviving history at startup and after every delete/clear
affects: [01-02 retention + storage relocation, 01-03 export + audit ledger, Phase 2 privacy docs]

# Actuals (#2632) — same chars/4 scale as the plan estimate.
actuals:
  tokens: 9242
  tasks: 3
  commits: 3
plan_head_before: fdefeddb5cc7cff7663dbba6ae5dd035fbe90af8
plan_head_after: e9fa70e7bff3ffb9f944eb3df9fad130094e4adb

# Tech tracking
tech-stack:
  added: []
  patterns:
    - derived stats (`computeStats`) instead of incremental counters
    - synchronous `flush()` for destructive mutations
    - dependency-injected purge/clear callbacks on the dashboard server
    - `state.confirmId` / `state.confirmClear` for inline confirmations

key-files:
  created:
    - test/events.test.js
  modified:
    - src/main/analytics.js
    - src/main/store.js
    - src/main/events.js
    - src/main/dashboard.js
    - src/main/main.js
    - src/dashboard/app.js
    - src/dashboard/index.html
    - src/dashboard/styles.css
    - src/renderer/historyRenderer.js
    - test/analytics.test.js
    - test/store.test.js
    - test/dashboard.test.js
    - test/page.test.js

key-decisions:
  - "Stats are derived from the surviving history via computeStats(); nothing else assigns this.data.stats."
  - "store.purgeEntry/clearAll call flush() before returning so a quit inside the 150 ms debounce cannot resurrect a row."
  - "The dashboard DELETE routes sit before the method-guarded GET branch and the static fallthrough; the GET branch is now method-guarded."
  - "validRowId accepts exactly a history UUID or a base36 `timestamp-counter` bus id and rejects separators, %, quotes, whitespace, dots and over-long segments."
  - "Deletion callbacks are injected into DashboardServer (onPurge/onClearAll) so the main process owns the single mutation path."
  - "Paste-last reads lastTarget(store.snapshot().history) at startup and after every delete/clear, with a history fallback in the hotkey handler."

patterns-established:
  - "One mutation path: dashboard route and History IPC both call main.purgeEntry/clearAll."
  - "Pure helpers (computeStats, lastTarget, purgeEntryData, clearAllData) are unit-tested without Electron."
  - "Confirm state lives in the dashboard `state` object so the 5 s re-render cannot wipe it."

requirements-completed: [DATA-01, DATA-02, DATA-03]

coverage:
  - id: D1
    description: "Delete one dictation or failed attempt from a dashboard row and have it disappear from history, persisted events, the live bus and stats."
    requirement: DATA-01
    verification:
      - kind: integration
        ref: "test/dashboard.test.js#a delete accepts a history UUID and hands it over unchanged"
        status: pass
      - kind: integration
        ref: "test/dashboard.test.js#a delete accepts a failed-attempt bus id"
        status: pass
      - kind: unit
        ref: "test/store.test.js#purging one id removes the dictation row and its persisted event"
        status: pass
      - kind: unit
        ref: "test/events.test.js#forget removes one event and keeps the app-state properties"
        status: pass
    human_judgment: false
  - id: D2
    description: "The delete affordance is invisible at rest, revealed on row hover/focus, reachable by Tab, and confirms inline with Delete/Cancel (Escape cancels) on both row kinds."
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "test/page.test.js#the delete affordance is invisible at rest and revealed by hover or focus"
        status: pass
      - kind: unit
        ref: "test/page.test.js#the delete affordance is never removed from the tab order"
        status: pass
    human_judgment: true
    rationale: "Hover/focus reveal and keyboard interaction are visual behaviours; the static assertions prove the rules exist but not how they feel in a browser."
  - id: D3
    description: "Clear-all deletes every dictation and failed attempt only after a confirmation that names the count, while settings, API key, dictionary, replacements and dashboard token survive."
    requirement: DATA-02
    verification:
      - kind: unit
        ref: "test/store.test.js#clearAllData empties the record but keeps identity and settings"
        status: pass
      - kind: unit
        ref: "test/store.test.js#a clear-all is on disk before the call returns"
        status: pass
      - kind: integration
        ref: "test/dashboard.test.js#clear-all needs the token and returns the callback count"
        status: pass
      - kind: unit
        ref: "test/page.test.js#the clear-all control names the count before it deletes anything"
        status: pass
    human_judgment: true
    rationale: "The wording of the count-naming confirmation and the two-step interaction need a human to read and click."
  - id: D4
    description: "Deleted text cannot return: the file is rewritten before the call returns, the live bus is purged, stats are recomputed and paste-last falls back to the surviving history."
    requirement: DATA-03
    verification:
      - kind: unit
        ref: "test/store.test.js#a purge is on disk before the call returns"
        status: pass
      - kind: unit
        ref: "test/store.test.js#flushing twice leaves the API key readable"
        status: pass
      - kind: unit
        ref: "test/analytics.test.js#lastTarget cannot replay a deleted row"
        status: pass
      - kind: unit
        ref: "test/analytics.test.js#computeStats agrees with the summary totals"
        status: pass
    human_judgment: false

# Metrics
duration: 24min
completed: 2026-10-22
status: complete
---

# Phase 1 Plan 1: Data Ownership Summary

**Per-row and clear-all deletion that purges history, persisted events, the live bus, stats and paste-last in one flushed mutation path**

## Performance

- **Duration:** ~24 min
- **Started:** 2026-10-22T14:19:27Z
- **Completed:** 2026-10-22T14:43:31Z
- **Tasks:** 3 (tracer + 2 expansion)
- **Files modified:** 14 (1 created, 13 modified)

## Accomplishments

- A dashboard row can be deleted end-to-end: hidden trash → inline `Delete this dictation?` confirm → `DELETE /api/history/:id` → `main.purgeEntry` → store + event bus + stats + History window, with no restart.
- Both id spaces the UI renders are accepted by the route — a history UUID and the bus id (`mhqk3z1a-0` shape) for failed attempts — while separators, `%`, quotes, dots and over-long segments are rejected with `400`.
- `stats` is now derived from the surviving history (`computeStats`), removing the 500-entry-cap drift at its source and satisfying D-06.
- Clear-all names the count before deleting, empties history and persisted events, zeroes stats, and leaves settings, API key, dictionary, replacements and the dashboard token untouched.
- No-resurrection guarantees: destructive mutations `flush()` synchronously, `before-quit` flushes first, the bus drops the row before the next snapshot/SSE replay, and paste-last is re-derived from the surviving history.

## Task Commits

Each task was committed atomically:

1. **Task 1: Delete one dictation end-to-end through every layer** - `762c957` (feat)
2. **Task 2: Hidden delete affordance with a two-step inline confirm** - `ca5d3c5` (feat)
3. **Task 3: Clear-all plus the no-resurrection guarantees** - `e9fa70e` (feat)

**Plan metadata:** `pending` (docs: complete plan)

## Files Created/Modified

- `src/main/analytics.js` — `computeStats(history)` and `lastTarget(history)` pure exports beside `summarize`
- `src/main/store.js` — `opts.dir/opts.file` constructor, `purgeEntryData`, `purgeEntry`, `clearAllData`, `clearAll`, `_writeNow`, `flush`, `_recomputeStats`; removed `deleteHistory`/`clearHistory`
- `src/main/events.js` — `forget`, `forgetMany`, `forgetAll`
- `src/main/dashboard.js` — `validRowId`, injected `onPurge`/`onClearAll`, DELETE routes, method-guarded GET
- `src/main/main.js` — `purgeEntry`, `clearAll`, `rederiveLast`, before-quit flush, paste-last fallback, IPC rewire
- `src/dashboard/app.js` — delete button + confirm row, delegated delete/clear listeners, Escape handling
- `src/dashboard/index.html` — clear-all/cancel/count controls in the history panel head
- `src/dashboard/styles.css` — three-column row grid, opacity-only reveal, confirm styling, `hover: none` + reduced-motion overrides
- `src/renderer/historyRenderer.js` — authoritative refresh, count-naming native confirm, no local DOM removal
- `test/events.test.js` — new bus test file (forget/forgetMany/forgetAll preserve app state)
- `test/analytics.test.js` — `computeStats` agreement, `lastTarget` after purge
- `test/store.test.js` — purge/clear pure cases, temp-dir round-trips, flush idempotency
- `test/dashboard.test.js` — DELETE auth/200/400/404 cases, GET fallthrough, clear-all count
- `test/page.test.js` — affordance reveal, tab-order, clear-all control assertions

## Decisions Made

- **Stats are derived, never accumulated.** `computeStats` is the only writer of `this.data.stats`; `_load()` does not touch it because `this.data` is not assigned yet inside `_load`.
- **`flush()` is mandatory for destructive mutations.** `_writeNow` begins with `_ensureDecrypted()` so a flush-first store can never double-encrypt the key.
- **Node/method/path ordering changed only where required.** DELETE branches are matched before the now method-guarded `GET /api/history`; the Host allowlist remains first and the token check precedes any mutation.
- **The route is a shape gate, not a kind gate.** `validRowId` accepts both rendered id shapes; whether the row exists is decided by the purge (`404` when nothing matched).
- **Confirm state lives in `state`, not the DOM** (dashboard) and the History window keeps the last snapshot in module scope only to name the clear count.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Implemented `EventBus.forgetAll` in Task 1**
- **Found during:** Task 1 verification
- **Issue:** Task 1's own test brief requires asserting `forgetAll()`, but the action list deferred the method to Task 3; `test/events.test.js` failed with `bus.forgetAll is not a function`.
- **Fix:** Added the one-line `forgetAll()` buffer clear in Task 1 alongside `forget`/`forgetMany`.
- **Files modified:** `src/main/events.js`
- **Verification:** `node --test test/events.test.js` passes; full suite green.
- **Committed in:** `762c957`

**2. [Rule 2 - Missing Critical] Landed `clearAllData`/`clearAll` store helpers in Task 1's commit**
- **Found during:** Task 1 implementation
- **Issue:** Splitting the Store mutation surface across commits would leave `Store` with `purgeEntry` but no complete clear path while the same file was already being rewritten; the plan lists both helpers, just under Task 3.
- **Fix:** Implemented both pure helper and method (plus `clearAllData` export) with the purge work; Task 3 added the route, UI and tests that exercise them.
- **Files modified:** `src/main/store.js`
- **Verification:** `test/store.test.js` clear-all cases pass (Task 3).
- **Committed in:** `762c957` (helpers), `e9fa70e` (tests + callers)

**3. [Rule 1 - Bug] Did not import the unused `wordCount` into `store.js`**
- **Found during:** Task 1 implementation
- **Issue:** The plan text says to require `computeStats` and `wordCount` from `./analytics`; after replacing the inline counter, `wordCount` has no caller in the store (fallback lives inside `computeStats`).
- **Fix:** Imported only `computeStats`, keeping the module free of an unused binding; the duplicated inline word counter is still deleted.
- **Files modified:** `src/main/store.js`
- **Verification:** `npm test` green; no behavioural difference.
- **Committed in:** `762c957`

---

**Total deviations:** 3 auto-fixed (1 blocking, 1 missing critical, 1 bug/cleanup)
**Impact on plan:** No scope creep. Deviations only moved already-specified helpers earlier within the same plan and avoided an unused import.

## Issues Encountered

- None. `npm test` grew from 68 to 96 tests and `npm run test:dashboard` from 11 to 19, both with `# fail 0`.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- The single mutation path (`main.purgeEntry` / `main.clearAll`) and derived stats are ready for Plan 01-02's retention sweep and storage relocation: a sweep can call `store.purgeEntry`/`flush` and reuse `computeStats`.
- `Store({ dir })` now accepts a data directory, which unblocks the storage-relocation tests in Plan 01-02.
- Manual UAT still to run at phase verification: delete a row, quit immediately from the tray, relaunch; Tab-to-row keyboard deletion; delete the newest row then invoke paste-last in another app.

---
*Phase: 01-data-ownership*
*Completed: 2026-10-22*

## Self-Check: PASSED

- All 11 created/modified source and test files exist.
- Task commits `762c957`, `ca5d3c5`, `e9fa70e` are ancestors of HEAD.
- `npm test`: 96 tests, `# fail 0`; `npm run test:dashboard`: 19 tests, `# fail 0`.
