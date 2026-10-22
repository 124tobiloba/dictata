---
phase: 01-data-ownership
plan: 03
subsystem: data-ownership
tags: [electron, vanilla-js, export, csv, storage-relocation, crash-safety, node-test]

# Dependency graph
requires:
  - phase: 01-01
    provides: flushed destructive mutations, derived stats, purge/clear callbacks, dashboard delete routes
  - phase: 01-02
    provides: retention sweep, metadata-only audit ledger with cached count and setFile
provides:
  - `exporter.js` — csvField (RFC 4180 + formula guard), toCsv (BOM + CRLF), historyRows, auditRows
  - Settings export surface — history and audit in JSON and CSV through native save dialogs
  - `storage.js` — storage.json pointer, pure samePath, readPointer, resolveStoreDir, recoverMove, verifyCopy, moveTo, finishPendingDelete
  - copy → verify → commit → delete relocation that works across volumes and shares
  - Settings Storage panel with the resolved folder and a native folder picker
  - dashboard storeDir read from `store.file` at call time, pushed by a `kind: 'storage'` info event
affects: [Phase 2 data-flow documentation, Phase 3 egress and offline work, any future store schema change]

# Actuals (#2632) — same chars/4 scale as the plan estimate.
actuals:
  tokens: 16503
  tasks: 3
  commits: 2
plan_head_before: a98a3ef62750c805977b46e2ec15da21c54fb1dd
plan_head_after: 946bb4a1fbc20be4d4d47f2f2559b53b2568354d

# Tech tracking
tech-stack:
  added: []
  patterns:
    - copy with COPYFILE_EXCL → verify → single atomic commit write → delete the source
    - journal records the intent in `move` while `dir` still names the source
    - authority changes in exactly one pointer write; every pointer write is tmp + rename in one directory
    - recovery classifies a journal by re-verifying the target, never by trusting the journal
    - deletion engine skips the resolved directory and treats absent files as no-ops
    - BOM + CRLF + OWASP formula guard for spreadsheet-safe CSV

key-files:
  created:
    - src/main/exporter.js
    - src/main/storage.js
    - test/exporter.test.js
    - test/storage.test.js
  modified:
    - src/main/main.js
    - src/main/store.js
    - src/main/dashboard.js
    - src/dashboard/index.html
    - src/dashboard/app.js
    - src/renderer/settings.html
    - src/renderer/settingsRenderer.js
    - src/renderer/settingsPreload.js
    - test/dashboard.test.js
    - test/page.test.js
    - test/store.test.js

key-decisions:
  - "D-14 = `copy-verify-delete`: copy straight to the target filename with COPYFILE_EXCL, verify the read-back, commit, then delete the source. The `.moving` staged variant was explicitly not implemented, and `fs.renameSync` is never used to move a file between directories anywhere in this feature."
  - "The pre-copy journal carries `move` only and leaves `dir`/`pendingDelete` untouched. `pendingDelete: [from]` is written only by the commit that follows a verified copy — writing it earlier would verify the source against itself and then delete it."
  - "`moveTo` is the single validation path. The IPC handler only rejects a missing value; every path check (absolute, realpath, extension, directory type, containment, same-path, existing record, writability) lives in storage.js."
  - "A storage move is visible without a restart: the dashboard derives `storeDir` from `store.file` on every `/api/state`, and an `info` event with `kind: 'storage'` makes an open tab call `loadState()` once instead of polling."
  - "The move event carries no path. The persisted event log is part of the record and must not learn the user's folder layout."

patterns-established:
  - "Crash-safety tests seed the pointer file directly (mis-ordered journal, partial target, fully copied target, already-cleaned directory) and assert on disk state, not on return values."
  - "A failed deletion keeps its `pendingDelete` entry so the next launch retries it; a clean sweep rewrites the pointer with `pendingDelete: []`."
  - "Static page tests read a second fixture pair (`settings.html` + `settingsRenderer.js`) from the same file, so a typo'd Settings id fails CI without a new test file."

requirements-completed: [DATA-04, COMP-01, COMP-02]

