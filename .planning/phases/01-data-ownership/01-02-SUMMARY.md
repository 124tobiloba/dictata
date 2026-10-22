---
phase: 01-data-ownership
plan: 02
subsystem: data-ownership
tags: [electron, vanilla-js, retention, audit-ledger, ndjson, node-test]

# Dependency graph
requires:
  - phase: 01-01
    provides: flushed destructive mutation path, derived stats, bus forget, purge/clear callbacks
provides:
  - `retention.js` — RETENTION_CHOICES, normalizeRetentionDays, DST-safe cutoffFor, splitExpired, splitExpiredEvents
  - store retention defaults plus `purgeExpiredData`/`pruneEventsData` (pure) and `purgeExpired`/`pruneEvents`
  - `main.sweepRetention` on launch, after every dictation and on setting change — no timer
  - Settings "Privacy & Data" panel owning the retention select and the audit clear action
  - dashboard read-only privacy facts and token-checked `POST /api/settings/open`
  - `ledger.js` — metadata-only NDJSON sidecar, allow-list sanitisation, cached count, explicit clear
  - an executable D-11 invariant: a purged transcript leaves no text while its audit row survives
affects: [01-03 export + storage relocation, Phase 2 privacy docs]

# Actuals (#2632) — same chars/4 scale as the plan estimate.
actuals:
  tokens: 46157
  tasks: 4
  commits: 3
plan_head_before: 86f044d9e54d8f7707ef23d948532d7043e9024d
plan_head_after: f0707dcc034f146d593949ab2bf1023f3e0c6933

# Tech tracking
tech-stack:
  added: []
  patterns:
    - call-site-driven sweep (launch / after dictation / on change) instead of a timer
    - one snapshot, two splitters, one id union forgotten from the live bus
    - append-only NDJSON sidecar separate from `dictata.json`
    - in-memory counter as the only source of the audit count
    - allow-list sanitisation at the audit write boundary

key-files:
  created:
    - src/main/retention.js
    - src/main/ledger.js
    - test/retention.test.js
    - test/ledger.test.js
  modified:
    - src/main/store.js
    - src/main/main.js
    - src/main/dashboard.js
    - src/renderer/settings.html
    - src/renderer/settingsRenderer.js
    - src/renderer/settingsPreload.js
    - src/dashboard/index.html
    - src/dashboard/app.js
    - test/store.test.js
    - test/dashboard.test.js
    - test/page.test.js

key-decisions:
  - "D-11 = survives-with-invariant-test: every transcript path is physically unable to open the ledger file, and the cross-path invariant test makes the survival executable in CI. No runtime count guard in purgeEntry/clearAll — the destructive path stays free of ledger I/O."
  - "The audit ledger is a separate `dictata-audit.ndjson` sidecar beside the store, so an append never rewrites settings and one corrupt row cannot poison the document."
  - "Outcome vocabulary is exactly `pasted` | `failed`. A transcription that could not paste records `failed` with `errorKind: 'paste'`; no `copied` value exists anywhere."
  - "Cancellations are not audit rows: no transcription was requested, so there is no attempt to audit."
  - "Retention is call-site driven (D-05): launch, after each dictation and on setting change. No timer is introduced."
  - "The audit count served to Settings and the dashboard is the ledger's cached number — `/api/state` never parses the ledger."

patterns-established:
  - "Expiry moves the file and the live bus together: `splitExpired` + `splitExpiredEvents` share one cutoff and one `bus.forgetMany` union."
  - "Audit writes swallow their own errors (`logger.write` rule) so a ledger failure cannot reach the dictation pipeline."
  - "The invariant test seeds history and ledger with the same id, purges, and asserts zero transcript characters while the row remains."

requirements-completed: [DATA-05]
requirements-deferred:
  - "COMP-01 — the audit data model and clear action are complete here; the export file itself lands in 01-03, so the requirement stays open in REQUIREMENTS.md."

