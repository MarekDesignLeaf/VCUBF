# Secretary voice integration — 19 September 2026

This update reconciles pending voice source changes with the committed business
features. It does not certify production readiness or canonical SEC V9/V10.

## Changes

- Windows listener heartbeat, explicit pause/resume, bounded TTS buffering,
  playback interruption/echo classification and provider fallback are versioned.
- Installation preserves an existing speech-provider choice rather than overriding
  it because of a credential failure observed on a different machine.
- Backend aliases, macros, speech preferences, client confirmation, and associated
  user-interface changes use the existing shared backend.
- The unpaid-invoice count command is deterministic for the supported Czech and
  English questions. Issued invoices with positive remaining balances are counted;
  fully paid, draft, void and other-company invoices are excluded. Partial payments
  are included. CRM read permission and company capability policy are enforced.
- Browser macro replay displays saved steps and values for review and does not
  claim business success from simulated UI interaction alone.
- Daily digest tests specify the sweep hour. Previously three tests failed before
  06:00 UTC because they depended on the real test-runner clock.
- README inventory and its drift test distinguish test files from database tests.

## Evidence and limitations

- Windows Python regression tests: 26 passed; hardware-independent checks.
- Native Python runtime self-test: passed; not microphone acceptance.
- PowerShell syntax and Picovoice JavaScript syntax checks: passed.
- Targeted unpaid-invoice and digest integration tests: passed against disposable
  PostgreSQL, with Gmail mocked. No real email was sent.
- Backend and frontend TypeScript checks: passed on the working source.
- Full staged-source validation is pending; final results are recorded below when
  available. Previous 607/607 results belong to earlier working-source snapshots.

## Remaining acceptance gates

1. Live microphone, acoustic wake detection, self-echo rejection and interruption.
2. Live browser macro replay, including changed pages and rejected backend writes.
3. Existing-data migration rehearsal and real connector delivery acceptance.
4. The Node 24 target and disputed architecture choices remain separate work.

No destructive cleanup, provider messages, production database migration or remote
push is part of this validation.
