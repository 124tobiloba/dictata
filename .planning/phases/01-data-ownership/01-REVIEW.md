---
phase: 01
reviewed: 2026-10-22T17:09:47Z
depth: standard
files_reviewed: 25
files_reviewed_list:
  - src/main/events.js
  - src/main/analytics.js
  - src/main/store.js
  - src/main/dashboard.js
  - src/main/main.js
  - src/main/retention.js
  - src/main/ledger.js
  - src/main/exporter.js
  - src/main/storage.js
  - src/dashboard/app.js
  - src/dashboard/index.html
  - src/dashboard/styles.css
  - src/renderer/historyRenderer.js
  - src/renderer/settings.html
  - src/renderer/settingsRenderer.js
  - src/renderer/settingsPreload.js
  - test/events.test.js
  - test/analytics.test.js
  - test/store.test.js
  - test/dashboard.test.js
  - test/retention.test.js
  - test/ledger.test.js
  - test/exporter.test.js
  - test/storage.test.js
  - test/page.test.js
findings:
  critical: 1
  warning: 4
  info: 8
  total: 13
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-10-22T17:09:47Z
**Depth:** standard
**Files Reviewed:** 25
**Status:** issues_found

## Summary

The phase delivers its four promises in the ordinary path, and several of the riskier properties are genuinely enforced rather than asserted: `stats` is derived from the surviving history everywhere (`computeStats` in the constructor, `addHistory` after the 500-row truncation, `purgeEntryData`, `purgeExpiredData`, zeroed by `clearAllData`), destructive mutations flush synchronously, the delete/clear routes sit behind the Host allowlist and the token with the raw (undecoded) path segment gated by `validRowId`, the ledger's allow-list sanitiser makes transcript text structurally unable to reach the audit file, and `storage.js` follows the journal → copy (`COPYFILE_EXCL`) → verify → single commit → delete contract with `path.relative` containment and tmp+rename pointer writes. `npm test` passes 164/164.

The one critical defect is not in the new move machinery but in what happens *after* a move: the resolved storage directory is trusted without checking that it still holds the record, so an unplugged drive or an offline share turns into a silent empty record that overwrites the real file as soon as the location returns. The warnings are: a failed in-process copy leaves a partial target that permanently blocks the retry the plan explicitly requires; storage recovery runs before the single-instance lock, so a second launch can mutate the first instance's record mid-move; an events-only retention expiry never reaches an open dashboard (D-05); and `computeStats`/`summarize` use two different word reductions despite the plan requiring one.

Delete/clear propagation itself survives scrutiny — the dashboard's `info` handler reaches `refreshAnalytics()` → `loadState()`, the `dictation` bus event carries the history UUID (payload spread wins over the generated id in `EventBus.publish`), and `rederiveLast()` covers the paste-last fallback — so I did not find a path where deleted text is re-pasted or re-served from a purged surface.

## Critical Issues

### CR-01: A relocated store that is unavailable at launch is silently replaced by an empty record

**File:** `src/main/main.js:86-92`, `src/main/store.js:228-234`, `src/main/store.js:236-271`

**Issue:** `resolveStoreDir()` returns `pointer.dir` unconditionally — it only validates that the *pointer* is well-formed, never that the directory it names still holds a `dictata.json`. `main.js` then builds `new Store({ dir: resolvedStoreDir })`; `Store._load()` cannot tell "no file yet" from "the file is gone", so it returns `mergeDefaults(null)` (empty history, zeroed stats). Two things then make the empty record durable:

1. `store.getOrCreateToken()` on line 102 of `main.js` finds no token and calls `_save()`, so `_writeNow()` runs ~150 ms after launch (`fs.mkdirSync(dirname, {recursive:true})` then `fs.renameSync(tmp, file)`), creating/overwriting `dictata.json` at the relocated path.
2. `app.on('before-quit')` unconditionally calls `store.flush()` (`main.js:181`), so quitting rewrites it again.

Reachable by ordinary user action, and the phase explicitly makes a second drive or a mapped share a supported destination (COMP-02): unplug a USB drive that holds the record (or let a network share mount late at boot) and launch Dictata. While the location is unreachable the writes fail and are swallowed by `_writeNow`'s `catch`; when the share mounts, the next write — a settings change, a dictation, or `before-quit` — replaces the real record with the empty in-memory document. That is data loss caused by the new feature: before this phase `Store` always pointed at the always-present `userData` folder.

