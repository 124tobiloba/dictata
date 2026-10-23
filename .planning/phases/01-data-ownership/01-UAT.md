---
status: complete
phase: 01-data-ownership
source: [01-VERIFICATION.md]
started: 2026-10-22T17:32:48Z
updated: 2026-10-23T10:51:58.131Z
---

## Current Test

[testing complete]

## Tests

### 1. Hidden delete affordance and inline confirmation (visual/keyboard)
expected: Open the dashboard history tab, hover a row, Tab to a row, activate the trash control, then use Delete and Cancel; repeat on a failed-attempt row. Invisible at rest; appears on hover/row focus/keyboard focus; the row becomes "Delete this dictation?" with Delete/Cancel; Escape cancels; Delete removes it immediately.
result: pass

### 2. Delete → immediate quit → relaunch
expected: Delete a row and quit from the tray immediately; relaunch. The row is gone from history, feed, Insights and the History window.
result: pass

### 3. Clear-all confirmation and cross-surface zero
expected: Click Clear all and read/cancel/confirm the prompt, then restart. The prompt names N dictations; afterwards every surface shows none, and settings/key/dictionary/token are intact.
result: pass

### 4. Paste-last after deleting the newest dictation
expected: Delete the newest row, focus another app, press the paste-last shortcut. The surviving newest dictation pastes; nothing when empty; never the deleted text.
result: pass

### 5. History export through the native save dialog + Excel
expected: Export history CSV and JSON from Settings, open both. Every transcript and metadata intact; Excel shows correct accents/columns; a transcript beginning `=SUM` is literal text, not a formula.
result: pass

### 6. Audit export contains no transcript text
expected: Export audit CSV/JSON and search for a word from a known transcript. Zero matches; rows carry timestamp, target app, duration, model, outcome.
result: pass

### 7. Real storage move (second drive / network share) + restart + open dashboard tab
expected: Change folder to a second drive/share, dictate once, restart, keep a dashboard tab open. Store + ledger move; restart reads the new folder; no second copy; both surfaces show the new path without reload.
result: pass

### 8. Kill mid-move and retry the same folder
expected: Kill the app between copy and commit; relaunch; retry the same folder. Record readable; the journal completes without a second copy; the retry succeeds.
result: pass

### 9. Audit count lifecycle with a real key/microphone
expected: Dictate once, cancel a recording, delete the dictation; watch the audit count. +1 for the completed attempt, unchanged for the cancel, unchanged by the deletion.
result: pass

## Summary

total: 9
passed: 9
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
