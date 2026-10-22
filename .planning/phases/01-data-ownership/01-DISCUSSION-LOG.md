# Phase 1: Data Ownership - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-10-22
**Phase:** 01-Data Ownership
**Areas discussed:** Where the data controls live, Retention semantics, Delete scope & safety, Export & audit shape

---

## Where the data controls live

| Option | Description | Selected |
|--------|-------------|----------|
| Settings owns config | Dashboard gets per-row delete + clear-all; Settings gets a new "Privacy & Data" panel owning retention, storage, and exports | ✓ |
| Everything in dashboard | Dashboard owns everything, including a folder picker via a new POST endpoint | |
| Split: config vs actions | Settings owns retention/storage; dashboard owns delete, clear-all, and exports | |

**User's choice:** Settings owns config.
**Notes:** The folder picker only exists in the main process, and keeping the dashboard GET-only avoids a privileged write surface in a browser tab.

| Option | Description | Selected |
|--------|-------------|----------|
| Read-only facts + link | Dashboard shows retention and storage as facts with a link to Settings | ✓ |
| Don't show them | Dashboard hides retention/storage entirely | |
| Editable in dashboard | Dashboard gets an inline editor and write endpoints | |

**User's choice:** Read-only facts + link.

---

## Retention semantics

| Option | Description | Selected |
|--------|-------------|----------|
| Keep forever by default | Matches today; no surprise deletion on upgrade | ✓ |
| 90 days by default | Privacy-forward, but silently deletes existing rows | |
| 30 days by default | Most aggressive data minimisation | |

**User's choice:** Keep forever by default.

| Option | Description | Selected |
|--------|-------------|----------|
| Launch + after each dictation | Deterministic, no timer; dashboard always correct | ✓ |
| Launch + hourly timer | Also purges while idle in tray; second code path | |
| Dashboard load only | Cheapest, but stale rows persist | |

**User's choice:** On launch + after each dictation.

---

## Delete scope & safety

| Option | Description | Selected |
|--------|-------------|----------|
| Recompute from remaining history | Totals always equal the visible record; also fixes the 500-entry cap drift | ✓ |
| Leave lifetime counters alone | Totals keep including deleted dictations | |
| Track both lifetime and current | Two totals, more UI and more explaining | |

**User's choice:** Recompute from remaining history.

| Option | Description | Selected |
|--------|-------------|----------|
| Deletable like any row | Failed attempts are part of the record and must be removable | ✓ |
| Keep failures permanently | Clear-all could never reach zero | |

**User's choice:** Deletable like any row.

| Option | Description | Selected |
|--------|-------------|----------|
| Inline two-step confirm | Trash hidden at rest; first click morphs row into Delete/Cancel | ✓ |
| Delete now + undo toast | One click, 5s undo window | |
| Modal per row | Native/browser confirm dialog per delete | |

**User's choice:** Inline two-step confirm.

| Option | Description | Selected |
|--------|-------------|----------|
| Mirror deletions | Tray History window reflects deletions immediately | ✓ |
| Leave it independent | Stale rows stay until restart and can re-paste deleted text | |

**User's choice:** Mirror deletions.

---

## Export & audit shape

| Option | Description | Selected |
|--------|-------------|----------|
| Separate metadata ledger | Metadata-only ledger survives transcript deletion; proves activity without retaining text | ✓ |
| Derive from history | Zero new storage; deleting text erases all evidence | |
| Ledger + purge option | Ledger plus a "also clear audit log" checkbox on clear-all | |

**User's choice:** Separate metadata ledger.

| Option | Description | Selected |
|--------|-------------|----------|
| Move it, verify, delete old | Store moves to the chosen folder; verify read-back before removing the old file | ✓ |
| Copy, keep the original | Leaves an unmanaged duplicate of transcripts behind | |
| Start fresh in new folder | Fastest, but looks like data loss | |

**User's choice:** Move it, verify, delete old.

| Option | Description | Selected |
|--------|-------------|----------|
| Keep until explicitly cleared | Audit metadata outlives transcript retention; explicit clear only | ✓ |
| Follow the transcript window | Loses the ability to prove historical activity | |
| Cap at N entries | Bounded file, but an arbitrary cutoff in a compliance artifact | |

**User's choice:** Keep until explicitly cleared.

---

## the agent's Discretion

- Export filenames, CSV column order, and file naming convention.
- Whether the audit ledger is a sidecar file or part of `dictata.json`.
- Confirmation copy and "Privacy & Data" panel layout.
- Whether delete/clear emit an `info` event afterwards (leaning yes).
- Delete keyboard shortcut, if any.

## Deferred Ideas

- Date-range and scheduled exports.
- Encrypted-at-rest transcript store.
- Per-entry detail view / copy button.
- In-app audit ledger viewer.
- Team-admin retention policy (future Pro/Teams tier).