**Why it matters:** It breaks D-14's one-way guarantee ("a half-finished move must never lose the record") and the phase's core promise that the record the user moved is the record the app reads.

**Fix:** Verify the record is present before treating the resolved directory as authoritative, and never let an unloaded store write:

```js
// main.js, after resolveStoreDir()
const storeFile = path.join(resolvedStoreDir, 'dictata.json');
const reachable = fs.existsSync(storeFile);
if (!reachable && !samePath(resolvedStoreDir, app.getPath('userData'))) {
  // The moved folder is gone/unmounted: do not start an empty record over it.
  notifyError(`Your dictation folder is unavailable (${resolvedStoreDir}) — reconnect it before Dictata saves anything.`);
}
const store = new Store({ dir: resolvedStoreDir, userDataDir: app.getPath('userData'), readonly: !reachable });
```

and in `store.js` make `readonly` suppress `_writeNow()` (log once instead), plus skip `getOrCreateToken()`'s save until the folder is reachable. At minimum, `_load()` must report whether the file was found and `main.js` must refuse to construct a writable store when it was not.

## Warnings

### WR-01: A mid-copy failure leaves a partial `dictata.json` at the target and blocks every retry

**File:** `src/main/storage.js:402-428`

**Issue:** `moveTo` records a file in `created` only *after* `fs.copyFileSync` returns (lines 406-410). If the copy itself throws mid-write — full disk, share dropped, antivirus lock — the partial `dictata.json` at `resolvedTarget` is not in `created`, so the catch block (lines 419-423) leaves it behind. The next attempt at that folder is then refused by the earlier guard at line 372 with "That folder already contains a Dictata record — choose an empty folder", permanently. Recovery handles the crash variant, but the *in-process* failure path does not.

**Why it matters:** The plan's success criterion for plan 03 is explicit: "A move interrupted mid-copy leaves the source intact, discards only the partial target, and lets the same folder be retried instead of being refused forever." The source is intact; the retry is not.

**Fix:** Because `moveTo` has already established the target holds no `dictata.json` (line 372), the catch may safely clear anything this call could have written:

```js
} catch (e) {
  console.warn('[storage] move failed:', e.message);
  removeMoveFiles(resolvedTarget);   // safe: the target held no dictata.json at entry
  try {
    writePointer({ ...pointer, move: null });
  } catch { /* ... */ }
  return refusal('The move could not be completed — your record is still in its original folder. Try again or choose another folder.');
}
```

(If you prefer the narrow form, push the name into `created` *before* each `copyFileSync`.)

The same "refused forever" symptom occurs in `recoverMove` (`storage.js:254`): if `removeMoveFiles` cannot remove the partial file (share offline), the error is swallowed by per-file `catch { }` and the journal is cleared anyway, so the stale `dictata.json` survives with no journal pointing at it. Only clear `move` when the partial files are actually gone, or record the leftover so `moveTo` can recognise its own debris.

### WR-02: Storage recovery runs before the single-instance lock, so a second launch can mutate the first instance's record mid-move

**File:** `src/main/main.js:86-87` (vs. `src/main/main.js:134-138`)

**Issue:** `createStorage(...)` + `storage.resolveStoreDir()` execute at module load, ~48 lines *before* `app.requestSingleInstanceLock()` is called. `resolveStoreDir()` is not read-only: it can commit a move, rewrite `storage.json`, and delete files (`recoverMove`, `finishPendingDelete`). The comment at `main.js:140-143` states the correct principle — the sweep runs after the lock "so a second copy never rewrites the record the running copy owns" — but the far more dangerous storage step does not follow it.

Concretely, if a second copy is launched while the first is between the journal write and its commit, the second copy's `recoverMove` fails verification, deletes the target files and clears `move`; the first copy's verification then fails too and its catch restores `{ ...pointer, move: null }` from its own pre-move snapshot — which can point `dir` back at a source whose files the second copy may already have removed. Result: the pointer names an empty directory while the record sits at the target (or vice versa), which is the "half-finished move" D-14 forbids.

**Why it matters:** Two ordinary user actions (double-click the shortcut twice, or a relaunch during auto-start) can interleave with a move; the fix is a one-line reordering and the code already argues for it elsewhere.

**Fix:** Move the lock above the storage block:

```js
if (!app.requestSingleInstanceLock()) {
  console.log('[dictata] Already running (check the system tray). Close it first, then run again.');
  app.quit();
  process.exit(0);
}

const storage = createStorage({ userDataDir: app.getPath('userData') });
const resolvedStoreDir = storage.resolveStoreDir();
```

### WR-03: An events-only retention expiry never reaches an open dashboard (D-05)

**File:** `src/main/main.js:710-731`

**Issue:** `sweepRetention` forgets expired *event* ids from the bus (`line 719`) and rewrites `store.events` via `pruneEvents`, but it publishes the `info` event — the only thing that makes an open dashboard reload — **only when a history row was removed** (`if (removed)`, line 723). When the sweep removes old failed attempts and no dictations (a user with 30-day retention whose error rows are older than their dictations), the row disappears from `/api/state` and from SSE replay but no event is emitted; `app.js`'s 5 s tick (`app.js:980-984`) only re-renders from the client's local `state`, so the expired failed attempt stays on screen until the tab is reloaded or another dictation fires.

The same hole applies to a setting change: `vf:set-retention` → `sweepRetention()` → nothing published → up to N dashboards keep serving a row the policy says is expired.

**Why it matters:** D-05 states "The dashboard must never show a row that the retention policy says is already expired." The durable surfaces agree; the visible one does not.

**Fix:** Treat either collection as a reason to notify and to bump the tray:

```js
const changed = removed > 0 || expiredEventIds.length > 0;
if (changed) {
  notifyHistory();
  updateTrayMenu();
  bus.publish('info', {
    message: removed
      ? `Expired ${removed} dictation${removed === 1 ? '' : 's'} older than ${days} days`
      : `Expired ${expiredEventIds.length} old activit${expiredEventIds.length === 1 ? 'y' : 'ies'} older than ${days} days`,
    kind: 'history',
  });
}
```

### WR-04: `computeStats` and `summarize` use different word reductions, so the stored total and the page total can disagree (D-06)

**File:** `src/main/analytics.js:57-65` and `src/main/analytics.js:93`

**Issue:** `computeStats` counts `Number.isFinite(h.words) ? h.words : wordCount(h.cleaned || h.raw)`, while `summarize().totals.words` always recounts `wordCount(h.cleaned || h.raw)`. Plan 01 required the opposite: "Use the same reduction `summarize()` uses for `totals.words` so the two cannot disagree (D-06: `lifetimeWords` must equal the words in the stored record)." `lifetimeWords` comes from `stats.words`, so any row whose stored `words` field does not match a recount of its `cleaned` text makes the stored record and the page disagree. That happens with hand-edited or partially migrated files, and with rows written by any future code path that sets `words` from a different source.

`test/analytics.test.js` cannot catch it because its fixtures are self-consistent by construction (the overridden `words: 2` matches `'four five'`).

**Why it matters:** Two numbers derived from the same data diverge silently; the stored counter is also exported and shown in the tray menu.

**Fix:** One reduction, used by both:

```js
/** The single word rule: the stored count when present, else a recount. */
function wordsOf(h) {
  return Number.isFinite(h.words) ? h.words : wordCount(h.cleaned || h.raw);
}

function computeStats(history = []) { /* uses wordsOf */ }

function summarize(...) {
  const words = entries.reduce((n, h) => n + wordsOf(h), 0);   // and the per-day bucket too
}
```

Then add a test fixture where `words` is deliberately stale and assert `computeStats(history).words === summarize({ history }).totals.words`.

## Info

### IN-01: Duplicated JSDoc block on `clearAllData`

**File:** `src/main/store.js:135-150`

The same doc comment is pasted twice above `clearAllData`; the first block is dead text attached to nothing.

**Fix:** Delete lines 135-142 (keep one block).

### IN-02: The retention change never tells the user what it deleted

**File:** `src/renderer/settingsRenderer.js:209-214`

`vf:set-retention` returns `{ retentionDays, removed }`, but the handler drops `removed`. Choosing "30 days" can delete hundreds of dictations instantly with no confirmation and no report — the one destructive action in the phase with zero feedback.

**Fix:** `if (result.removed) document.getElementById('storageStatus')` (or a privacy-status line) `= \`Removed ${result.removed} dictation(s) older than ${result.retentionDays} days.\``

### IN-03: `getPrivacyFacts` reports the raw stored retention value

**File:** `src/main/main.js:742-747`