coverage:
  - id: D1
    description: "The whole dictation history exports as JSON and as CSV from Settings through a native save dialog, one row per entry with ISO timestamps."
    requirement: DATA-04
    verification:
      - kind: unit
        ref: "test/exporter.test.js#history rows are one per entry with an ISO timestamp"
        status: pass
      - kind: unit
        ref: "test/exporter.test.js#a CSV document starts with the UTF-8 BOM"
        status: pass
      - kind: integration
        ref: "test/page.test.js#every element the settings window looks up exists in its markup"
        status: pass
    human_judgment: false
  - id: D2
    description: "The audit ledger exports separately as JSON and CSV, metadata only, with no transcript text in the file."
    requirement: COMP-01
    verification:
      - kind: unit
        ref: "test/exporter.test.js#audit rows carry metadata only, never transcript text"
        status: pass
      - kind: unit
        ref: "test/exporter.test.js#a formula-leading cell gets a single-quote guard"
        status: pass
    human_judgment: true
    rationale: "Opening the CSV in Excel and searching an export for a transcript string is a visual, platform-specific check the unit tests cannot perform."
  - id: D3
    description: "Pointing storage at another folder moves the store and the ledger, verifies the copy before deleting, and leaves no second copy behind."
    requirement: COMP-02
    verification:
      - kind: unit
        ref: "test/storage.test.js#moveTo copies the store and ledger, commits the pointer and removes the originals"
        status: pass
      - kind: unit
        ref: "test/storage.test.js#a fully copied, verifying target is committed and the source removed"
        status: pass
    human_judgment: false
  - id: D4
    description: "At every crash point the record has a verified readable copy: a partial target is discarded and retryable, and recovery never deletes the directory the pointer resolves to."
    requirement: COMP-02
    verification:
      - kind: unit
        ref: "test/storage.test.js#recovery never deletes the directory the pointer resolves to"
        status: pass
      - kind: unit
        ref: "test/storage.test.js#a truncated target is discarded, the source kept, and the same folder can be retried"
        status: pass
      - kind: unit
        ref: "test/storage.test.js#pendingDelete is swept only when the resolved store verifies"
        status: pass
      - kind: unit
        ref: "test/storage.test.js#a pendingDelete whose files are already gone does not throw and is cleared"
        status: pass
    human_judgment: false
  - id: D5
    description: "A refused move leaves the original record and pointer untouched; a target holding a record, a target inside app data, a relative path and a file path are all refused."
    requirement: COMP-02
    verification:
      - kind: unit
        ref: "test/storage.test.js#a target that already holds a record is refused and the source is untouched"
        status: pass
      - kind: unit
        ref: "test/storage.test.js#a target inside the app data folder is refused"
        status: pass
      - kind: unit
        ref: "test/storage.test.js#a relative target is refused"
        status: pass
      - kind: unit
        ref: "test/storage.test.js#a file is refused as a destination, whether by type or by extension"
        status: pass
      - kind: unit
        ref: "test/storage.test.js#a target that cannot be created leaves the source readable and the journal clear"
        status: pass
    human_judgment: false
  - id: D6
    description: "After a move, Settings and an already-open dashboard both show the folder the app is actually reading, without a restart."
    requirement: COMP-02
    verification:
      - kind: integration
        ref: "test/dashboard.test.js#the privacy path follows the store after a move, without a restart"
        status: pass
      - kind: unit
        ref: "test/page.test.js#a move updates the folder on screen before it reports success"
        status: pass
      - kind: unit
        ref: "test/page.test.js#an open dashboard tab follows a storage move without a reload"
        status: pass
      - kind: unit
        ref: "test/store.test.js#setFile points the record at the moved folder and writes there"
        status: pass
    human_judgment: true
    rationale: "The folder picker, the native dialog and a cross-volume move (second drive or share) need a human at a Windows desktop; the automated tests cover the filesystem contract."
  - id: D7
    description: "Settings states the three ownership facts: logs stay in app data, the key is encrypted for the current Windows user, and a store moved outside app data survives uninstall."
    requirement: COMP-02
    verification:
      - kind: unit
        ref: "test/page.test.js#the settings window exposes the storage folder and a way to change it"
        status: pass
    human_judgment: false

# Metrics
duration: 32min
completed: 2026-10-22
status: complete
---

# Phase 1 Plan 3: Data Ownership Summary

**Full history and audit-ledger export in JSON and CSV, plus copy-verify-delete storage relocation that keeps one verified readable record at every crash point and follows the move in Settings and an open dashboard**

## Performance

- **Duration:** ~32 min (includes the D-14 blocking decision checkpoint pause)
- **Started:** 2026-10-22T15:23:00Z
- **Completed:** 2026-10-22T15:55:29Z
- **Tasks:** 3 (2 auto commits + 1 decision checkpoint)
- **Files modified:** 16 (4 created, 12 modified)
- **Tests:** `npm test` 142 → 164 passing; `npm run test:dashboard` 26 → 27 passing