coverage:
  - id: R1
    description: "Retention offers exactly keep-forever / 30 / 90 / 365, keep-forever is the upgrade default, and a chosen window is swept on launch, after each dictation and immediately on change."
    requirement: DATA-05
    verification:
      - kind: unit
        ref: "test/retention.test.js#keep forever is the fallback for anything unrecognised"
        status: pass
      - kind: unit
        ref: "test/retention.test.js#a 30-day window at a fixed clock"
        status: pass
      - kind: unit
        ref: "test/store.test.js#an existing install upgrades with retention set to keep forever"
        status: pass
      - kind: integration
        ref: "test/dashboard.test.js#the state payload carries the read-only privacy facts"
        status: pass
    human_judgment: false
  - id: R2
    description: "Expired transcripts and expired failed attempts leave history, persisted events and the live event bus together, so no expired row can render on any surface."
    requirement: DATA-05
    verification:
      - kind: unit
        ref: "test/retention.test.js#splitExpired keeps a row stamped exactly at the cutoff"
        status: pass
      - kind: unit
        ref: "test/retention.test.js#splitExpiredEvents expires an old event and keeps a boundary-equal one"
        status: pass
      - kind: unit
        ref: "test/store.test.js#purging expired rows recomputes stats and touches nothing else"
        status: pass
      - kind: unit
        ref: "test/store.test.js#pruning persisted events cuts by timestamp and keeps the rest"
        status: pass
    human_judgment: false
  - id: R3
    description: "The dashboard shows retention, storage path and audit count as read-only facts and opens Settings through a token-checked POST that never mutates the store."
    requirement: DATA-05
    verification:
      - kind: integration
        ref: "test/dashboard.test.js#the state payload carries the read-only privacy facts"
        status: pass
      - kind: integration
        ref: "test/dashboard.test.js#opening settings without a token never reaches the callback"
        status: pass
      - kind: integration
        ref: "test/dashboard.test.js#a cross-site POST cannot open settings"
        status: pass
      - kind: unit
        ref: "test/page.test.js#the dashboard states the retention policy as read-only facts"
        status: pass
    human_judgment: true
    rationale: "The rendered facts block and the Open Settings click-through are visual/browser behaviours; the tests prove the markup and the route contract, not the look."
  - id: R4
    description: "Every successful or failed dictation appends exactly one metadata-only audit row that survives deleting the transcript and carries no transcript text."
    requirement: COMP-01
    verification:
      - kind: unit
        ref: "test/ledger.test.js#a persisted row never carries transcript text"
        status: pass
      - kind: unit
        ref: "test/ledger.test.js#D-11 invariant: a purged transcript leaves no text, the audit row survives"
        status: pass
      - kind: unit
        ref: "test/ledger.test.js#append and read round-trip"
        status: pass
    human_judgment: false
  - id: R5
    description: "Audit outcomes are exactly pasted or failed; a transcription that could not paste is failed with errorKind paste; a cancel leaves no row; unknown values clamp to failed."
    requirement: COMP-01
    verification:
      - kind: unit
        ref: "test/ledger.test.js#the outcome vocabulary is exactly pasted or failed"
        status: pass
      - kind: unit
        ref: "test/ledger.test.js#an unknown outcome is clamped to failed"
        status: pass
      - kind: unit
        ref: "test/ledger.test.js#sanitizeRow keeps the allow-list only and drops undefined values"
        status: pass
    human_judgment: false
  - id: R6
    description: "The audit log shrinks only through its own confirmed clear action; retention and transcript deletion never touch it, and the count is served from memory rather than a ledger parse."
    requirement: COMP-01
    verification:
      - kind: unit
        ref: "test/ledger.test.js#clear leaves zero rows and zeroes the count"
        status: pass
      - kind: unit
        ref: "test/ledger.test.js#the count is cached, not re-read from the file"
        status: pass
      - kind: unit
        ref: "test/ledger.test.js#a trailing partial line is ignored"
        status: pass
      - kind: unit
        ref: "test/ledger.test.js#a corrupt line is skipped, not thrown"
        status: pass
    human_judgment: true
    rationale: "The clear confirmation wording (naming the count and stating transcripts are untouched) needs a human to read and click."
  - id: R7
    description: "An audit row that cannot be written does not change the count and never breaks dictation."
    requirement: COMP-01
    verification:
      - kind: unit
        ref: "test/ledger.test.js#a failing write is swallowed and does not inflate the count"
        status: pass
    human_judgment: false

