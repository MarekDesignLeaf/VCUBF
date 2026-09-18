# Voice reliability update — 18 September 2026

This change adds the NPU speech-energy gate, bounded decoding, token confidence,
tolerant wake verification, two-tier transcription, and transcript rejection.
The actual NPU receiver rejects recognised noise before calling accurate STT.
It preserves cloud recovery for an empty uncertain decode and low-confidence
short responses. Backend filtering normalises diacritics and rejects recognised
hallucination shapes. No permissions or business-action authority is expanded.

Verification before commit:
- Working-tree backend suite: 607 passed, 0 failed, 74 files, Node 24.21.0 x64
  and disposable PostgreSQL 18.4 using the project serial runner.
- All 29 migrations applied successfully to a separate empty PostgreSQL DB;
  migrate status reported the schema up to date.
- 21 voice tests passed against the working tree and installed runtime.
  The new receiver regression failed on four noise fixtures against the old
  installed runtime, then passed after the repair.
- Four existing noise recordings were rejected by the installed sidecar and
  decision checker. This is not complete acoustic-wake/cloud/action acceptance.

The full-suite and migration results include other uncommitted work and must
not be represented as tests solely of this focused commit. Its exact staged
snapshot passed 21 Python voice tests, 14 mocked backend transcription tests
and TypeScript checking before committing.

Still incomplete: the application PostgreSQL service is stopped and could not
be started with available process rights; no live migration was applied.
The four original Czech speech recordings were not found. Real microphone,
cloud transcription, interruption, Android/browser and business-action
acceptance remain outstanding. No microphone session was started here.

The installed runtime was updated with the receiver repair and its previous
copy was preserved. Broader pre-existing changes remain outside this commit.
