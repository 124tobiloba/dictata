---
phase: 01
review: 01-REVIEW.md
fix_report: 01-REVIEW-FIX.md
updated: 2026-10-22
counts:
  critical: 1
  warning: 4
  info: 8
  fixed: 5
  open: 8
  skipped: 0
status: open
---

# Phase 1 Review Disposition

One row per finding. `fixed` means the fix is committed and covered by a test;
`open` means the finding stands and is carried forward.

| ID | Severity | Disposition | Source | Notes |
| --- | --- | --- | --- | --- |
| CR-01 | critical | fixed | `0e212ef` | `Store` refuses every write when a relocated folder has no `dictata.json`; `main.js` passes `readonly`, publishes a `storage` error and shows cause+remedy. Regression test drives token save, history add, settings update and flush against a missing record. |
| WR-01 | warning | fixed | `5476be1` | Target files are registered in `created` before `copyFileSync`, so a mid-copy throw removes the partial target and the folder stays retryable; `recoverMove` keeps the journal and warns instead of silently clearing it. |
| WR-02 | warning | fixed | `67b20d5` | `requestSingleInstanceLock()` now runs before storage resolution, so a second instance cannot mutate the pointer mid-move. |
| WR-03 | warning | fixed | `58c7489` | Pure `sweepSummary()`; the dashboard is notified when history rows, events, or both expire. |
| WR-04 | warning | fixed | `f51cbd5` | One shared `wordsOf()` reduction feeds `computeStats`, `totals.words`, `todayWords` and the daily buckets; a stale stored `words` value can no longer diverge. |
| IN-01 | info | open | — | Duplicated JSDoc block on `clearAllData`. Cosmetic; no behaviour risk. |
| IN-02 | info | open | — | A retention change does not report how many rows it removed. UX gap, not a correctness bug. |
| IN-03 | info | open | — | `getPrivacyFacts` reports the raw stored `retentionDays` value rather than a normalised one. |
| IN-04 | info | open | — | DELETE routes have no Origin guard (the POST does). Mitigated by the token check ahead of the mutation; kept as defence-in-depth debt. |
| IN-05 | info | open | — | The retention sweep runs inside the pipeline `try`, so a sweep failure would be reported as a failed dictation and could add a duplicate audit row. Edge case; carried forward. |
| IN-06 | info | open | — | Some page tests assert string literals that would also pass for a no-op implementation. |
| IN-07 | info | open | — | The `main.js` retention wiring (the union of expired history ids and expired event ids passed to `bus.forgetMany`) has no direct test. |
| IN-08 | info | open | — | `/api/state` and `/api/events` are matched before any method check; they are read-only today. |

## Verdict

Every Critical and Warning finding is fixed and tested; the suite went from 164 to 173
passing tests with no regressions. The eight open items are Info-grade: three are cosmetic
or UX, three are defence-in-depth/coverage gaps, and two are edge-case paths that cannot
lose data. None of them is a precondition for phase verification.
