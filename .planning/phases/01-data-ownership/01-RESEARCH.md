# Phase 1: Data Ownership — Research

**Researched:** 2026-10-22
**Domain:** Local-first Electron persistence, deletion semantics across four surfaces, retention, storage relocation, CSV/JSON export, metadata-only audit ledger
**Confidence:** HIGH on the codebase facts (every claim below was read in `src/` this session); MEDIUM on the two external standards (RFC 4180, OWASP CSV injection — both fetched); LOW/ASSUMED on Windows cross-volume move behaviour and Excel's BOM heuristics.

## Summary

Phase 1 is not a greenfield feature build — it is a **correctness repair plus four new surfaces** on top of a store that already works. The single most important discovery is that "deleted" currently means four different things in four places: `store.deleteHistory()` only filters `data.history` (`src/main/store.js:191-194`), the live `EventBus` keeps the dictation event forever (`src/main/events.js:44-47`), `collectEvents()` re-derives a feed row from that event (`src/main/dashboard.js:46-70`), and the browser keeps both copies in `state.history` / `state.events` (`src/dashboard/app.js:18-29`). A delete that touches only the first of those four resurrects the row on the next `/api/state`, and — separately — the in-memory `lastCleaned` string still lets the user re-paste the deleted text via the `paste-last` hotkey (`src/main/main.js:334-337`).

The second discovery is that the stats drift the phase must fix is a **direct consequence of a stored counter being incremented while the list it counts is capped and truncated**. `addHistory` does `stats.words += words` (`src/main/store.js:184-187`) while `HISTORY_LIMIT = 500` silently drops rows (`src/main/store.js:46`, `183`). The fix is not a better decrement — it is to make `stats` a *derived value* recomputed from `data.history` on every mutation and once at load, at which point `lifetimeWords` (`src/main/analytics.js:129`) necessarily equals the visible record, which is exactly what D-06 demands.

The third is architectural: **the dashboard is an external browser page, not a renderer.** It has no preload, no `window.vf`, and no IPC (`src/main/main.js:284-292` opens it with `shell.openExternal`). D-02's "button that opens Settings" therefore cannot be an IPC call — it has to be a token-checked HTTP route that the main process turns into `createSettingsWindow()`. Everything else in D-01/D-02 follows from that fact.

The fourth is a durability hole that would fail success criterion 2 ("including after a restart"): `_save()` is debounced 150 ms (`src/main/store.js:126-141`) and `app.on('before-quit')` never flushes it (`src/main/main.js:149-154`). A delete followed by a quit inside that window resurrects the row. Destructive mutations must write **immediately**, and quit must flush.

**Primary recommendation:** Introduce one main-process mutation path — `purgeEntry(id)` / `clearAll()` / `sweepRetention()` — that (1) mutates the store synchronously and writes immediately, (2) recomputes `stats` from the surviving history, (3) forgets the id from the `EventBus` ring buffer, (4) re-derives `lastCleaned`, (5) notifies the History window and the tray, and (6) publishes one `info` event so every open dashboard converges. Both the dashboard routes and the existing History-window IPC call that one path. Then layer export, the audit ledger, and storage relocation on pure, `node:test`-able helpers.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Where controls live**
- **D-01:** The **Settings window owns configuration** — a new "Privacy & Data" panel holds retention, storage location, and both export actions. The **dashboard owns acting on the record** — per-row delete and clear-all only. — **Reversibility:** costly — moving these controls later touches both the Settings renderer and the dashboard server/UI, and the folder-picker path only exists in the main process.
- **D-02:** The dashboard displays the current retention window and storage path as **read-only facts with a link/button that opens Settings** — never duplicated as an editable form.

**Retention**
- **D-03:** Default retention for an existing install is **keep forever**. Nothing is purged until the user opts into 30/90/365 days; the upgrade must not silently delete history.
- **D-04:** Retention options are exactly **30 / 90 / 365 days / keep forever**.
- **D-05:** Expiry is swept **on app launch and after each completed dictation** — no background timer, no dashboard-load-only purge. The dashboard must never show a row that the retention policy says is already expired.
- **D-06:** Deleting or expiring an entry **recomputes `stats` (words, sessions, msSpoken) from the remaining history**. This also fixes today's drift where the 500-entry cap drops rows but `stats.words` keeps climbing. `lifetimeWords` in analytics must equal the words in the stored record.

**Delete scope and safety**
- **D-07:** **Failed-attempt rows are deletable** with the same affordance. They exist only as `error` events (no history entry), so deletion must support both id spaces.
- **D-08:** Single delete uses an **inline two-step confirm**: a trash affordance that is invisible at rest, revealed on row hover / row focus / keyboard focus; first activation turns the row into `Delete this dictation? [Delete] [Cancel]`. No modal, no undo toast.
- **D-09:** A delete must purge **all four surfaces**: `store.history`, `store.events` (persisted), the `EventBus` in-memory buffer (so the row cannot be re-sent over SSE), and recompute `stats`. The in-app History window must reflect the deletion without a restart.
- **D-10:** Clear-all uses an explicit confirmation that names the count ("Delete all N dictations?"). It clears history, persisted events, and the live bus buffer, and zeroes stats — but **does not clear the audit ledger** (see D-11).

**Audit ledger and export**
- **D-11:** The audit log is a **separate metadata-only ledger**, persisted, containing timestamp, target app, duration, model, outcome (`pasted` / `failed`), and error kind when applicable. It contains **no transcript text, no raw audio, no partial text**. It **survives transcript deletion** — deleting text must not erase proof that a dictation happened. — **Reversibility:** one-way — once users rely on "deleted text, audit intact", folding the ledger back into history would silently destroy evidence.
- **D-12:** The ledger is kept **until explicitly cleared**, independent of the transcript retention window. A dedicated "Clear audit log" action (its own confirmation) is the only way it shrinks.
- **D-13:** History export ships **both JSON and CSV**, whole-record (no date-range picker in v1). The audit ledger has its own separate export in both formats. Export lives in Settings; files are written through a native save dialog (main process), not a browser download.

**Storage relocation**
- **D-14:** Pointing storage at a new folder **moves** the existing record: write the store to the new location, verify it reads back, then remove the old file. No silent second copy left behind. Settings persist a small pointer so the app can find the store next launch. — **Reversibility:** one-way — undoing requires moving user data back and repairing a pointer file; a half-finished move must never lose the record.
- **D-15:** Logs are diagnostics, not transcripts, and stay in `%APPDATA%\Dictata\logs` regardless of where transcripts live.

### the agent's Discretion

- Exact filenames, CSV column order, and export file naming convention.
- Whether the ledger lives inside `dictata.json` or its own sidecar file (planner/researcher to choose based on atomicity and move semantics).
- Copy for the confirmation prompts, empty states, and the "Privacy & Data" panel layout.
- Whether clear-all and per-row delete emit an `info` event afterwards (recommended: yes, so the user sees that the action succeeded).
- Keyboard shortcut for delete (if any).

### Deferred Ideas (OUT OF SCOPE)

- **Date-range export and scheduled exports** — useful for quarterly compliance packets, but a new capability; backlog for a later phase.
- **Encrypted-at-rest transcript store** (password/DPAPI-encrypted history file) — strong fit for regulated buyers, but a separate hardening phase.
- **Per-entry detail view / transcript copy button** — dashboard enhancement, not required for data ownership.
- **Audit ledger viewer UI** — v1 exports the ledger; browsing it in-app is a later feature.
- **Automatic retention policy from a team admin** — belongs to the future Teams/Pro tier.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DATA-01 | Delete a single dictation from the dashboard via an affordance hidden until hover/click | Q8 (affordance design, `.rec` grid), Q2 (what delete must actually touch), Q7 (DELETE route) |
| DATA-02 | Clear the entire history from the dashboard behind an explicit confirmation | Q2, Q3 (zeroing stats), Q7, D-10 copy requirements |
| DATA-03 | Deletion removes the row from history, feed, analytics, and the in-app History window — no resurrection after restart | Q2 (four surfaces + `lastCleaned` + debounce), Q3 (stats recompute) |
| DATA-04 | Export the full history as JSON and as CSV | Q6 (CSV correctness, BOM, formula guard), Q9-adjacent (where writes happen) |
| DATA-05 | Retention window (30/90/365/forever) with automatic purge of older transcripts | Q9 (sweep placement), Q3 (recompute after sweep) |
| COMP-01 | Export an audit log with timestamp, target app, duration, model, outcome — never transcript text | Q1 (what fields exist / are missing), Q10 (ledger storage) |
| COMP-02 | Point transcript storage at a different folder | Q4 (move + pointer + crash windows), Q5 (folder picker over contextIsolation) |
</phase_requirements>

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Per-row delete / clear-all trigger | Browser (dashboard page) | — | D-01 puts "acting on the record" in the dashboard; the page only *requests* a mutation |
| Delete/clear mutation + all-surface purge | API / main process (`purgeEntry`, `clearAll`) | — | Only the main process owns `Store`, `EventBus`, the tray, and the History window — one implementation prevents the two paths diverging |
| Stats recomputation | Pure module (`analytics.js`) | — | Must be callable from `Store` and from tests with no Electron |
| Retention maths | Pure module (`retention.js`) | Main process (scheduler of the sweep) | Pure = `node:test`-able; the *when* stays in `main.js` |
| Ledger append/read/clear | Main process (`ledger.js`, fs) | — | Unbounded sidecar; needs `fs`, must not be part of the debounced JSON store |
| Ledger/history export formatting | Pure module (`exporter.js`) | Main process (save dialog + write) | Formatting is testable; the dialog is not |
| Storage relocation | Main process (`storage.js` + `dialog`) | — | Needs `app.getPath`, `dialog.showOpenDialog`, and synchronous bootstrap ordering before `new Store()` |
| Retention/storage/export controls | Renderer (Settings) | Main process over IPC | D-01; the preload bridge is the only sanctioned channel (`contextIsolation: true`) |
| Read-only retention/storage facts | API (`/api/state`) | Browser renders | D-02 — dashboard must display, never edit |
| "Open Settings" from dashboard | API route → main-process callback | — | The dashboard is an external browser tab; it has no IPC bridge |

