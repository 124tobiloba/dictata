# Requirements: Dictata

**Defined:** 2026-10-22
**Core Value:** A regulated professional's words never leave their machine except to the model endpoint they chose — and they can prove it, delete it, and export it at any time.

## v1 Requirements

Requirements for the v1.0 public launch. Each maps to exactly one roadmap phase.

### History & Data Ownership

- [ ] **DATA-01**: User can delete a single dictation from the dashboard history via an affordance that stays hidden until the row is hovered or clicked
- [ ] **DATA-02**: User can clear the entire history from the dashboard, protected by an explicit confirmation step
- [ ] **DATA-03**: Deleting a dictation removes it from history, the activity feed, analytics counts, and the in-app History window — with no resurrection after a restart
- [ ] **DATA-04**: User can export the full history as JSON and as CSV
- [ ] **DATA-05**: User can choose a retention window (30 / 90 / 365 days, or keep forever) and older transcripts are purged automatically

### Privacy

- [ ] **PRIV-01**: User can enable an offline mode that disables every outbound request; dictation refuses with a clear message instead of sending audio
- [ ] **PRIV-02**: A published data-flow document lists every outbound request, its destination, and what it contains
- [ ] **PRIV-03**: The dashboard is verified to bind to loopback only, reject requests without a valid token, and reject foreign Host headers
- [ ] **PRIV-04**: A network-egress test proves the app makes no telemetry or update-ping request while offline mode is on

### Distribution & Trust

- [ ] **REL-01**: User can install a signed NSIS package that Windows does not flag as an unknown publisher
- [ ] **REL-02**: Installed copies update themselves from a signed update channel, with the version visible in Settings
- [ ] **REL-03**: A first-run flow collects the API key, runs a microphone check, and confirms the dictation shortcut before the first dictation
- [ ] **REL-04**: Every release ships a changelog entry and a version bump visible in the tray menu and dashboard footer

### Compliance

- [ ] **COMP-01**: User can export an audit log containing timestamp, target app, duration, model, and outcome — never transcript text
- [ ] **COMP-02**: User can point transcript storage at a different folder, including an encrypted or network-mounted volume
- [ ] **COMP-03**: A self-host / BAA deployment guide explains how to run Dictata with no vendor data processing
- [ ] **COMP-04**: Repository ships an MIT LICENSE, SECURITY.md with a disclosure process, and a contributing guide

### Launch

- [ ] **LAUN-01**: README leads with a 30-second demo, the BYO-key setup, and the privacy guarantee
- [ ] **LAUN-02**: A launch kit exists: landing-page copy, screenshots, and posts for GitHub, Reddit, and Hacker News
- [ ] **LAUN-03**: A pilot pack lets a regulated team evaluate Dictata: security questionnaire answers, data-flow diagram, and a 15-minute trial script

## v2 Requirements

Deferred. Tracked, but not in the current roadmap.

### Meetings

- **MEET-01**: User can capture system audio plus microphone during a call (WASAPI loopback) without a virtual cable
- **MEET-02**: Meeting transcript separates speakers by channel (microphone vs system)
- **MEET-03**: Meeting produces a summary and action items saved into history

### Engine

- **ENG-01**: User can run fully local transcription (whisper.cpp or Parakeet) with no API key
- **ENG-02**: User can choose a model per dictation profile (fast / accurate)

### Writing

- **WRIT-01**: User can issue spoken transforms ("make it shorter", "turn this into an email")
- **WRIT-02**: Per-app writing profiles (code, chat, email)
- **WRIT-03**: Snippets and text expansion triggered by spoken phrases

### Teams

- **TEAM-01**: Shared dictionary and snippets across a team
- **TEAM-02**: Admin policy controls (retention, offline mode, allowed models)
- **TEAM-03**: Encrypted sync between a user's machines

## Out of Scope

| Feature | Reason |
|---------|--------|
| Cloud account / login | Contradicts the local-first core value; regulated buyers reject it |
| Telemetry or usage analytics | Cannot ask privacy-constrained teams to accept phone-home behaviour |
| Reselling Gemini API access | Zero margin, and it makes Dictata a data processor |
| Mobile app | Windows-first for v1.0; a PWA can reuse the dashboard later |
| Demo or sample transcripts | Fabricated data in a privacy tool destroys credibility |
| Auto-paste into elevated (admin) windows | Requires a signed helper service; defer until a paying pilot asks |
| macOS / Linux builds | The hotkey and paste layers are Windows-specific; porting dilutes launch quality |

## Traceability

Populated during roadmap creation (2026-10-22).

| Requirement | Phase | Status |
|-------------|-------|--------|
| DATA-01 | Phase 1 — Data Ownership | Pending |
| DATA-02 | Phase 1 — Data Ownership | Pending |
| DATA-03 | Phase 1 — Data Ownership | Pending |
| DATA-04 | Phase 1 — Data Ownership | Pending |
| DATA-05 | Phase 1 — Data Ownership | Pending |
| COMP-01 | Phase 1 — Data Ownership | Pending |
| COMP-02 | Phase 1 — Data Ownership | Pending |
| REL-01 | Phase 2 — Trusted Distribution | Pending |
| REL-02 | Phase 2 — Trusted Distribution | Pending |
| REL-03 | Phase 2 — Trusted Distribution | Pending |
| REL-04 | Phase 2 — Trusted Distribution | Pending |
| PRIV-01 | Phase 3 — Provable Privacy | Pending |
| PRIV-02 | Phase 3 — Provable Privacy | Pending |
| PRIV-03 | Phase 3 — Provable Privacy | Pending |
| PRIV-04 | Phase 3 — Provable Privacy | Pending |
| COMP-03 | Phase 4 — Compliance Pack & Public Launch | Pending |
| COMP-04 | Phase 4 — Compliance Pack & Public Launch | Pending |
| LAUN-01 | Phase 4 — Compliance Pack & Public Launch | Pending |
| LAUN-02 | Phase 4 — Compliance Pack & Public Launch | Pending |
| LAUN-03 | Phase 4 — Compliance Pack & Public Launch | Pending |

**Coverage:**
- v1 requirements: 20 total
- Mapped to phases: 20
- Unmapped: 0 ✓

**Per-phase counts:**
- Phase 1 — Data Ownership: 7 (DATA-01…05, COMP-01, COMP-02)
- Phase 2 — Trusted Distribution: 4 (REL-01…04)
- Phase 3 — Provable Privacy: 4 (PRIV-01…04)
- Phase 4 — Compliance Pack & Public Launch: 5 (COMP-03, COMP-04, LAUN-01…03)

---
*Requirements defined: 2026-10-22*
*Last updated: 2026-10-22 after roadmap creation*