## Accomplishments

- **The record is portable in both directions.** Settings exports the whole history and the whole audit ledger as JSON and as CSV through native save dialogs; storage can be pointed at another folder, including a second drive or a share.
- **CSV is spreadsheet-safe.** `toCsv` emits a UTF-8 BOM and CRLF rows, `csvField` quotes per RFC 4180 with doubled inner quotes, and a value beginning with `=`, `+`, `-`, `@`, tab or CR is prefixed with a single quote (T-01-11). Timestamps are always ISO 8601.
- **The audit export cannot leak a transcript.** `auditRows` projects only the ledger's allow-listed metadata columns; `text`, `raw` and `cleaned` are never read, and the CSV/JSON include a note that records begin at upgrade.
- **The move is safe at every crash point.** The journal is written before the first byte with `dir` still on the source; the copy uses `COPYFILE_EXCL`; `verifyCopy` checks parse, byte size, history count and ledger line count; a single atomic commit write moves authority; only then are the source files deleted. Every one of those windows has a test.
- **Recovery is conservative by construction.** `recoverMove` commits a verifying target or deletes only the partial files this move created — never the source. `finishPendingDelete` skips the resolved directory, refuses to delete when the new store does not parse, deletes files only (never a directory), and treats an absent file as a no-op.
- **No stale path anywhere after a move.** `main` resolves storage before `new Store()`, `store.setFile`/`ledger.setFile` follow the successful move, `vf:data-info` and `/api/state` read `path.dirname(store.file)` at call time, Settings writes the returned folder into `storagePath` before showing the message, and an open dashboard tab re-reads state on the `kind: 'storage'` info event.

## Task Commits

Each task was committed atomically:

1. **Task 1: Export history and audit ledger as JSON and CSV** — `a3869cb` (feat)
2. **Task 2: D-14 checkpoint (decision)** — resolved by the user, no commit
3. **Task 3: Relocatable transcript storage with a crash-safe move** — `946bb4a` (feat)

**Plan metadata:** pending (docs: complete plan)

## D-14 Decision Record

- **Selected:** `copy-verify-delete`
- **Instruction honoured:** copy straight to the target filename with `fs.constants.COPYFILE_EXCL`, verify the read-back, commit the pointer, then delete the source. The `staged-verify-delete` `.moving` variant was **not** implemented.
- **Consequence:** `fs.renameSync` is never used to move a file between directories anywhere in this feature. Its only use is inside `writePointer`, where the tmp file and `storage.json` live in the same directory (one atomic name swap, no `EXDEV`).
- **Rationale:** a network share or a second drive is an explicit COMP-02 target and rename is same-filesystem only; a rename that partially succeeds is not "verify then delete".

## Files Created/Modified

- `src/main/exporter.js` — pure `csvField`, `toCsv` (BOM + CRLF), `historyRows`, `auditRows`; no fs, no Electron
- `src/main/storage.js` — `createStorage`, pure `samePath`, pointer shape `{version, dir, pendingDelete, move}`, `readPointer`/`currentDir`/`resolveStoreDir`, `verifyCopy`, `recoverMove`, `moveTo`, `finishPendingDelete`; every pointer write is tmp + rename in one directory
- `src/main/store.js` — `setFile(nextFile)` only; legacy `voice-flow.json` adoption stays anchored at app data
- `src/main/main.js` — `createStorage` + `resolveStoreDir()` before `new Store({ dir })`, ledger beside the resolved store, `vf:choose-storage-dir`, `vf:move-storage`, `moveStorage` (flush → move → setFile → flush → `info` with `kind: 'storage'`)
- `src/main/dashboard.js` — `_privacyFacts()` derives `storeDir` from `store.file` on every call
- `src/dashboard/app.js` — an `info` event with `kind === 'storage'` triggers `loadState()`
- `src/renderer/settings.html` — Storage section: `storagePath`, `changeStorage`, `storageStatus`, and the logs / per-user key / uninstall help copy
- `src/renderer/settingsRenderer.js` — `changeStorage()` (picker → move → write `result.dir` into `storagePath` → message), `loadDataInfo()` now targets `storagePath`
- `src/renderer/settingsPreload.js` — `chooseStorageDir`, `moveStorage`
- `test/storage.test.js` — 15 tests: default/corrupt/normalised pointers, a full move, every refusal, and all four seeded crash windows plus the already-cleaned directory
- `test/exporter.test.js` — BOM bytes, quoting, formula guard, ISO dates, row counts, audit has no transcript text
- `test/dashboard.test.js`, `test/page.test.js`, `test/store.test.js` — storeDir follows a move, settings markup/id/help-copy/post-move rewrite/storage-event checks, `setFile` writes in the new folder