---

## Standard Stack

No new dependencies are permitted or needed (locked constraint: "No new dependencies; no bundler; CommonJS; `node:test`").

### Core (already present, used as-is)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Electron | `44.9.0` (`package.json:23`) | `app.getPath`, `dialog.showOpenDialog` / `showSaveDialog`, `safeStorage`, `ipcMain` | Already the runtime; `dialog` is the only sanctioned native picker |
| `node:fs` | Node 22.21.1 (verified: `process.version`) | atomic `.tmp`+rename write, `copyFileSync`, `rmSync`, `appendFileSync`, `fsyncSync` | Already the persistence mechanism (`src/main/store.js:7`) |
| `node:http` | built-in | The dashboard server, DELETE routing | `src/main/dashboard.js:17` |
| `node:test` + `node:assert` | built-in | All new unit/integration tests | `package.json:10` |
| `structuredClone`, `crypto.randomUUID` | built-in | Snapshotting, history ids | `src/main/store.js:200`, `src/main/main.js:449` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `dotenv` | `^18.0.8` | unchanged | not touched by this phase |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-written CSV writer | `csv-stringify`, `papaparse` | Adds a dependency and a supply-chain surface to a privacy product for ~30 lines of code. Rejected by constraint. |
| Sidecar NDJSON ledger | Ledger array inside `dictata.json` | Single atomic write and one file to move, but unbounded growth (D-12: kept until explicitly cleared) means the whole JSON document is re-serialised on *every* dictation (`src/main/store.js:135`). Rejected — see Q10. |
| `dialog.showOpenDialog` | HTML `<input type="file" webkitdirectory>` | Would need a new IPC + a renderer file handle, gives a Chromium path string, and violates D-01's "path only exists in the main process". Rejected. |
| `fs.renameSync` for the move | write → verify → delete | `rename` is only guaranteed on one filesystem — POSIX `rename(2)` documents `EXDEV` for cross-device ([CITED: man7.org/linux/man-pages/man2/rename.2.html]). A network-mounted target is an explicit COMP-02 use case. Rejected — see Q4. |

**Installation:** none. `npm install` must not run in this phase.

---

## Package Legitimacy Audit

**No packages are installed in this phase.** The phase adds only files under `src/` and `test/` and uses modules already imported by the repository (`electron`, `node:fs`, `node:path`, `node:http`, `node:test`, `node:assert`). The Package Legitimacy Gate is therefore not applicable; there is nothing to check and no `checkpoint:human-verify` install gate to insert.

---

## Architecture Patterns

### System Architecture Diagram

```text
                    ┌───────────────────────── Settings renderer (sandboxed) ─────────────────────────┐
                    │  Privacy & Data panel: retention select · storage path + Change… · 4 export btns │
                    └───────────────┬─────────────────────────────────────────────────────────────────┘
                                    │ window.vf.*  (settingsPreload.js → ipcRenderer.invoke)
                                    ▼
┌───────────── Browser (external) ─────────────┐        ┌──────────── main process ────────────────────┐
│ dashboard page (no preload, no IPC)          │        │                                              │
│  · per-row trash → inline confirm            │        │  ipcMain handlers                            │
│  · Clear all N → inline confirm              │        │   vf:set-retention / vf:data-info            │
│  · read-only retention + storage facts       │        │   vf:choose-storage-dir                      │
│  · "Open Settings" button                    │        │   vf:export-history|audit  vf:clear-audit    │
└───────┬───────────────────────┬──────────────┘        │   vf:delete-history / vf:clear-history       │
        │ fetch DELETE          │ EventSource           │            │                                 │
        ▼                       ▼                       │            ▼                                 │
┌─────────────────── node:http DashboardServer ────────┐│   ┌── one mutation path ────────────────┐   │
│ Host allowlist → route → token → validate id         ││   │ purgeEntry(id) / clearAll() /       │   │
│  GET  /api/state      (history, events, analytics,   ││◄──┼─ sweepRetention()  ─┐              │   │
│                        privacy facts)                ││   │                     │              │   │
│  GET  /api/events     (SSE, incl. the info event)    ││   │ 1 store mutate +    │              │   │
│  DELETE /api/history/:id   → onPurge(id)  ───────────┼┼──►│   IMMEDIATE save    │              │   │
│  DELETE /api/history       → onClearAll() ───────────┼┼──►│ 2 recompute stats   │              │   │
│  POST /api/settings/open   → onOpenSettings() ───────┼┼──►│ 3 bus.forget(id)    │              │   │
└─────────────────────────────────────────────────────┘│   │ 4 re-derive last-   │              │   │
                                                        │   │   cleaned           │              │   │
   ┌──────────── History window (renderer+preload) ────┐│   │ 5 notifyHistory()   │              │   │
   │ delete / clear buttons → same IPC → same path ────┼┼──►│   + updateTrayMenu  │              │   │
   └───────────────────────────────────────────────────┘│   │ 6 publish info      │              │   │
                                                        │   └─────────┬───────────┘              │   │
   ┌──── pipeline: onRecordingDone ────────────────────┐│             │                          │   │
   │ store.addHistory → sweep → append ledger row      ││             ▼                          │   │
   │ → publish dictation                               ││   Store (dictata.json, atomic .tmp)    │   │
   └───────────────────────────────────────────────────┘│   Ledger (dictata-audit.ndjson, append) │   │
                                                        │   Pointer (storage.json, userData)      │   │
                                                        └─────────────────────────────────────────┘
```

### Recommended Project Structure (additions only)

```
src/main/
├── analytics.js      # + computeStats(history)  — pure, already imported by dashboard + tests
├── retention.js      # NEW pure: RETENTION_CHOICES, cutoffFor(), splitExpired()
├── exporter.js       # NEW pure: csvField(), toCsv(), historyExport(), auditExport()
├── ledger.js         # NEW fs-only: createLedger({ file }) → append/read/clear/count
├── storage.js        # NEW electron+fs: pointer read/write, resolveStoreDir(), moveStore()
├── store.js          # + dir option, flush(), purgeEntry(), clearAll(), purgeExpired(), immediate save
├── events.js         # + forget(id) / forgetMany(ids)
├── dashboard.js      # + method routing, DELETE routes, POST settings route, privacy facts
└── main.js           # + bootstrap ordering, mutation path, sweep call sites, ledger append, IPC

src/renderer/
├── settings.html / settingsRenderer.js / settingsPreload.js   # + 6th "Privacy & Data" panel
└── historyRenderer.js                                          # route buttons through the purge path

src/dashboard/
├── index.html   # + delete buttons markup, clear-all, privacy facts block
├── app.js       # + delegation, confirm state, optimistic removal, loadState refresh
└── styles.css   # + .rec-del hidden-until-hover, confirm row, third grid column
```

### Pattern 1: One mutation path, many callers

**What:** every destructive action (dashboard row delete, dashboard clear-all, History-window delete, History-window clear, retention sweep) funnels into a small set of functions in `main.js` that own the cross-surface consequences.
**When to use:** always — this is what stops DAT-03-style divergence and makes criterion 2's "second deletion path" true by construction.
**Example:**

```js
// main.js — the only place that knows a deletion has four surfaces
function purgeEntry(id) {
  const { removed, wasLast } = store.purgeEntry(id);   // history + events + stats, immediate save
  bus.forget(id);                                       // ring buffer: no SSE replay
  if (wasLast || id === lastEntryId) rederiveLast();    // paste-last must not resurrect
  notifyHistory();
  updateTrayMenu();
  bus.publish('info', { message: 'Dictation deleted', kind: 'history' });
  return removed;
}
```

### Pattern 2: Derived stats, never accumulated

