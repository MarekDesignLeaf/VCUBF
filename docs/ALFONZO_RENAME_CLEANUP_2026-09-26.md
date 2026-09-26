# Alfonzo rename cleanup — 2026-09-26

This document records the cleanup after the assistant was renamed from Emma to Alfonzo.

## Canonical name

The canonical assistant name is:

`Alfonzo`

Use `Alfonzo` for all new user-facing text, launcher names, documentation and runtime entry points.

## Changes made

### Added canonical Windows launcher

New file:

`windows-companion/VCUBF-Alfonzo.ps1`

Purpose:

- human-facing Alfonzo launcher,
- forwards to the old runtime file for compatibility,
- avoids breaking already installed Windows shortcuts or startup entries.

### Added canonical Python module wrappers

New files:

`windows-companion/alfonzo_common.py`

`windows-companion/alfonzo_realtime.py`

Purpose:

- provide Alfonzo-facing import and execution entry points,
- keep old `emma_common.py` and `emma_realtime.py` as compatibility modules until installed clients are migrated.

### Added repository rule

Updated:

`CLAUDE.md`

The repository instructions now state that `Alfonzo` is the canonical assistant name and that new `Emma` naming must not be introduced.

## Known remaining legacy names

The following are intentionally not removed in this step.

### Historical Prisma migrations

Do not rename already applied migrations:

`backend/prisma/migrations/20260714195000_add_emma_function_policy`

`backend/prisma/migrations/20260802120000_wake_word_hej_emma`

Reason:

Prisma migration history must remain stable after production deployment. Renaming historical migration folders can desynchronise local and production migration state.

### Legacy Windows runtime file

Existing file retained:

`windows-companion/VCUBF-Emma.ps1`

Reason:

Already installed shortcuts, autostart entries or user machines may still point to this file. The new canonical launcher calls this runtime file until the installed Windows companion migration is confirmed.

### Legacy Python runtime files

Existing files retained:

`windows-companion/emma_common.py`

`windows-companion/emma_realtime.py`

Reason:

The current runtime may still import these modules. The new `alfonzo_*` files are compatibility-safe wrappers, not a destructive rename.

### Prisma model and database column names

Known legacy Prisma property names and database mappings may still exist:

- `emmaDisabledCapabilities`
- `emmaBehaviorScenario`
- `emmaBehaviorEnabled`
- `emmaBehaviorUpdatedAt`
- `emma_disabled_capabilities`
- `emma_behavior_scenario`
- `emma_behavior_enabled`
- `emma_behavior_updated_at`

Recommended future migration path:

1. Rename Prisma properties to neutral `assistant...` names.
2. Keep `@map("emma_...")` temporarily if database columns are not renamed.
3. Add a tested Prisma migration only if database columns are also renamed.
4. Run local embedded PostgreSQL tests.
5. Run Railway staging or production migration rehearsal before production deployment.

## Rule for future work

New code must not introduce `Emma`, `Ema`, `emma_*` or `VCUBF-Emma` naming unless the change is explicitly a compatibility shim or historical migration reference.

New canonical names should use:

- `Alfonzo`
- `alfonzo_*`
- `VCUBF-Alfonzo`
- `assistant*` for backend-neutral data model names

## Current status

This cleanup resolves the most visible new entry point problem without breaking production or installed Windows clients.

It does not claim that every legacy `Emma` identifier has been removed. Full removal requires a tested runtime migration and, separately, a database/schema migration decision.
