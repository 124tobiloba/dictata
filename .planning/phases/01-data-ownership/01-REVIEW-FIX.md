---
phase: 01
fixed_at: 2026-10-22T16:40:00Z
review_path: .planning/phases/01-data-ownership/01-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 1: Code Review Fix Report

**Fixed at:** 2026-10-22T16:40:00Z
**Source review:** `.planning/phases/01-data-ownership/01-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 5 (1 critical, 4 warnings)
- Fixed: 5
- Skipped: 0
- Info findings: deliberately not applied (out of scope for this run)

## Fixed Issues

### CR-01: A relocated store that is unavailable at launch is silently replaced by an empty record

**Files modified:** `src/main/store.js`, `src/main/main.js`, `test/store.test.js`
**Commit:** `0e212ef`
**Applied fix:**

- `Store` now records whether `dictata.json` was actually found (`fileFound`) and distinguishes "file absent" from "file present but corrupt". When a `defaultDir` is supplied and the resolved `dir` differs from it while the record is absent, the store is created `readonly`.
- `readonly` suppresses the debounced save, `_writeNow()` (logging once with the folder path) and `flush()`, so `before-quit` can no longer rewrite an empty record. `getOrCreateToken()` still creates a session token but cannot persist it until the folder returns.
- `main.js` computes `storeUnavailable` from `resolveStoreDir()` + `fs.existsSync`, passes `readonly` explicitly, publishes a `kind: 'storage'` error event, and after the tray exists surfaces `STORE_UNAVAILABLE_MESSAGE` (cause + remedy) through the tray balloon and an error dialog. The first-run API-key prompt is skipped while the folder is unavailable.
- Normal first-run behaviour inside `userData` is unchanged: only a *relocated* folder with no record becomes read-only.
- Regression tests: `an unavailable relocated store never writes an empty record` (exercises token save, history add, settings update and `flush`, then asserts no `dictata.json` appears), plus default-folder-stays-writable and reachable-relocated-store cases.

### WR-01: A mid-copy failure leaves a partial `dictata.json` at the target and blocks every retry

**Files modified:** `src/main/storage.js`, `test/storage.test.js`
**Commit:** `5476be1`
**Applied fix:**

- `moveTo` registers each filename in `created` **before** calling `copyFileSync`. A copy that throws mid-write is now removed by the existing catch, so the target no longer holds a partial record that the "already contains a record" guard would refuse forever.
- `removeMoveFiles()` now returns the files it could not remove (exceptions and silent no-ops) instead of swallowing them.
- `recoverMove` keeps the `move` journal and logs a warning when the partial files cannot be removed (offline share, locked handle), so the next launch retries instead of clearing the journal and stranding debris.
- Regression tests: a simulated mid-copy throw asserts the partial target is discarded and the same folder is retried successfully; a simulated `rmSync` failure asserts the journal is kept.

### WR-02: Storage recovery runs before the single-instance lock

**Files modified:** `src/main/main.js`, `test/storage.test.js`
**Commit:** `67b20d5`
**Applied fix:**

- `app.requestSingleInstanceLock()` is now taken immediately after `migrateUserData()` and before `createStorage()` / `resolveStoreDir()`. A second copy exits before it can commit a move, rewrite `storage.json` or delete files.
- The now-duplicated later lock block was removed; the retention-sweep comment about running after the lock remains accurate.
- Regression test: a static source-order assertion that the lock precedes both `createStorage(` and `storage.resolveStoreDir()`. (`main.js` cannot be imported without Electron; the ordering is the property under test.)

### WR-03: An events-only retention expiry never reaches an open dashboard (D-05)

**Files modified:** `src/main/retention.js`, `src/main/main.js`, `test/retention.test.js`
**Commit:** `58c7489`
**Applied fix:**

- Added pure `sweepSummary({ historyRemoved, eventsRemoved, days })`, which returns `null` only when both counts are zero and otherwise produces wording that covers dictations, old activities, or both.
- `sweepRetention` now calls `notifyHistory()`, `updateTrayMenu()` and publishes the `info` event whenever that summary is non-null — so an events-only expiry reaches an open dashboard, and a retention setting change with only event expiry is no longer silent.
- Regression tests cover all four count combinations and assert `main.js` uses `sweepSummary` with `expiredEventIds.length` and no longer gates the notification on `removed`.

### WR-04: `computeStats` and `summarize` use different word reductions (D-06)

**Files modified:** `src/main/analytics.js`, `test/analytics.test.js`
**Commit:** `f51cbd5`
**Applied fix:**

- Added one private `wordsOf(h)` reduction: the stored `words` count when finite, otherwise a recount of `cleaned || raw`.
- `computeStats`, `summarize().totals.words`, the seven-day word buckets and `totals.todayWords` all use it, so `lifetimeWords` (from `stats.words`) cannot drift from the page total.
- Regression test uses a deliberately stale `words: 2` on five words of text and asserts `computeStats().words`, `totals.words`, `lifetimeWords`, `todayWords` and the per-day bucket all agree.

## Skipped Issues

None — all five in-scope findings were fixed.

## Verification

- `npm test`: **173 pass, 0 fail** (baseline 164; +9 regression tests).
- `npm run test:dashboard`: **27 pass, 0 fail** (baseline 27; unchanged).
- Syntax checks: `node --check` on every modified source file.
- **Where the gates ran:** inside the isolated git worktree `.claude/worktrees/rf-01-22404-1792689226` (branch `gsd-reviewfix/01-22404`). `node_modules` resolved from the main checkout one level up; no dependency changes were made, so the same results are reproducible from the main checkout after the branch is fast-forwarded.
- The Electron-only user-facing notification added for CR-01 (tray balloon + error dialog + bus event) is not covered by an automated test because `main.js` needs an Electron display; the data-loss guard itself (`Store` read-only behaviour) is covered.

## Notes

- Info findings IN-01…IN-08 were intentionally left untouched per the run scope. IN-01 (duplicated JSDoc on `clearAllData`) and IN-05 (retention sweep inside the pipeline `try`) remain visible in the source.
- One commit per finding; the only shared file between findings is `src/main/main.js` (CR-01, WR-02, WR-03), and each commit contains only the edits for its own finding.

---

_Fixed: 2026-10-22T16:40:00Z_
_Fixer: the agent (gsd-code-fixer)_
_Iteration: 1_