**What:** `stats` is recomputed from `data.history` after every mutation and once at load; nothing increments it.
**When to use:** on `addHistory`, `purgeEntry`, `clearAll`, `purgeExpired`, and `_load()`.

### Pattern 3: Pure core, I/O shell

**What:** retention maths and export formatting live in modules that require **nothing** (no `electron`, no `fs`), exactly like `analytics.js`, `ptt.js`, `wav.js`, `sse.js` (`README.md` design rule; `.planning/codebase/CONVENTIONS.md` "Pure logic modules must not require `electron`").
**When to use:** any rule a `node:test` file should assert without a display, network, or temp dir.

### Pattern 4: Pointer-file bootstrap before `new Store()`

**What:** resolve the store directory synchronously at module load, then construct the store with it.
**When to use:** the one and only place `main.js` opens the store.

### Anti-Patterns to Avoid

- **Deleting in the renderer.** The dashboard must never mutate its own `state.history` as the *source* of truth — only optimistically, then re-fetch. The History window must never filter its own array and call it done (`src/renderer/historyRenderer.js:48` currently does exactly this).
- **Two delete implementations.** `vf:delete-history` and `DELETE /api/history/:id` must resolve to the same function or DATA-03 will regress the moment one is edited.
- **Recomputing stats only on delete.** The cap still drops rows on add; recompute there too or `lifetimeWords` drifts again within one session.
- **`visibility: hidden` / `display: none` for the trash affordance.** Both remove the button from the tab order — the affordance becomes unreachable by keyboard, which is the classic trap D-08 asks us to avoid.
- **Trusting the id from the URL.** Ids flow into `Map` keys and `filter()`; validate the shape before use (see Q7).
- **Writing the export with `JSON.stringify` only.** CSV in Excel needs quoting, CRLF, a BOM, and a formula guard (Q6).
- **Moving the store with `renameSync`.** Cross-volume (network share) targets throw `EXDEV` per POSIX (`rename(2)`); and a same-volume rename that partially succeeds is not "verify then delete".

---

## Findings by Research Question

### Q1 — What are the actual history and event shapes, and which facts must an export/ledger carry?

**History entry.** Built in the pipeline at `src/main/main.js:451-470` and mutated twice before it is stored (paste result at `:468-470`):

```js
const entry = {
  id,
  raw: result.raw,
  cleaned: result.cleaned,
  durationMs,
  transcribeMs,
  model: result.model,
  at: Date.now(),
};
...
entry.pasteMs = pasteMs;
entry.pasted = pasted;
entry.words = wordCount(entry.cleaned);
store.addHistory(entry);
```
[VERIFIED: src/main/main.js:451-470]

So the persisted keys are exactly `id, raw, cleaned, durationMs, transcribeMs, model, at, pasteMs, pasted, words`. Three consequences the planner must design around:

1. **There is no target-application field.** The app name is computed and then discarded — `const appName = target && !target.self ? (target.name || '') : '';` [VERIFIED: src/main/main.js:403] is never read again. D-12's audit ledger cannot report "where it went" unless the pipeline captures it into the ledger row at the same moment. Adding it to the history entry is *not* recommended (it changes `mergeDefaults` consumers and the dashboard payload for no user-facing benefit); capture it into the ledger row only.
2. **`pasted` is a boolean, not an outcome.** D-11's failed attempts are not history rows at all — they are `error` events (`kind: 'paste' | 'api' | 'microphone' | 'cancel'`, published at `src/main/main.js:496`, `:501-507`). A cancelled dictation (`kind: 'cancel'`) is filtered out of the dashboard timeline and must stay out (`src/dashboard/app.js:388`: `.filter((e) => e.type === 'dictation' || (e.type === 'error' && e.kind !== 'cancel'))` [VERIFIED: src/dashboard/app.js:388]).
3. **`raw` and `cleaned` are the private payload.** D-12 forbids transcript text in the ledger. The ledger row may carry `id` (the correlation key), timestamp, duration, model, outcome, target app, and word *count* — never `raw`/`cleaned`.

**Event shape.** `src/main/events.js:37-50`:

```js
const event = {
  id: `${Date.now().toString(36)}-${(counter++).toString(36)}`,
  ts: Date.now(),
  type,
  ...payload,
};
```
[VERIFIED: src/main/events.js:37-43]

`...payload` spreads **after** `id`, which is the load-bearing detail: a `dictation` event published as `bus.publish('dictation', { ...entry, ... })` (`src/main/main.js:474-480`) inherits the *entry's* UUID as its event id, which is why the dashboard's id-keyed de-duplication merges a dictation event with its history row (`src/main/dashboard.js:63-65`) and why deleting by id can address both. Error/info events keep the generated `<base36>-<base36>` id.

**Persisted events.** `PERSISTED_TYPES` declares `dictation, error, info` [VERIFIED: src/main/events.js:14], but the main process only writes two of those: `if (event.type === 'error' || event.type === 'info') store.addEvent(event);` [VERIFIED: src/main/main.js:100-102]. Dictation events are therefore **session-only** (bus ring buffer, `DEFAULT_LIMIT = 500` at `src/main/events.js:16`). This is exactly why deletion needs two different erasers: a durable one for history, and an in-memory one for the bus.

**Stats shape.** `stats: { words: 0, sessions: 0, msSpoken: 0 }` [VERIFIED: src/main/store.js:43], `addHistory` increments all three [VERIFIED: src/main/store.js:181-189], while `deleteHistory` / `clearHistory` touch only `history` [VERIFIED: src/main/store.js:191-196].

**Implication for export:** a history CSV must be generated from `snapshot().history` (already a clone — `structuredClone(this.data)` at `src/main/store.js:198-201`), not from the dashboard's merged timeline, so the file contains one row per dictation and no derived/duplicated events.

---

### Q2 — The four (actually seven) surfaces a deletion must reach

The requirement says history must not "come back" after deletion. Enumerated against the code, a deleted dictation is still reachable from:

| # | Surface | Mechanism | Fix |
|---|---------|-----------|-----|
| 1 | `store.data.history` | `deleteHistory` filters the array (`src/main/store.js:192`) | already handled — but via the debounced `_save()` (see #6) |
| 2 | `store.data.events` (durable) | error/info rows persisted at `src/main/main.js:100-102`, merged back into every `/api/state` (`src/main/dashboard.js:217`) | `store.purgeEntry` must also filter `events` by id for failed-attempt rows |
| 3 | `bus.buffer` (in-memory) | `recent(200)` feeds `collectEvents` (`src/main/dashboard.js:216-217`); dictation events carry the entry id | new `bus.forget(id)` / `forgetMany(ids)` |
| 4 | dashboard client cache | `state.events` / `state.history` (`src/dashboard/app.js:18-29`) survive until the next `loadState()`; the 5 s timer re-renders from them (`src/dashboard/app.js:786-790`) | optimistic removal **and** `loadState()` after the request resolves |
| 5 | `lastCleaned` (paste-last) | `hotkeys.on('paste-last', () => { if (!lastCleaned) return; pasteInto(lastCleaned)... })` [VERIFIED: src/main/main.js:334-337] | re-derive the "paste last" target from the surviving history; never hold a deleted string |
| 6 | the on-disk file, 150 ms later | `_save()` is `setTimeout(..., 150)` [VERIFIED: src/main/store.js:126-141]; `before-quit` does not flush (`src/main/main.js:149-154`) | destructive mutations must call a synchronous/immediate `flush()`, and `before-quit` must flush |
| 7 | History-window DOM | its delete handler removes the node locally (`src/renderer/historyRenderer.js:45-50`) but `notifyHistory()` re-sends the whole snapshot (`src/main/main.js:563-567`), so a stale local filter is invisible today | keep `notifyHistory()` as the single refresh; delete the local `.remove()` shortcut |

**Residual surfaces that are out of scope but must be stated in the UI/README:** text already pasted into another app, and text sitting on the Windows clipboard. D-12 explicitly scopes erasure to *Dictata's* data; the Settings panel copy should say so rather than imply otherwise.

**Why "one mutation path" is the requirement's real shape:** there are two callers today — `vf:delete-history` / `vf:clear-history` (`src/main/main.js:618-619`) and (to be added) `DELETE /api/history/:id` / `DELETE /api/history`. If each implements its own consequences, DATA-03 regresses the first time one is edited. Both must resolve to `purgeEntry(id)` / `clearAll()` in `main.js`.

---

### Q3 — Stats: recompute, and the 500-row cap

**Current arithmetic is add-only.** `addHistory` does `this.data.stats.words += words; this.data.stats.sessions += 1; this.data.stats.msSpoken += entry.durationMs || 0;` [VERIFIED: src/main/store.js:184-187]. `deleteHistory` and `clearHistory` never subtract [VERIFIED: src/main/store.js:191-196]. `summarize()` then reports `lifetimeWords: stats.words || 0` [VERIFIED: src/main/analytics.js:129].

**Two independent drifts, not one:**
- *Deletion drift* — the requirement's target. Deleting 40 words leaves `lifetimeWords` unchanged.
- *Cap drift* — `if (this.data.history.length > HISTORY_LIMIT) this.data.history.length = HISTORY_LIMIT;` [VERIFIED: src/main/store.js:183] with `const HISTORY_LIMIT = 500;` [VERIFIED: src/main/store.js:46]. Row 501 is dropped from `history` while its words remain in `stats`, so on a busy day `totals.words` (computed from `entries`) and `lifetimeWords` (from `stats`) disagree in the same payload (`src/main/analytics.js:118-130`).

**Recommendation (locked by D-05): make `stats` derived.** Add `computeStats(history)` to the already-pure `src/main/analytics.js` and call it from one place — `Store._recomputeStats()` — invoked at the end of `_load()`, `addHistory()`, `purgeEntry()`, `clearAll()`, `purgeExpired()`. Nothing else may touch `this.data.stats`.

```js
/** Recompute the aggregate counters from the surviving rows. */
_recomputeStats() {
  let words = 0, sessions = 0, msSpoken = 0;
  for (const h of this.data.history) {
    words += Number.isFinite(h.words) ? h.words : wordCount(h.cleaned || h.raw || '');
    sessions += 1;
    msSpoken += h.durationMs || 0;
  }
  this.data.stats = { words, sessions, msSpoken };
}
```

Use `h.words` when present (it is stored at `src/main/main.js:470`) and fall back to `wordCount` for pre-`words` rows — `analytics.js` already exports `wordCount` [VERIFIED: src/main/analytics.js:139].

**Semantic consequence to state out loud:** after this change `lifetimeWords` means "words in retained history", not "words ever spoken". With `HISTORY_LIMIT = 500` and retention possibly set to 30 days, the KPI becomes bounded. That is the honest number for a privacy product (deleted data must not survive in an aggregate), and it is what "recompute from history" necessarily produces. If a true lifetime counter is ever wanted, it would have to be a separate ledger-derived number — flag it as a product decision, not an implementation detail (see Assumptions A2).

---

### Q4 — Relocating the store safely (COMP-02)

**Today the path is hardcoded at construction:** `this.file = path.join(app.getPath('userData'), 'dictata.json');` [VERIFIED: src/main/store.js:97], plus a legacy-adoption copy from `voice-flow.json` [VERIFIED: src/main/store.js:98-102]. There is no indirection to change.

**Why `renameSync` is wrong here.** `fs.renameSync` is the atomic primitive already used for the *write* (`src/main/store.js:136`) because both paths are in the same directory. For a user-chosen target it is the wrong primitive: POSIX `rename(2)` returns `EXDEV` across filesystems ([CITED: man7.org/linux/man-pages/man2/rename.2.html]), and a network share or a second drive is an explicit COMP-02 use case. "Move" must therefore be **copy → verify → commit → delete**, with a journal so a crash mid-move is recoverable.

**Design (recommended):**

1. `src/main/storage.js` owns the pointer file `storage.json` in `userData` (never inside the store dir, or moving the store would move the pointer):
   ```json
   { "version": 1, "dir": "D:\\DictataData", "pendingDelete": ["C:\\Users\\…\\AppData\\Roaming\\Dictata"] }
   ```
2. **Resolve before constructing the store.** `main.js` computes `const storeDir = storage.resolveStoreDir(app.getPath('userData'))` at module load and passes it: `new Store({ dir: storeDir })`. This ordering is the one bootstrap constraint in the phase — `store` is a module-level singleton (`src/main/main.js:79-90`), so resolution cannot happen later without re-creating it.
3. **Write the journal entry first** (`pendingDelete: [oldDir]`), then copy `<old>/dictata.json` and `<old>/dictata-audit.ndjson` with `fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL)` (exclusive so an existing target file is never silently overwritten → surface a "folder is already in use" error instead).
4. **Verify by reading back**: `JSON.parse(fs.readFileSync(newFile))`, check `mergeDefaults` shape, and compare `history.length` + a byte length recorded before the copy. Only then point `pointer.dir` at the new directory and `fsync` the pointer.
5. **Delete the old copies last** (the originals, not the directory), then clear `pendingDelete`. If the app dies between (3) and (5), the next launch sees `pendingDelete` and finishes the deletion — and *only* deletes files it has already verified at the new location.
6. Refuse, with a user-facing message, when: the target is inside `userData`'s tree, the target is not writable (probe by writing and removing a `.probe` file), the target already holds a `dictata.json`, or the copy fails.
7. `safeStorage` caveat: the API key is DPAPI-encrypted for the *current Windows user* (`enc:` prefix, `src/main/store.js:48-73`). Copying the file to another machine makes the key undecryptable but not readable — that is acceptable and worth a one-line note in the Settings panel. It does **not** block the move.

**Do not** move the *legacy adoption* logic (`src/main/store.js:98-102`) into the new dir; keep it at `userData` so a pre-rename install still migrates.

---

### Q5 — A folder picker across `contextIsolation: true`

Renderers are sandboxed — `contextIsolation: true`, `nodeIntegration: false` in every window (`src/main/main.js:191-195`, `:224-228`, `:248-252`) — and Settings already talks to main through a narrow bridge (`src/renderer/settingsPreload.js`). So the picker must live in the main process and return **data**, not a handle.

Verified against the Electron `dialog` docs: `dialog.showOpenDialog([browserWindow, ]options)` resolves to `{ canceled, filePaths }`, and `properties: ['openDirectory']` selects a directory ([CITED: electronjs.org/docs/latest/api/dialog]). Important asymmetry: `createDirectory` is documented as **macOS-only**; on Windows the native picker still lets the user create a folder via its own UI, so passing `createDirectory` is harmless but must not be relied on ([CITED: electronjs.org/docs/latest/api/dialog]).

```js
// main.js — returns a path string or null; the renderer never sees a handle
ipcMain.handle('vf:choose-storage-dir', async () => {
  const win = settingsWindow;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose where Dictata keeps your data',
    properties: ['openDirectory', 'promptToCreate'],
    defaultPath: storage.currentDir(),
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});
```

Rules the planner should encode:
- Resolve the *real* path (`fs.realpathSync`) before comparing it to the current dir, so `D:\data\..\data` is not treated as a move.
- The renderer only ever renders the returned string plus a `changed` flag; it must not construct paths (`path` is not available there).
- Exports use the sibling `dialog.showSaveDialog({ defaultPath, filters })` and are written by main; the renderer gets `{ saved: true, path }` or `{ saved: false }`.
- `openSettings` from the dashboard is the mirror problem: the dashboard is an ordinary browser page with no preload, so it cannot call IPC at all. It needs `POST /api/settings/open` → `onOpenSettings()` callback (see Q7).

---

### Q6 — CSV/Excel correctness

Target: "export opens in Excel without mojibake or shifted columns, and transcript text can never execute as a formula."

Five separate hazards, all cheap to handle:

1. **Encoding.** Excel on Windows assumes the ANSI code page for a `.csv` unless a UTF-8 BOM is present. Prepend `\uFEFF`. Verified in this session on Node v22.21.1 that `Buffer.from('\uFEFF' + 'a', 'utf8')` starts with `EF BB BF`.
2. **Line endings.** RFC 4180 specifies CRLF; Excel tolerates LF but Windows tooling is happier with CRLF ([CITED: rfc-editor.org/rfc/rfc4180]).
3. **Quoting.** Quote any field containing `,` `"` CR or LF, and double every embedded `"` — RFC 4180's rule, not a home-grown escape ([CITED: rfc-editor.org/rfc/rfc4180]).
4. **Formula injection.** A transcript beginning `=`, `+`, `-`, `@`, or a control char is executed by Excel/LibreOffice on open. OWASP's guidance is to prefix such cells with a single quote or a tab ([CITED: owasp.org/www-community/attacks/CSV_Injection]). Recommendation: prefix `'` (visible, non-destructive, survives round-trip) and *only* when the first character is one of `= + - @ \t \r`. This matters more than usual here — the text being exported is attacker-influenceable if the user dictates someone else's words.
5. **Newlines inside a cell.** A transcript with a line break must stay one row — covered by (3) if the field is quoted, which is why quoting must be unconditional for text columns rather than "when needed".

Keep it a **pure function** so `node:test` can assert all five without touching disk:

```js
// src/main/exporter.js — no electron, no fs
function csvField(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows) {
  return '\uFEFF' + rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}
```

History columns: `timestamp (ISO)`, `text` (cleaned), `raw`, `words`, `durationMs`, `transcribeMs`, `pasteMs`, `pasted`, `model`. Audit columns: `timestamp (ISO)`, `id`, `outcome`, `targetApp`, `durationMs`, `words`, `model`. Dates as ISO 8601 so Excel's locale cannot reinterpret `03/04/2026`.

---

### Q7 — DELETE route design in a hand-rolled `node:http` server

The server currently has **no method routing and a static fallthrough**: `_handle` URL-parses, checks the Host allowlist, matches `/api/events`, `/api/state`, `/api/history`, and then treats *anything else* as a static filename [VERIFIED: src/main/dashboard.js:161-201]. A `DELETE /api/history/abc` today would therefore fall into the static branch, resolve to a nonexistent file, and 404 — silently doing nothing. Method routing must be added before the static block.

Order of checks (mirrors the existing security posture):
1. `this._hostAllowed(req.headers.host)` → 403 (already first, `src/main/dashboard.js:166-168`).
2. Method + path match.
3. `this._authorised(url)` → 401. The token stays in the query string, as every existing route does (`src/main/dashboard.js:209-212`) — do not invent a header scheme for two routes.
4. Validate the id shape (UUID) before it reaches `Map`/`filter` — reject with 400.
5. Call the injected callback; return `204` with no body on success, `404` if nothing matched.

```js
// dashboard.js — inserted before the static fallthrough
if (pathname === '/api/history' && req.method === 'DELETE') {
  if (!this._authorised(url)) return this._json(res, 401, { error: 'Bad token' });
  const removed = await this.onClearAll();
  return this._json(res, 200, { removed });
}
const m = pathname.match(/^\/api\/history\/([0-9a-f-]{36})$/i);
if (m && req.method === 'DELETE') {
  if (!this._authorised(url)) return this._json(res, 401, { error: 'Bad token' });
  const removed = await this.onPurge(m[1]);
  return removed ? this._json(res, 200, { removed: 1 }) : this._json(res, 404, { error: 'Not found' });
}
if (pathname === '/api/settings/open' && req.method === 'POST') {
  if (!this._authorised(url)) return this._json(res, 401, { error: 'Bad token' });
  await this.onOpenSettings();
  return this._json(res, 200, { ok: true });
}
```

Notes:
- Parse with the URL already built at `src/main/dashboard.js:162`; do not `decodeURIComponent` a UUID regex match (nothing to decode, and decoding first invites `%2F` smuggling).
- `204` vs `200 {removed}`: return `200` with a count — the dashboard needs it for the "Deleted 1 dictation · Undo not available" toast and to distinguish "already gone" from "never existed".
- The callbacks are injected in the constructor, exactly like `store`/`bus` today (`src/main/dashboard.js:79-90`), so `test/dashboard.test.js`'s `fakeStore()` harness can assert them without Electron (`test/dashboard.test.js:9-32`).
- CSRF: a `DELETE` needs the token, which a hostile page cannot read cross-origin; the `Host` allowlist already blocks DNS rebinding. No `Origin` check needed, but adding `if (req.method !== 'GET' && req.headers.origin && !req.headers.origin.startsWith(\`http://${HOST}\`))` is a cheap belt-and-braces guard.
- The dashboard's Settings button must call `POST /api/settings/open` (relative URL — `test/page.test.js` forbids absolute `http(s)://` origins in dashboard sources, `test/page.test.js:51-57`).

---

### Q8 — An accessible delete affordance that is invisible at rest

Constraints that collide: D-08 wants the control invisible until hover, and the existing CSS has the row as a two-column grid — `.rec { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 18px; ... }` [VERIFIED: src/dashboard/styles.css:449-455] — so a third column must be added or the button overlays the text.

**The one rule:** never `display: none` or `visibility: hidden`. Both remove the control from the tab order and from the accessibility tree, making the action unreachable by keyboard — the specific trap D-08 exists to avoid. Use `opacity: 0` (still focusable, still announced) and reveal on *three* triggers: row hover, button focus, and row `:focus-within`.

```css
/* third column, always present but zero-width until revealed */
.rec { grid-template-columns: 96px minmax(0, 1fr) 32px; }

.rec-del {
  opacity: 0;
  transition: opacity 120ms ease;
  background: none; border: 0; cursor: pointer;
  color: var(--muted); border-radius: var(--radius);
  width: 28px; height: 28px; padding: 4px;
}
.rec:hover .rec-del,
.rec:focus-within .rec-del,
.rec-del:focus-visible { opacity: 1; }
.rec-del:focus-visible { outline: 2px solid var(--orange); outline-offset: 2px; }

/* touch / no-hover devices: there is no hover, so never hide it */
@media (hover: none) { .rec-del { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .rec-del { transition: none; } }
```

Markup: `<button class="rec-del" data-id="…" aria-label="Delete this dictation">` with the existing inline SVG trash icon (no icon font, no CDN). Colour `var(--muted)` at rest and `var(--orange)` on hover, drawn from `:root` per `src/dashboard/styles.css:7-34`.

**Two-step confirm without a modal.** Native `confirm()` is used by the History window (`src/renderer/historyRenderer.js:59`) but a browser modal in the dashboard blocks the SSE-driven UI and is unstyleable. D-08 asks for an inline second step:

1. Row renders normally; the trash button carries `data-id`.
2. First click sets `state.confirmId = id` and re-renders only that row into a confirm state: `Delete?  [Delete] [Cancel]` — the confirm button gets focus programmatically so Enter completes and Escape cancels.
3. Second click issues `DELETE /api/history/:id`, removes the row optimistically, then `loadState()`.
4. `state.confirmId` must live in the `state` object (`src/dashboard/app.js:18-29`) — **not** in a closure or in the DOM — because `renderHistory()` rebuilds `innerHTML` from scratch (`src/dashboard/app.js:460`) and a 5 s timer re-renders the history tab (`src/dashboard/app.js:786-790`).
5. Clear `confirmId` on Escape, on clicking any other row's trash, and on tab switch. Do **not** clear it on the 5 s re-render — that would make the confirm vanish under the cursor every 5 seconds.

Use one delegated listener on `#history` (`e.target.closest('.rec-del')`) rather than per-row listeners, since rows are re-created on every render. Any user-controlled value interpolated into the markup must pass through the existing `esc()` helper (`src/dashboard/app.js:71-75`).

Clear-all is a separate control in the history header: `Clear all N dictations` → inline `Delete all N? [Yes, delete all] [Cancel]`, wired to `DELETE /api/history`. It must clear **only** history (and its failed attempts / bus entries) — never `settings`, `dashboardToken`, `dictionary`, or `replacements` (`dashboardToken`'s stability contract is documented at `src/main/store.js:162-172`; rotating it would silently break every open tab).

---

### Q9 — Where the retention sweep goes

D-06: sweep on launch and after each dictation. Precisely:

| Call site | Line today | Why there |
|---|---|---|
| after `new Store()` in module bootstrap, **before** `app.whenReady()` wires the dashboard | `src/main/main.js:79-90` (singletons), `:125-131` (ready) | `/api/state` must never serve an expired row, not even on the first request. Sweeping before `startDashboard()` makes "already swept" the first observable state. |
| immediately after `store.addHistory(entry)` | `src/main/main.js:471` | A dictation arriving after a long gap must not leave yesterday's expired rows visible for one render. Sweep **before** `bus.publish('dictation', …)` (`:474`) so the dashboard never sees a state that includes the just-expired rows. |
| optionally on retention change | `vf:update-settings` (`src/main/main.js:577-594`) | Changing 365 days → 30 days should take effect immediately, not at the next dictation. Cheap and expected. |
| `before-quit` flush | `src/main/main.js:149-154` | Not a sweep — a `store.flush()` so an already-issued delete/sweep cannot be lost to the 150 ms debounce (`src/main/store.js:126-141`). |

Implementation split:
- `src/main/retention.js` — **pure**: `RETENTION_CHOICES = [0, 30, 90, 365]` (0 = keep forever, D-03), `cutoffFor(days, now)`, `splitExpired(history, cutoff)` → `{ keep, expiredIds }`. Testable with a fixed clock, like `ptt.js`'s injectable `opts.now`.
- `Store.purgeExpired(ids)` — mutates, recomputes stats, immediate save.
- `main.js` `sweepRetention()` — calls the pure split, and if `expiredIds.length`, runs the **same** post-mutation consequences as `purgeEntry` (bus forget, re-derive paste-last, notify, tray, one `info` event). This is the point of the single mutation path: a sweep is just a bulk delete.

Keep-forever default: `retentionDays: 0` in `DEFAULTS.settings` (`src/main/store.js:11-44`), and `cutoffFor(0)` must return `null` so no comparison is made.

**Interaction with `store.events`:** the same retreat cutoff should window `data.events` (`EVENT_LIMIT = 500` at `src/main/store.js:47`), otherwise the dashboard keeps showing week-old failed attempts while their dictations are gone. The audit ledger is explicitly exempt (D-12).

---

### Q10 — Ledger: sidecar NDJSON, not an array inside `dictata.json`

**Against inline:** `dictata.json` is rewritten in full on every save — `fs.writeFileSync(tmp, JSON.stringify({ ...this.data, settings }, null, 2)); fs.renameSync(tmp, this.file);` [VERIFIED: src/main/store.js:134-136]. An audit ledger kept "until explicitly cleared" (D-12) grows without bound, so every dictation would re-serialise the entire lifetime ledger. That is O(n) per keystroke-scale event on a tray app that also wants low latency, and it makes the whole store unreadable if one ledger row is corrupt.

**Recommended:** `dictata-audit.ndjson` in the resolved store directory (so it moves with the store — Q4 must copy it and COMP-02 must verify its presence, or an audited team silently loses its trail).

- Append one JSON object per line with `fs.appendFileSync` (atomic enough for single-append lines on NTFS; no read-modify-write, no rewrite of prior rows).
- Never include `raw`, `cleaned`, or any transcript text (D-12). `{ ts, id, outcome, targetApp, durationMs, words, model }`, where `id` is metadata for correlation only.
- `read()` = split on `\n`, `JSON.parse` per line, skipping a trailing partial line (a crash mid-append must not poison the file).
- `count()` for the Settings "N audit records" fact; `clear()` truncates and is the only destructive operation, gated behind its own confirm (D-12).
- Outcomes: `pasted | copied | failed` from `entry.pasted` plus error `kind`, with `cancelled` deliberately excluded (cancellations are not dictations — see A3).
- `failed` rows come from the error path at `src/main/main.js:496-507`, so the ledger append must happen in both the success path (after `store.addHistory`) and the `catch`, and must never throw into the pipeline (`try { ledger.append(row) } catch { /* auditing must never break dictation */ }` — the same rule `logger.write()` follows, `src/main/logger.js:40`).

---

## Recommended Approach, Requirement by Requirement

| Req | What to build | Where | Key acceptance check |
|-----|---------------|-------|----------------------|
| **DATA-01** | Per-row trash affordance (hidden at rest) → inline two-step confirm → `DELETE /api/history/:id` → `purgeEntry(id)`; same affordance on failed-attempt rows (error events) | `src/dashboard/index.html`, `src/dashboard/app.js` (delegation + `state.confirmId`), `src/dashboard/styles.css` (`.rec-del`), `src/main/dashboard.js:161-201`, `src/main/main.js` | Mouse-hover reveals the trash; Tab reaches it and it appears on focus; two clicks delete; Esc cancels; the deleted row never returns after a refresh or restart |
| **DATA-02** | Clear-all control naming the count: `Delete all N dictations?` → `DELETE /api/history` → `clearAll()`; clears history, id-matching persisted events, live bus entries, zeroes stats — never `settings`/`dashboardToken`/`dictionary` | `src/dashboard/index.html`, `src/dashboard/app.js`, `src/main/dashboard.js`, `src/main/main.js` | Count in the prompt matches the list; after clear the dashboard, History window, tray and Insights all show empty; settings and the dashboard URL still work |
| **DATA-03** | One mutation path `purgeEntry`/`clearAll` shared by dashboard routes **and** the History-window IPC; immediate `store.flush()`; `bus.forget`/`forgetMany`; re-derive `lastCleaned`; `notifyHistory`; `store.flush()` in `before-quit`; History window stops filtering its own array | `src/main/main.js:149-154`, `:618-619`, `:563-567`; `src/main/events.js` (`forget`); `src/renderer/historyRenderer.js:45-50` | Delete from either surface → gone from the other without restart; delete then quit within 150 ms → still gone after restart; `paste-last` cannot paste deleted text |
| **DATA-04** | `exporter.js` (pure: `csvField`, `toCsv`, history/audit projections) + `dialog.showSaveDialog` in main + IPC; history as JSON **and** CSV; audit as JSON **and** CSV; buttons in Settings | new `src/main/exporter.js`; `src/main/main.js` IPC; `src/renderer/settings.html`/`settingsRenderer.js`/`settingsPreload.js` | Files open in Excel with accents intact, one row per dictation, ISO timestamps, and `=x` dictated text rendered as `'=x`; JSON round-trips `history` exactly |
| **DATA-05** | Retention select (Keep forever / 30 / 90 / 365) + `retention.js` (pure) + `Store.purgeExpired` + `sweepRetention()` at launch and after each dictation, plus on retention change; default keep-forever; same cutoff applied to `store.events` | new `src/main/retention.js`; `src/main/main.js` (bootstrap, `:471`, `:577-594`); `src/main/store.js` (`retentionDays`, `purgeExpired`) | Existing install upgrades with nothing purged; setting 30 days removes only older rows; the dashboard never shows an expired row even on first paint; stats match the surviving rows |
| **COMP-01** | Metadata ledger sidecar `dictata-audit.ndjson`: appended on success **and** failure, `{ ts, id, outcome, targetApp, durationMs, words, model }`, no transcript text; read/count/clear; survives deletions | new `src/main/ledger.js`; appends in `src/main/main.js` success path (`:471`) and `catch` (`:496-507`); `targetApp` captured at `:403` | Dictate → row appended; delete the dictation → ledger row remains; grep of the file finds no transcript text; clear log empties it behind its own confirm |
| **COMP-02** | `storage.js` pointer (`storage.json` in `userData`) + `pendingDelete` journal + move (copy → readback verify → pointer commit → delete old) + `dialog.showOpenDialog` picker + Settings UI showing the resolved path | new `src/main/storage.js`; `src/main/store.js` `dir` option (`:97`); `src/main/main.js` bootstrap ordering (`:79-90`); `src/renderer/settings*` | Move to a second drive → restart reads the new location, old files gone, no second copy; kill mid-move → next launch completes the deletion; refusing an in-use folder shows a clear message |

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Directory picker | Custom path text input in Settings | `dialog.showOpenDialog({ properties: ['openDirectory'] })` | Native picker gets UNC paths, drive letters, and permission dialogs right; a typed path invites traversal and typos |
| Atomic file write | `writeFileSync(file)` in place | existing `.tmp` + `renameSync` pattern (`src/main/store.js:134-136`) | A crash mid-write currently leaves the old file intact; a direct write truncates it |
| CSV escaping | `fields.join(',')` | RFC 4180 quoting + BOM + formula guard (Q6) | Commas/quotes/newlines in dictated text are the common case, not the edge case |
| Date formatting for export | `toLocaleString()` | `new Date(ts).toISOString()` | Locale output is ambiguous in Excel across `en-US`/`en-GB`/`de-DE` |
| Deep-cloning history for export | manual `JSON.parse(JSON.stringify())` | `store.snapshot()` (`src/main/store.js:198-201`) | Already a `structuredClone`, already decrypts the key once, already the established pattern |
| Retention date maths | `new Date(ts) < Date.now() - days*864e5` inline | `retention.cutoffFor()` pure helper | DST and month boundaries; one tested function beats five inline expressions |
| Two-step confirm | `window.confirm()` in the dashboard | inline confirm state (Q8) | Modal blocks the SSE UI, is unstyleable, and is not two-step — it is one step with a browser chrome |

**Key insight:** almost everything hard in this phase is already solved somewhere in the repo — the atomic-write pattern, the snapshot pattern, the token/Host gate, the pure-module test style. The genuinely new work is the *move* (which must not use the existing `renameSync`) and the *deletion fan-out* (which has no precedent because nothing has ever been deleted from more than one place).

---

## Runtime State Inventory

This is a data-ownership phase: the "rename" is of *where data lives*, and the runtime state is the point of the phase, so every category is answered rather than skipped.

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| **Stored data** | `%APPDATA%/Dictata/dictata.json` — `history` (≤500 rows), `events` (≤500, error/info only), `settings.apiKey` (`enc:` + DPAPI), `dashboardToken`, `stats`, `dictionary`, `replacements` [VERIFIED: src/main/store.js:11-47]. Legacy `voice-flow.json` adopted once if present [VERIFIED: src/main/store.js:98-102]. | Schema additions only (`retentionDays`); a **recompute** pass over `history` replaces `stats` on load; no row rewriting required |
| **Live service config** | None — no external services, no remote account. The only network peer is `generativelanguage.googleapis.com`, which stores nothing for us. Dashboard token lives in the file above, not in a service. | None |
| **OS-registered state** | Login item via `app.setLoginItemSettings` (`src/main/main.js:156-159`); tray icon; the NSIS uninstall entry. None of these embed the store *path*. | None for this phase. (Note: after COMP-02 the uninstaller will not remove a relocated store — acceptable, and worth a README line.) |
| **Secrets/env vars** | `GEMINI_API_KEY` in `.env` (dev fallback) and the DPAPI-encrypted copy in the store [VERIFIED: src/main/main.js:31]. Moving the store relocates the encrypted copy — still decryptable by the same Windows user, undecryptable elsewhere. | None; document the DPAPI/user-binding caveat next to the storage picker |
| **Build artifacts** | `dist/` holds `Voice Flow Setup 0.1.0.exe` and `dist/win-unpacked/` from a pre-rename build. No compiled JS to refresh (no bundler — `build.files` ships `src/**/*` as-is, `package.json:35`). | None for this phase; do not add `dist/` content |

**Canonical question — after every file is updated, what runtime systems still hold deleted text?** The bus ring buffer (until `forget`), the dashboard tab's JS cache (until refetch), `lastCleaned` in the main process (until re-derived), and the 150 ms write timer (until flushed). Those four are the entire correction list, and all four are handled by `purgeEntry` (Q2).

---

## Common Pitfalls

### Pitfall 1: Deleting the row but not the SSE replay
**What goes wrong:** a row disappears, then a reconnecting dashboard replays the bus buffer and the row returns until restart.
**Why:** `_state()` merges `bus.recent(200)` for every request (`src/main/dashboard.js:216-217`), and dictation events carry the entry's UUID (Q1).
**Avoid:** `bus.forget(id)` inside the single mutation path, and re-fetch after the DELETE.
**Warning signs:** "it comes back when I refresh the dashboard" in UAT.

### Pitfall 2: The delete that loses the race with `before-quit`
**What goes wrong:** delete, immediately quit from the tray, restart → the row is back.
**Why:** `_save()` is a 150 ms debounce (`src/main/store.js:126-141`) and `before-quit` only stops services (`src/main/main.js:149-154`).
**Avoid:** destructive mutations call `flush()`; `before-quit` calls `store.flush()`.
**Warning signs:** intermittent data resurrection in manual testing, never in unit tests.

### Pitfall 3: Recomputing stats in the renderer
**What goes wrong:** dashboard totals and Settings totals disagree, or the dashboard's optimistic removal makes the number dip then snap back.
**Why:** `summarize()` reads `stats.words` for `lifetimeWords` while computing `totals.words` from `entries` (`src/main/analytics.js:118-130`).
**Avoid:** one `computeStats()` in main; the renderer only renders what `/api/state` returns.

### Pitfall 4: `visibility: hidden` for the hover affordance
**What goes wrong:** keyboard users can never reach delete; screen readers omit it.
**Why:** both `display: none` and `visibility: hidden` remove the element from the tab order.
**Avoid:** `opacity: 0` + `:focus-visible`/`:focus-within` reveal, and an unconditional reveal under `@media (hover: none)`.

### Pitfall 5: Confirm state destroyed by the 5 s timer
**What goes wrong:** the inline confirm flashes and resets before the user can click again.
**Why:** `renderHistory()` rebuilds `innerHTML` (`src/dashboard/app.js:460`) and a 5 s interval re-renders the history tab (`src/dashboard/app.js:786-790`).
**Avoid:** `state.confirmId` in the `state` object, cleared only by explicit user action or a different row.

### Pitfall 6: `renameSync` across volumes
**What goes wrong:** the move silently fails (`EXDEV`) or, worse, half-succeeds and the app reads an empty store on next launch.
**Why:** `rename` is same-filesystem only ([CITED: man7.org/…/rename.2.html]); network shares and second drives are the primary use case.
**Avoid:** copy → verify → commit pointer → delete, with a journal (Q4).

### Pitfall 7: Ledger inside the store file
**What goes wrong:** dictation latency grows over months; one corrupt row corrupts settings.
**Why:** `_save()` rewrites the entire document (`src/main/store.js:134-136`).
**Avoid:** NDJSON sidecar, appended per row (Q10).

### Pitfall 8: Clearing too much
**What goes wrong:** "Clear all" wipes the API key, dictionary, or `dashboardToken`, logging the user out of the dashboard and forcing re-entry of the key.
**Why:** `clearHistory` today is narrow, but a naive `data.history = []; data = DEFAULTS` rewrite is not.
**Avoid:** `clearAll()` touches `history`, id-matching `events`, `stats`, and the bus — an explicit allow-list of fields.

### Pitfall 9: CSV that Excel "helpfully" reinterprets
**What goes wrong:** a dictated phone number becomes `1.23E+10`, `=SUM(...)` evaluates, accents render as `Ã©`.
**Avoid:** ISO dates, `'`-prefix on formula-leading cells, UTF-8 BOM, quoted text columns.

### Pitfall 10: Relying on `createDirectory` on Windows
**What goes wrong:** the "New folder" affordance is missing and the flow assumes the user cannot create a target directory.
**Why:** `createDirectory` is macOS-only in the Electron docs.
**Avoid:** copy that tells the user they can create a folder in the picker; do not branch on it.

---

## Code Examples

### The single mutation path (main.js)

```js
// src/main/main.js — the only place that knows a deletion has many surfaces
function rederiveLast() {
  const last = store.snapshot().history[0];
  lastCleaned = last ? last.cleaned : '';
  lastRaw = last ? last.raw : '';
}

function purgeEntry(id) {
  const { removed, wasLast, ids } = store.purgeEntry(id); // history + events + stats, flushed
  if (!removed) return 0;
  bus.forgetMany(ids);            // entry id + any event ids that referenced it
  if (wasLast) rederiveLast();    // paste-last must not resurrect deleted text
  notifyHistory();
  updateTrayMenu();
  bus.publish('info', { message: 'Dictation deleted', kind: 'history' });
  return removed;
}

function clearAll() {
  const removed = store.clearAll();  // history + error/info events + stats, flushed
  bus.forgetAll();                   // drop dictation/error entries but keep app state
  rederiveLast();
  notifyHistory();
  updateTrayMenu();
  bus.publish('info', { message: `${removed} dictations deleted`, kind: 'history' });
  return removed;
}

function sweepRetention() {
  const s = store.settings;
  const cutoff = cutoffFor(s.retentionDays || 0, Date.now());
  if (!cutoff) return 0;
  const { expiredIds } = splitExpired(store.snapshot().history, cutoff);
  if (!expiredIds.length) return 0;
  const removed = store.purgeExpired(expiredIds);
  bus.forgetMany(expiredIds);
  if (!store.snapshot().history.length) rederiveLast();
  notifyHistory();
  return removed;
}
```

### Dashboard DELETE call (app.js)

```js
// attached once, on the container — rows are rebuilt on every render
$('#history').addEventListener('click', async (e) => {
  const btn = e.target.closest('.rec-del');
  if (!btn) return;
  const id = btn.dataset.id;
  if (state.confirmId !== id) { state.confirmId = id; renderHistory(); return; }

  const res = await fetch(`/api/history/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`, { method: 'DELETE' });
  state.confirmId = null;
  if (res.ok) {
    state.history = state.history.filter((h) => h.id !== id);
    state.events  = state.events.filter((ev) => ev.id !== id);
    renderHistory();
    loadState();              // authoritative refresh, closes the SSE/cache gap
  } else {
    renderHistory();
  }
});
```

### Retention, pure and clockless

```js
// src/main/retention.js
const RETENTION_CHOICES = [0, 30, 90, 365];   // 0 = keep forever

function cutoffFor(days, now) {
  if (!days || days <= 0) return null;
  const d = new Date(now);
  d.setDate(d.getDate() - days);                  // calendar days, DST-safe
  return d.getTime();
}

function splitExpired(history, cutoff) {
  if (cutoff == null) return { keep: history.slice(), expiredIds: [] };
  const keep = [], expiredIds = [];
  for (const h of history) ((h.at || 0) < cutoff ? expiredIds : keep).push(h);
  return { keep, expiredIds };
}
```

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Windows/Excel honours a UTF-8 BOM and CRLF in the same way as the documented Excel behaviour I cited; the `EF BB BF` byte prefix itself was verified in-session on Node 22.21.1, but *Excel's* parsing was not tested here. | Q6 | Accented transcripts appear as mojibake. Cheap to confirm in UAT by opening one export in Excel. |
| A2 | Recomputing `stats` from retained history (thus making `lifetimeWords` bounded by the 500-row cap) is the intended meaning of D-05, rather than keeping an unbounded lifetime counter elsewhere. | Q3 | A regulated buyer may expect "words ever spoken"; the dashboard's Insights total would drop after a retention sweep. Needs a product confirmation, not a code change. |
| A3 | The ledger's outcome vocabulary is `pasted` / `copied` / `failed`; D-11 names only "pasted/failed", and cancellations (`kind: 'cancel'`) are excluded because `app.js:388` already excludes them from the timeline. | Q10 | Cancelled attempts are silently unauditable, which may be exactly what a compliance reviewer asks about. Confirm with the user. |
| A4 | `dialog.showOpenDialog` with `openDirectory` is sufficient on Windows and the OS picker allows folder creation without `createDirectory` (documented as macOS-only). | Q5 | Users on a fresh drive cannot create a target folder inline. Fallback: instruct them to create it in Explorer first. |
| A5 | `DEFAULT_LIMIT = 500` bus events (`src/main/events.js:16`) is large enough that a deleted dictation's event is still in the buffer when the user deletes it — i.e. `forget()` is necessary, not theoretical. | Q2 | Low; the fix is harmless either way. |
| A6 | Copying `dictata.json` to a different Windows user/machine leaves `enc:` values undecryptable but does not corrupt the store (`decryptSecret` returns `''` on failure, `src/main/store.js:64-73`). | Q4 | A user moving to a new machine silently loses their API key and must re-enter it — acceptable, but must be said in the UI. |
| A7 | The dashboard is always opened in the user's default browser with the token in the query string, so `POST /api/settings/open` can safely rely on that token. | Q7 | If a future change lands the dashboard in a `BrowserWindow`, the route still works; no risk. |

---

## Open Questions (RESOLVED)

1. **What does "export" mean for the audit ledger when there is no ledger yet?** The ledger is new in this phase, so on first launch after upgrade it is empty while history has rows. 
   - What we know: D-12 says the ledger survives deletion and is metadata-only. 
   - Unclear: whether the four export buttons should backfill ledger rows from existing history (retroactive audit trail) or start from the upgrade moment.
   - **RESOLVED (adopted):** start empty; state "audit records begin when this version is installed" in the panel. No backfill, because it would fabricate timestamps for events that were never audited. Landed in `01-02-PLAN.md` / `01-03-PLAN.md`.

2. **Should retention apply to `store.events`?** 
   - What we know: error/info events accumulate to 500 and drive the dashboard's "failed attempts". 
   - Unclear: whether D-02's retention window is about dictations only. 
   - **RESOLVED (adopted):** apply the same cutoff to events (they are equally personal — an error message can quote dictated text), but keep the audit ledger exempt per D-12. Landed in `01-02-PLAN.md`.

3. **What happens to a relocated store on uninstall?** 
   - NSIS removes `userData` by default; a store moved to `D:\` will survive uninstall. 
   - **RESOLVED (adopted):** accept the survival, document it in the Settings "Privacy & Data" help text only; no uninstall-time deletion (dangerous and out of scope for Phase 1).

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | tests, scripts | ✓ | v22.21.1 (verified `process.version`) | — |
| npm | dev only | ✓ | bundled with Node | — |
| Electron | runtime, `dialog`, `safeStorage` | ✓ | `^44.9.0` (`package.json:23`) | — |
| `node:test` / `node:assert` | all new tests | ✓ | built-in | — |
| Excel / LibreOffice | manual verification of DATA-04 | ✗ (not assumed) | — | Verify CSV structure with `node:test` string assertions; open in Excel during UAT |
| A second drive or network share | manual verification of COMP-02 | ✗ (not assumed) | — | Test cross-volume behaviour with a temp dir on another volume if present; otherwise assert the copy→verify→delete sequence with mocked paths in `node:test` |

**Missing dependencies with no fallback:** none — the phase is code-only.

**Missing dependencies with fallback:** Excel and a second volume are both *manual verification* aids, not execution blockers.

---

## Security Domain

`security_enforcement` is enabled (`.planning/config.json`); ASVS level 1.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No user accounts. The dashboard token is a local capability token, covered under V4. |
| V3 Session Management | no | No sessions; the token is stable by design (`src/main/store.js:162-172`). |
| V4 Access Control | yes | Every new route reuses `_hostAllowed` + `_authorised` before any mutation (`src/main/dashboard.js:166-171`, `:209-212`); IPC handlers are reachable only from app-owned windows with `contextIsolation: true`. |
| V5 Input Validation | yes | Path id validated against `/^[0-9a-f-]{36}$/i` before use; retention value clamped to `RETENTION_CHOICES`; chosen directory resolved with `realpathSync` and rejected when it overlaps `userData`; export paths come from `showSaveDialog` only (never from renderer input). |
| V6 Cryptography | yes (present, unchanged) | `safeStorage`/DPAPI for the API key; never hand-rolled. This phase must not add crypto. The audit ledger is deliberately plaintext metadata — document that. |
| V7 Error Handling & Logging | yes | Ledger writes must never throw into the pipeline; error messages for the move must not include full paths of other users' folders. |
| V8 Data Protection | yes | This *is* the requirement: deletion across all surfaces, export under user control, no transcript text in the ledger, no new outbound requests. |
| V12 Files & Resources | yes | Copy target is user-chosen and validated; `COPYFILE_EXCL` prevents overwriting an existing store; the pointer file is written atomically. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| CSV formula injection via dictated text | Tampering | `'`-prefix on `= + - @ \t \r` (`exporter.csvField`) |
| DNS rebinding against the local dashboard | Spoofing | Existing Host allowlist, kept ahead of routing (`src/main/dashboard.js:166-168`) |
| Unauthenticated destructive request | Elevation of privilege | Token required on every `DELETE`/`POST`, checked before any store mutation |
| Path traversal via the storage picker or export path | Tampering | Paths originate in native dialogs in main; `realpathSync`; reject `userData` subtrees; never accept a renderer-supplied path |
| Data remanence after "delete" | Information disclosure | `bus.forget`, immediate flush, stats recompute, `paste-last` re-derivation; explicit UI statement that already-pasted text and the Windows clipboard are outside Dictata's control |
| Secret leakage into the audit ledger | Information disclosure | Ledger row allow-list (`ts, id, outcome, targetApp, durationMs, words, model`); test asserts `raw`/`cleaned` absent |
| Symlink/junction redirection of the target directory | Tampering | `realpathSync` before copying; refuse if the resolved target differs from the chosen path's parent unexpectedly |

---

## Test Plan (validation, not a Nyquist section)

`workflow.nyquist_validation` is `false` in `.planning/config.json`, so no Validation Architecture section is emitted. Tests are still required by the repo's own conventions (`npm test` == `node --test "test/**/*.test.js"`, `package.json:10`).

| Area | File | Cases |
|------|------|-------|
| Retention maths | `test/retention.test.js` (new) | `cutoffFor(0)` → `null`; 30 days with a fixed clock; DST boundary; `splitExpired` keeps boundary-equal rows |
| Stats recompute | `test/store.test.js` (extend) | add → stats; delete → stats drop; cap overflow → `stats.words` equals sum of retained rows; `_load()` recomputes a drifted file |
| CSV | `test/exporter.test.js` (new) | comma, quote, CRLF-in-cell, BOM prefix (`EF BB BF`), `=SUM` prefixed, ISO date |
| Ledger | `test/ledger.test.js` (new) | append → read round-trip; trailing partial line skipped; clear truncates; no `raw`/`cleaned` keys |
| Routes | `test/dashboard.test.js` (extend) | `DELETE /api/history/:id` 200/404/401; `DELETE /api/history` count; `POST /api/settings/open` invokes callback; wrong method falls through to static (404) not to a mutation; bad id → 400 |
| Pure page guards | `test/page.test.js` (extend) | new ids exist in `index.html`; no absolute origins added by the Settings link; still ≥3 breakpoints and `prefers-reduced-motion` |
| Mutation path | `test/store.test.js` | `purgeEntry` removes history + matching events + recomputes stats; `clearAll` leaves `settings`, `dashboardToken`, `dictionary` intact |

---

## Sources

### Primary (HIGH confidence)
- `src/main/store.js`, `src/main/events.js`, `src/main/dashboard.js`, `src/main/main.js`, `src/main/analytics.js`, `src/dashboard/app.js`, `src/dashboard/styles.css`, `src/renderer/historyRenderer.js` — read in this session; line ranges cited inline.
- `node:` API behaviour probed in-session on Node v22.21.1 (`Buffer` BOM bytes; `fs.constants.COPYFILE_EXCL`; `crypto.randomUUID`).

### Secondary (MEDIUM confidence)
- Electron `dialog` — `showOpenDialog` return shape, `openDirectory`, `createDirectory` macOS-only: `https://www.electronjs.org/docs/latest/api/dialog` [CITED]
- Electron `safeStorage` — Windows backend is DPAPI, user-bound: `https://www.electronjs.org/docs/latest/api/safe-storage` [CITED]
- RFC 4180 — quoting, CRLF, doubled quotes: `https://www.rfc-editor.org/rfc/rfc4180` [CITED]
- OWASP CSV Injection — `= + - @` prefixes: `https://owasp.org/www-community/attacks/CSV_Injection` [CITED]
- POSIX `rename(2)` — `EXDEV` across filesystems: `https://man7.org/linux/man-pages/man2/rename.2.html` [CITED]

### Tertiary (LOW confidence)
- Excel-specific BOM/encoding behaviour ([ASSUMED] — see A1). Verify once in UAT.

---

## Metadata

**Confidence breakdown:**
- Standard stack: **HIGH** — no new dependencies; every module used already exists in the repo and was read this session.
- Architecture: **HIGH** — the mutation-path and derived-stats designs are constrained by CONTEXT.md and by the concrete code paths cited above.
- Deletion completeness: **HIGH** for the four in-app surfaces (each traced to a file:line); **MEDIUM** for the "already pasted elsewhere / Windows clipboard" residual, which is a product statement rather than a code path.
- Storage move: **MEDIUM** — the copy→verify→journal→delete sequence is standard, but cross-volume behaviour on Windows and the mid-move crash recovery are argued from POSIX semantics plus design, not from an executed probe in this session.
- CSV/Excel: **MEDIUM** — format rules are cited; Excel's actual rendering is unverified (A1).

**Research date:** 2026-10-22
**Valid until:** ~2026-11-21 (30 days — Electron and the repo's own modules are stable; no fast-moving external API is involved)