# Metrics
duration: 90min
completed: 2026-10-22
status: complete
---

# Phase 1 Plan 2: Data Ownership Summary

**A retention window that sweeps transcripts and failed attempts from every surface, plus a metadata-only audit ledger that survives them — with D-11 survival proven by an invariant test**

## Performance

- **Duration:** ~90 min (includes the D-11 blocking-human checkpoint pause)
- **Started:** 2026-10-22T13:47:54Z
- **Completed:** 2026-10-22T15:17:38Z
- **Tasks:** 4 (3 auto commits + 1 decision checkpoint)
- **Files modified:** 15 (4 created, 11 modified)
- **Tests:** `npm test` 119 → 132 passing; `npm run test:dashboard` 26 → 26 passing

## Accomplishments

- **Retention is real and default-safe.** `retention.js` is pure and clock-injectable; keep-forever (`0`) is the upgrade default and `cutoffFor(0) === null` makes the sweep a no-op, so an existing install loses nothing on upgrade.
- **Expiry moves both surfaces at once.** One snapshot feeds `splitExpired` (history) and `splitExpiredEvents` (persisted error events) at the same cutoff; the union of expired ids is forgotten from the live bus, so an expired failed attempt cannot linger in `/api/state` or SSE until a restart.
- **Sweep timing is call-site driven (D-05).** Launch (before the dashboard is wired), after every `store.addHistory(entry)` and before the `dictation` publish, and from `vf:update-settings` when `retentionDays` is patched. No timer exists.
- **The facts are read-only, the control is Settings.** The dashboard renders retention, storage path and audit count with `textContent` and can only open Settings through a token- and Origin-checked `POST /api/settings/open`; the Settings window owns the `0/30/90/365` select and the audit clear confirmation.
- **The audit ledger is metadata-only by construction.** `sanitizeRow` keeps exactly `ts,id,outcome,targetApp,durationMs,words,model,errorKind`. A failed paste records `failed` + `errorKind: 'paste'`, a pipeline failure records `failed` + `errorKind: 'api'`, and a cancel records nothing.
- **D-11 survival is executable.** The invariant test seeds one history row and one ledger row with the same id, runs `purgeEntryData`, and asserts zero transcript characters remain in the persisted record while the ledger still returns exactly one row for that id.
- **Counts never parse the ledger.** `count()` is an in-memory number initialised once, incremented after a successful append, zeroed by `clear` and recomputed by `setFile`; the truncate-behind-its-back test fails if `count()` re-reads the file.

## Task Commits

Each task was committed atomically:

1. **Task 1: Retention core — sweep expired transcripts and expired events** — `06761dc` (feat)
2. **Task 2: Retention surface — read-only facts, Open Settings, retention control** — `a85e45e` (feat)
3. **Task 3: D-11 checkpoint (decision)** — resolved by the user, no commit
4. **Task 4: Metadata-only audit ledger with its own clear action** — `f0707dc` (feat)

**Plan metadata:** pending (docs: complete plan)

## D-11 Decision Record

- **Selected:** `survives-with-invariant-test`
- **Rationale:** every transcript path is physically unable to open the ledger file, and the cross-path invariant test makes the guarantee executable in CI.
- **Rejected:** `survives-with-runtime-guard` — it would read the ledger on every destructive action and add a code path whose only job is to complain.
- **Consequence honoured:** `purgeEntry`/`clearAll` perform **no** ledger I/O and **no** count comparison. The ledger count is an in-memory counter; the destructive path stays free of the ledger entirely.

