# Roadmap: Dictata

## Milestones

- 🚧 **v1.0 Public Launch** — Phases 1-4 (in progress)

v2 requirements (meetings, local engine, writing transforms, team sync) are tracked in
`.planning/REQUIREMENTS.md` but are deliberately not roadmapped yet.

## Overview

Dictata already dictates: hotkey, Gemini transcription, paste, encrypted key, history,
dashboard, and a green test suite all ship today. v1.0 is not a feature sprint — it is the
work that turns a working local tool into something a regulated team can install, audit, and
defend to a compliance officer.

The journey is four slices, each ending in a capability a buyer can try:

1. **Data ownership** — the record becomes truly erasable, expirable, relocatable, and
   exportable, which is what the core value promises and what currently blocks every pilot.
2. **Trusted distribution** — a signed installer, a signed update channel, and a first-run
   flow, so adoption no longer requires a developer or a terminal.
3. **Provable privacy** — an offline switch plus a data-flow document and an egress test,
   so the privacy claim is verifiable by an outside reviewer, not just asserted.
4. **Compliance pack & launch** — the license, security policy, deployment guide, and launch
   materials that let a pilot start and a stranger find the product.

Phases 2 and 3 are ordered deliberately: the auto-updater is itself an outbound request, so
the offline switch and the data-flow document must be written after it exists, not before.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Data Ownership** - Delete, expire, relocate, and export the dictation record from the dashboard
- [ ] **Phase 2: Trusted Distribution** - Signed installer, signed auto-update, first-run onboarding, visible versioning
- [ ] **Phase 3: Provable Privacy** - Offline switch, published data-flow document, dashboard hardening, egress test
- [ ] **Phase 4: Compliance Pack & Public Launch** - License, security policy, self-host guide, pilot pack, launch kit

## Phase Details

### Phase 1: Data Ownership
**Goal**: A regulated user can remove, expire, relocate, and export their dictation record from the dashboard — and every surface agrees on what remains.
**Mode:** mvp
**Depends on**: Nothing (brownfield baseline — dictation, history, and dashboard already ship)
**Requirements**: DATA-01, DATA-02, DATA-03, DATA-04, DATA-05, COMP-01, COMP-02
**Success Criteria** (what must be TRUE):
  1. User can delete a single dictation from a history row using an affordance that stays invisible until the row is hovered or selected, and the row disappears immediately.
  2. User can clear all history only after an explicit confirmation, and afterwards the dashboard, activity feed, analytics counts, and in-app History window all report zero — including after a restart or a second deletion path.
  3. User can export the full history as JSON and as CSV, and both files open with every transcript and its metadata intact.
  4. User can export an audit log containing timestamp, target app, duration, model, and outcome, and no transcript text appears anywhere in that file.
  5. User can choose a retention window (30 / 90 / 365 days, or keep forever) and point transcript storage at another folder, and entries past the window are gone from every surface after a restart.
**Plans**: 3 plans

### Phase 2: Trusted Distribution
**Goal**: A non-developer can install, update, and complete first run on a clean Windows machine without a terminal, a manual download, or a developer on the phone.
**Mode:** mvp
**Depends on**: Phase 1 (Phase 1 changes the store schema for retention and storage paths; signing and auto-update should ship against the final data layout rather than being re-released twice)
**Requirements**: REL-01, REL-02, REL-03, REL-04
**Success Criteria** (what must be TRUE):
  1. A user can install the NSIS package on a clean Windows 11 machine and Windows shows a real publisher name in the SmartScreen/UAC prompt instead of "unknown publisher".
  2. An installed copy checks a signed update channel and applies a newer release itself, with the new version number shown in Settings afterwards.
  3. On first launch a new user is walked through API key entry, a microphone check that shows live input level, and a hotkey confirmation, and cannot reach a broken first dictation.
  4. Every release carries a changelog entry and the same version string is visible in the tray menu, Settings, and the dashboard footer.
**Plans**: 3 plans

### Phase 3: Provable Privacy
**Goal**: An outside reviewer can verify — without reading the source — that Dictata's only outbound traffic is the model call the user configured, and that the user can switch it off.
**Mode:** mvp
**Depends on**: Phase 2 (the offline switch must cover the update channel, and the data-flow document must describe it, so both must exist first)
**Requirements**: PRIV-01, PRIV-02, PRIV-03, PRIV-04
**Success Criteria** (what must be TRUE):
  1. User can enable offline mode and a dictation attempt refuses with a clear message instead of sending audio; disabling it restores dictation.
  2. A network capture across a full session with offline mode on shows zero outbound requests from Dictata, including no update check or telemetry ping.
  3. The published data-flow document lists every outbound request with its destination, trigger, and payload, and matches that capture — the model call is the only entry when offline mode is off and the user dictates.
  4. The dashboard refuses requests without a valid token, from a non-loopback address, or with a foreign Host header, and an automated test proves each rejection.
**Plans**: 2 plans

### Phase 4: Compliance Pack & Public Launch
**Goal**: A regulated team can complete a security review and start a pilot, and a stranger can discover, trust, and install Dictata on launch day.
**Mode:** mvp
**Depends on**: Phase 3 (launch copy and the pilot pack must state the privacy guarantee that Phase 3 proves)
**Requirements**: COMP-03, COMP-04, LAUN-01, LAUN-02, LAUN-03
**Success Criteria** (what must be TRUE):
  1. The repository ships an MIT LICENSE, a SECURITY.md with a disclosure contact and process, and a contributing guide, so a stranger knows how to report a vulnerability without reading code.
  2. A self-host / BAA deployment guide explains step by step how a team runs Dictata with no vendor data processing, and someone can follow it without asking the maintainer.
  3. The README opens with a 30-second demo, the bring-your-own-key setup, and the privacy guarantee.
  4. A launch kit exists with landing-page copy, screenshots, and ready-to-post text for GitHub, Reddit, and Hacker News.
  5. A pilot pack exists with security questionnaire answers, the data-flow diagram, and a 15-minute trial script a regulated team can run unaided.
**Plans**: 2 plans

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Data Ownership | 0/3 | Not started | - |
| 2. Trusted Distribution | 0/3 | Not started | - |
| 3. Provable Privacy | 0/2 | Not started | - |
| 4. Compliance Pack & Public Launch | 0/2 | Not started | - |

**Already shipped (not in scope for these phases):** push-to-talk and hands-free dictation,
Gemini transcription plus cleanup with model fallback, encrypted API key, custom dictionary
and find/replace, 500-entry history with re-paste and delete, local dashboard with SSE feed
and analytics, tray app, settings window, start-with-Windows, rotating log, and the existing
test suites.