`sweepRetention` normalises with `normalizeRetentionDays`, but the facts return `store.settings.retentionDays` unnormalised. A hand-edited `45` makes the dashboard state "Retention: 45 days" while nothing is ever swept (and the Settings `<select>` shows "Keep forever", because no option matches).

**Fix:** `retentionDays: normalizeRetentionDays(store.settings.retentionDays)`.

### IN-04: The DELETE routes have no Origin guard, unlike the POST

**File:** `src/main/dashboard.js:218-233`

`POST /api/settings/open` checks `_originAllowed` (line 246) because "a token in the URL does not prove a browser page is ours". The two DELETE branches rely on the token alone. Today a cross-origin DELETE is blocked only *incidentally*: the server sends no CORS headers and the `OPTIONS` preflight falls through to the static 404. That is a fragile guarantee for the two most destructive routes in the app.

**Fix:** Call `this._originAllowed(req.headers.origin)` (403) in both DELETE branches, right after `_authorised`, and add a dashboard test mirroring "a cross-site POST cannot open settings".

### IN-05: The retention sweep sits inside the pipeline `try`, so a maintenance failure is reported as a failed dictation

**File:** `src/main/main.js:525` (inside the `try` at 455-554, catch at 554-574)

`sweepRetention()` runs after the text was already pasted. If it throws, the `catch` publishes `{ kind: 'api', fatal: true }`, shows an error balloon, and appends a second, `failed` audit row for a dictation that actually succeeded (`errorKind: 'api'`) — on top of the `pasted` row written moments earlier. The repo already has the right pattern for this (`appendAudit` wraps the ledger for exactly this reason).

**Fix:** `try { sweepRetention(); } catch (e) { console.warn('[pipeline] retention sweep failed:', e.message); }`, or move the call after `notifyHistory()`.

### IN-06: Several new page tests pass if the feature is a no-op

**File:** `test/page.test.js:94-96`, `test/page.test.js:170-177`

`assert.match(js, /class="rec-del"/)` and `/Delete all \$\{num\(count\)\} dictation/` assert that a *string literal* exists in `app.js`; they pass unchanged if `deleteButton()` is never called from either row branch or if `renderClearConfirm` is never invoked. Likewise `/moved[\s\S]{0,400}textContent = result\.dir/` passes if the assignment is in a dead branch.

**Fix:** Assert wiring, not literals, e.g. `assert.equal((js.match(/\$\{deleteButton\(e\.id\)\}/g) || []).length, 2, 'both row branches render the affordance')`, and `assert.match(js, /renderHistory\(entries\);/)` for the clear-count path.

### IN-07: Retention wiring in `main.js` is untested

**File:** `test/retention.test.js` (pure helpers only), `test/store.test.js` (data helpers only)

The load-bearing parts of D-05 live in unexercised glue: the three call sites (launch, after each dictation, on setting change) and the union `bus.forgetMany([...expiredIds, ...expiredEventIds])` at `main.js:719` — the only thing that stops an expired failed attempt reappearing from the live buffer. Nothing in the suite would fail if any of them were deleted (main.js is unimportable without Electron). At least extract `sweepRetention`'s decision into a pure helper (`planSweep(snapshot, cutoff) → { historyIds, eventIds }`) and test that, so the union is provable.

### IN-08: `/api/state` and `/api/events` are matched before any method check

**File:** `src/main/dashboard.js:208-216`

Both branches match on pathname only, so `DELETE /api/state` returns a state snapshot and `POST /api/events` opens an SSE stream. Neither mutates anything, but it undercuts the "method + path matched before dispatch" rule the new DELETE routes follow.

**Fix:** Add `req.method === 'GET' &&` to both conditions.

---

**Verdict:** The destructive half of this phase is sound in the paths a user walks: delete and clear reach the store, the disk (synchronously), the live bus, the derived stats, the paste-last pointer and both UI surfaces through one mutation function, the ledger's allow-list makes the audit file structurally text-free, and the move machinery is careful about journal ordering, verification-before-delete and never deleting the resolved directory. What it does not yet survive is the *absence* of the record it moved: CR-01 turns an unplugged drive or a late-mounting share into a silent empty store that overwrites the real file, which is the one failure mode this phase exists to rule out. Fix CR-01 and WR-02 (both small, local changes) before shipping, then the four warnings — the retry-blocking partial target, the dashboard's blind spot for events-only expiry, and the duplicated word reduction — which are all contained and each backed by a concrete failing scenario.

---

_Reviewed: 2026-10-22T17:09:47Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