## Files Created/Modified

- `src/main/retention.js` — `RETENTION_CHOICES`, `normalizeRetentionDays`, `cutoffFor` (`setDate`, DST-safe), `splitExpired`, `splitExpiredEvents`
- `src/main/ledger.js` — `LEDGER_FIELDS`, `OUTCOMES`, pure `sanitizeRow`, `createLedger` with `append/read/count/clear/setFile`, error-swallowing writes, cached count
- `src/main/store.js` — `retentionDays: 0` default, clamped in `updateSettings`, pure `purgeExpiredData`/`pruneEventsData` plus `purgeExpired`/`pruneEvents`
- `src/main/main.js` — `sweepRetention` (one snapshot, both splitters, bus union), `ledger` singleton beside the store, `appendAudit` on success/failure, `auditCount` from the cache, `vf:clear-audit`
- `src/main/dashboard.js` — `privacy` in `_state()`, injected `getPrivacyFacts`/`onOpenSettings`, token/Origin-checked `POST /api/settings/open`
- `src/renderer/settings.html` — Privacy & Data panel: retention select, data folder, Audit log section with count, metadata-only copy and clear control
- `src/renderer/settingsRenderer.js` — `loadPrivacy`/`loadDataInfo`/`renderAuditCount`/`clearAuditLog` (count-naming confirmation)
- `src/renderer/settingsPreload.js` — `setRetention`, `dataInfo`, `clearAudit` bridge methods
- `src/dashboard/index.html` / `src/dashboard/app.js` — read-only facts block, Open Settings button, relative-URL POST
- `test/retention.test.js` — cutoff/DST/boundary/splitter/clamping cases
- `test/ledger.test.js` — allow-list, vocabulary, round-trip, partial/corrupt lines, clear, cached count, `setFile`, failing write, D-11 invariant
- `test/store.test.js`, `test/dashboard.test.js`, `test/page.test.js` — retention defaults/pure mutators, privacy facts and open-settings route, markup lookups

## Decisions Made

- **D-11 = `survives-with-invariant-test`.** Structure, not a runtime guard, enforces the separation; the invariant test is the executable proof.
- **Outcome vocabulary is closed at two values.** `errorKind` carries "pasted or not" detail; `copied` is not a value anywhere.
- **Cancels are not audited.** The `Cancelled` branch returns before any append because no transcription was requested.
- **The ledger is a sidecar, not part of `dictata.json`.** Append-only writes never rewrite settings, and one corrupt row cannot poison the store document.
- **The audit count is cached.** Settings and `/api/state` read the in-memory number; `read()` serves export only (plan 03).
- **Retention never touches the ledger.** Only `vf:clear-audit` truncates it, and its confirmation names the count and states transcripts are untouched.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Recovery of the plan commit ledger**
- **Found during:** SUMMARY preparation
- **Issue:** The previous executor stopped at the D-11 checkpoint without writing the `gsd-plan-head-before-01-02` ledger, so the measured commit count had no base.
- **Fix:** Reconstructed the base from git history (`86f044d`, the commit immediately before the first plan-02 task) so `commits` is measured rather than narrated.
- **Files modified:** git dir metadata only (no tracked file)
- **Commit:** none

No other deviations — tasks 1, 2 and 4 executed as written; the checkpoint was resolved by explicit user selection.

## Authentication Gates

None.

## Known Stubs

None. Every value rendered by the Privacy & Data panel and the dashboard facts block is wired to a real source (`store.settings.retentionDays`, `path.dirname(store.file)`, `ledger.count()`).

## Deferred Issues

- Manual verification items from the plan's `<verification>` block (upgrade preserves history, old-row sweep across dashboard/feed/History, audit survives a delete, cancel leaves the count unchanged, Open Settings click-through) remain for `/gsd-verify-work` — they require the packaged app and a microphone.

## Self-Check: PASSED