## Decisions Made

- **D-14 = `copy-verify-delete`.** No `.moving` staged files; rename is confined to publishing the pointer inside one directory.
- **One validation path.** `moveTo` owns every rejection so the IPC handler cannot drift into a second, weaker check.
- **The move journal is not authority.** `dir` and `pendingDelete` change together only in the commit that follows verification.
- **The storage event is path-free.** The persisted event log cannot reveal the user's folder layout.
- **Settings owns the folder control; the dashboard only states the fact.** The dashboard can open Settings but never changes storage.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Rejected a target that *contains* the app-data folder**
- **Found during:** Task 3 (storage relocation)
- **Issue:** The plan required rejecting a target inside `userDataDir`. The reverse case — choosing `%APPDATA%` itself — would place the record above the pointer and logs folder and make the "logs stay in app data" promise confusing, and a future cleanup could be reasoned about wrongly.
- **Fix:** `moveTo` also refuses when `userDataDir` is inside the resolved target, with a message that says why.
- **Files modified:** `src/main/storage.js`
- **Verification:** All storage tests still green; no legitimate test fixture crosses that boundary.
- **Committed in:** `946bb4a`

**2. [Rule 2 - Missing Critical] A locked old file keeps its `pendingDelete` entry**
- **Found during:** Task 3 (storage relocation)
- **Issue:** The plan said `finishPendingDelete` ends by rewriting the pointer with `pendingDelete: []`. Written literally, a `rmSync` that throws (a file still held by another process) would drop the entry anyway, leaving a silent second copy — the exact thing D-14 forbids.
- **Fix:** Only entries whose removal actually succeeded are cleared; a failed removal is kept for the next launch's retry. The clean path still writes `pendingDelete: []`.
- **Files modified:** `src/main/storage.js`
- **Verification:** The already-absent-directory test still clears the list; the verified-sweep test still deletes the other copy.
- **Committed in:** `946bb4a`

**3. [Rule 1 - Bug] Moved the "Data folder" row from Retention into the new Storage section**
- **Found during:** Task 3 (Settings panel)
- **Issue:** Leaving the old read-only `dataInfo` row in Retention while adding `storagePath` in Storage would show the same folder twice and leave two ids to keep in sync.
- **Fix:** `loadDataInfo()` now writes `storagePath`; the duplicate row was removed.
- **Files modified:** `src/renderer/settings.html`, `src/renderer/settingsRenderer.js`
- **Verification:** `test/page.test.js` id-coverage test confirms every lookup resolves.
- **Committed in:** `946bb4a`

---

**Total deviations:** 3 auto-fixed (2 missing critical, 1 bug)
**Impact on plan:** No scope creep. Both storage fixes strengthen the D-14 guarantee the plan asks for; the Settings change removes a duplicated fact.

## Issues Encountered

- Task 1's `test/exporter.test.js` and Task 3's suites were run independently before the full run; `npm test` then reported 164 passing with zero failures, so no retry loop was needed.

## Known Stubs

None — no placeholder values, no unwired data sources. The folder picker, the move, the pointer recovery and the exports all read and write real files in the tests.

## Threat Flags

None — no new network surface. The move accepts a path from a renderer but re-validates it as untrusted input inside `moveTo` (T-01-12), and no transcripts or paths are added to any exported or persisted payload.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- DATA-04, COMP-01 and COMP-02 are complete; all seven plan deliverables have passing automated evidence.
- Manual UAT still worth doing at a Windows desktop: open a CSV in Excel, move storage to a second drive, and kill the app between copy and commit.
- The pointer file must be part of Phase 2's data-flow statement (it records the chosen folder, never transcripts), and the uninstall-survival fact is stated in Settings only.

---
*Phase: 01-data-ownership*
*Completed: 2026-10-22*

## Self-Check: PASSED

- Files: `src/main/storage.js`, `test/storage.test.js`, `src/main/exporter.js`, `test/exporter.test.js`, `src/renderer/settings.html`, `test/page.test.js`, `.planning/phases/01-data-ownership/01-03-SUMMARY.md` — all found.
- Commits: `a3869cb` (task 1), `946bb4a` (task 3) — both verified as ancestors of HEAD.
- Tests: `npm test` 164 pass / 0 fail; `npm run test:dashboard` 27 pass / 0 fail.
