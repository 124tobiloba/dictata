# Dictata

## What This Is

Dictata is a Windows dictation app: hold a hotkey, speak, and clean written text appears
in whatever app has focus. It is the open-source alternative to Wispr Flow — you bring
your own Gemini API key, nothing is routed through a Dictata server, and a local
dashboard shows exactly what was said, how long it took, and whether it landed.

The v1.0 audience is **regulated teams** (legal, medical, finance, government
contractors): people who would use dictation all day but cannot send audio to a vendor
they have not vetted, and who need deletion, export, and an audit trail they control.

## Core Value

**A regulated professional's words never leave their machine except to the model
endpoint they chose — and they can prove it, delete it, and export it at any time.**

If everything else fails, dictation must still be reliable, private by default, and
fully erasable.

## Business Context

- **Customer**: Privacy-constrained professional teams (legal, clinical, finance, public sector) on Windows; individual power users adopt first.
- **Revenue model**: MIT-licensed core, free forever with a BYO key. Paid Pro (later: meetings/notetaker, hosted STT, team policy, sync) and self-host support contracts.
- **Success metric**: 10 paying seats or 3 signed pilot teams within 90 days of public launch, and 1,000 GitHub stars as the top-of-funnel proxy.
- **Strategy notes**: Competitive field is crowded (FluidVoice, OpenWhispr, VoiceInk, freeflow); differentiation is Windows-first quality, a local activity dashboard, and compliance-grade data control. Meetings/notetaker is the intended first Pro feature.

## Requirements

### Validated

<!-- Shipped and confirmed valuable in the existing codebase. -->

- ✓ Push-to-talk dictation via a global hotkey, with hands-free mode and double-tap lock — existing
- ✓ Gemini transcription + text cleanup in a single request, pasted into the focused app — existing
- ✓ Model fallback chain when the primary model is busy — existing
- ✓ API key encrypted at rest through the OS keystore (Electron `safeStorage`) — existing
- ✓ Custom dictionary and find/replace rules applied before paste — existing
- ✓ Persistent transcript history (500 entries) with an in-app History window (paste again, delete) — existing
- ✓ Local web dashboard on 127.0.0.1 with token auth, live SSE feed, history, analytics, shortcuts — existing
- ✓ Failed attempts surfaced in history as problem rows (`Audio is silent`, `No speech detected`) — existing
- ✓ Tray app, settings window, start-with-Windows, rotating local log — existing
- ✓ Test suites: 68 unit tests, 11 dashboard integration tests, paste/API/mic probes — existing

### Active

<!-- v1.0: ship publicly to regulated teams. -->

- [ ] Delete a single dictation from the dashboard history (affordance hidden until hover/click)
- [ ] Clear all history from the dashboard, behind a confirmation
- [ ] Deletion purges the transcript from history, activity feed, and every dashboard count
- [ ] Export history as JSON and CSV for compliance records
- [ ] Configurable retention window (30/90/365 days, or keep forever)
- [ ] Verifiable local-only mode: an offline switch that refuses cloud calls rather than leaking
- [ ] Published data-flow document stating exactly what leaves the machine and when
- [ ] Signed Windows installer and signed auto-update channel
- [ ] First-run onboarding: API key, microphone test, hotkey confirmation
- [ ] MIT LICENSE, SECURITY.md, and a self-host / BAA deployment guide
- [ ] Audit-log export (timestamp, app target, duration, outcome — no transcript)
- [ ] Public launch: README demo GIF, launch posts, and a privacy-first landing page

### Out of Scope

- **Cloud account system / login** — the product is local-first; accounts would contradict the core value.
- **Telemetry or usage analytics** — cannot ask regulated teams to accept phone-home behaviour.
- **Mobile app** — Windows-first focus; a PWA could reuse the dashboard later.
- **Reselling Gemini API access** — no margin, and it turns Dictata into a data processor.
- **Demo/sample data in the dashboard** — the dashboard must only ever show the user's real dictation.
- **Meeting capture in v1.0** — deferred to the first Pro milestone so launch scope stays shippable.

## Context

- Brownfield Electron app (`src/main` main process, `src/renderer` windows, `src/dashboard` local web UI), Node 20+, no bundler, no framework.
- Codebase map in `.planning/codebase/` (STACK, ARCHITECTURE, STRUCTURE, CONVENTIONS, TESTING, INTEGRATIONS, CONCERNS).
- The app was renamed from "Voice Flow" to "Dictata" in commit `0439ed1`; user data migrates automatically from `%APPDATA%\voice-flow` to `%APPDATA%\Dictata`.
- Known friction: Chrome's fake-audio device delivers pure silence in this Chromium build, so automated end-to-end dictation tests need a real microphone; faint audio can produce hallucinated short transcripts.
- Dashboard port defaults to 7788 and falls back to the next free port; bookmarked URLs survive restarts because the token is persisted.
- Competitive reference points: Wispr Flow (paid, cloud), FluidVoice (macOS-first, GPL), OpenWhispr (MIT, BYOK, cross-platform), VoiceInk (macOS, paid licence).

## Constraints

- **Tech stack**: Electron 44 + vanilla JS/HTML/CSS; no framework or bundler — keeps the OSS contribution surface small.
- **Platform**: Windows 10/11 x64 only for v1.0; clipboard-paste and `SetForegroundWindow` behaviour is Windows-specific.
- **Privacy**: transcripts and audio must never be written to a remote service, and audio must not be persisted to disk by default.
- **Compliance**: regulated buyers need deletable, exportable data and a written data-flow statement before pilots.
- **Distribution cost**: code signing certificates and auto-update infrastructure are real recurring costs — they justify the Pro tier.
- **Licensing**: MIT core with a proprietary Pro module; the brand and trademark are the defensible asset.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Rename Voice Flow → Dictata | "Voiceflow" is an existing funded company; trademark risk and a crowded voice-name space | — Pending |
| MIT core + proprietary Pro module | Maximises adoption and community trust while preserving a commercial path | — Pending |
| Windows-first, not cross-platform | Most OSS competitors are macOS-first; Windows paste/hotkey quality is the open gap | — Pending |
| Local dashboard as a differentiator | No competitor exposes a live, auditable record of dictation; it also doubles as the compliance surface | ✓ Good |
| Target regulated teams for v1.0 | Highest willingness to pay for privacy, deletion, and auditability | — Pending |
| Meetings deferred to the first Pro milestone | Launch scope must stay shippable; meetings need loopback capture and diarization | — Pending |
| Dashboard token persisted across restarts | Bookmarked URLs keep working; a rotating token broke user trust | ✓ Good |
| No demo mode, ever | Showing fabricated transcripts in a privacy tool destroys credibility | ✓ Good |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Business Context check — customer, revenue model, success metric still accurate?
4. Audit Out of Scope — reasons still valid?
5. Update Context with current state (users, feedback, metrics)

---
*Last updated: 2026-10-22 after initialization*
