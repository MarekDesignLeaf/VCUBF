# VCUF project status — 2026-09-26

This file records the current checked state of the active Secretary implementation.

## Verdict

VCUF is an active, working MVP codebase, not just documentation.

The active implementation is `MarekDesignLeaf/VCUBF`.

The project is not yet fully production accepted. CI and Railway deployment are healthy, but several live acceptance gates remain open.

## Authoritative repositories

### Active main repository

`MarekDesignLeaf/VCUBF`

Purpose:

- integrated Secretary MVP,
- backend,
- frontend,
- Windows voice companion,
- project documentation,
- Railway deployment source.

This is the repository that future development must use unless explicitly instructed otherwise.

### Reference only

`MarekDesignLeaf/Secretary_Server`

Status:

- older FastAPI clean backend foundation,
- useful as historical/reference material,
- not the active product centre,
- must not be treated as the main implementation.

### Older client direction

`MarekDesignLeaf/Secretary_Android`

Status:

- older Android client direction,
- not the active architectural centre,
- should not drive backend design.

## Railway status checked on 2026-09-26

Railway project:

`VCUBF`

Production environment:

`production`

Services found:

- `backend`
- `frontend`
- `Postgres`

Latest deployment status:

- `backend`: SUCCESS, commit `aaa9fe9da4a55992f52eff45da0a2923414bf835`, created 2026-09-22 17:03 UTC.
- `frontend`: SUCCESS, created 2026-09-22 01:36 UTC.
- `Postgres`: SUCCESS, created 2026-08-29 13:57 UTC.

Conclusion:

The previous statement that Railway deployment was unverified is now resolved. Railway exists and the main services are deployed successfully.

This does not prove that every business feature works in production. It only proves that the Railway project, services and latest deployments exist and report successful deployment status.

## GitHub Actions status

The repository contains CI at `.github/workflows/ci.yml`.

The CI performs:

- backend npm install,
- Prisma generation,
- backend TypeScript build,
- embedded PostgreSQL backend tests,
- frontend npm install,
- frontend lint,
- frontend build.

The latest checked run for commit `aaa9fe9da4a55992f52eff45da0a2923414bf835` completed successfully.

Current validated CI runtime:

- Node 22.

Important:

Node 24 remains an architectural target only until it is migrated, tested and accepted.

## Current backend state

The active backend is in:

`backend/`

Technology:

- Node.js,
- TypeScript,
- Express,
- Prisma,
- PostgreSQL.

Key evidence:

- `backend/package.json` contains dev, build, start, Prisma, seed and embedded PostgreSQL test scripts.
- `backend/prisma/schema.prisma` contains the Secretary Core data model.
- The schema is multi-tenant from day one, with company-owned data models.
- Models already cover company, users, clients, contacts, connectors, jobs, leads, audit logs, service catalogue, quotes, invoices, job openings, candidates, playbooks, learning rules, communications, notifications, portfolio photos, website audits, tasks, voice state, assistant memories, payments and idempotency records.

Conclusion:

The backend is substantially implemented and aligned with the master VCUF direction.

## Current frontend state

The active frontend is in:

`frontend/`

Technology:

- React,
- TypeScript,
- Vite,
- Capacitor Android,
- speech recognition,
- text to speech,
- VAD web.

The frontend has build, lint, i18n audit and Android build scripts.

Conclusion:

The frontend is not a placeholder. It is an active web/PWA/Capacitor client.

## Current Windows voice companion state

The Windows companion is in:

`windows-companion/`

It contains:

- installation scripts,
- launch scripts,
- restart scripts,
- health test scripts,
- runtime PowerShell,
- runtime Python files,
- voice V2 documentation.

Recent commits show active work on:

- wake word tolerance,
- tray restart behaviour,
- OpenAI STT defaults,
- spoken memory parsing,
- dictated phone number gating.

Conclusion:

The voice layer is actively developed and versioned, but live microphone acceptance is still a separate acceptance gate.

## Resolved problems

### 1. Main repository ambiguity

Resolved by adding `CLAUDE.md` at the root of `MarekDesignLeaf/VCUBF`.

Future Cowork and Claude Code sessions must use `VCUBF` as the active implementation and must not accidentally rebuild from `Secretary_Server` or `Secretary_Android`.

### 2. Railway deployment uncertainty

Resolved by checking Railway directly.

Project `VCUBF` exists and has backend, frontend and Postgres services in production. Latest active deployments report success.

### 3. Missing Cowork session instructions

Resolved by adding root `CLAUDE.md`.

This file now defines project identity, repo authority, safety rules, testing expectations, language strategy, source of truth and required reporting format.

## Still open problems

### 1. Live functional acceptance

CI and deploy status are not the same as live business acceptance.

Still required:

- live login check,
- production backend health check,
- production frontend load check,
- production database migration check,
- production create client test,
- production create lead test,
- production create job test,
- production quote/invoice/payment smoke test,
- production calendar/capacity smoke test.

### 2. Live connector acceptance

Still required:

- live Gmail read/send acceptance,
- live Google Calendar sync acceptance,
- live Google Drive or photo storage acceptance,
- any WhatsApp or messaging connector acceptance,
- connector error handling verification.

Mocked tests do not prove live connector operation.

### 3. Live voice acceptance

Still required:

- real microphone wake detection,
- false wake rejection,
- interrupted speech handling,
- dictated phone number completion,
- live command to backend,
- live confirmation before write,
- live audit record after command.

### 4. Production URL and public access verification

The Railway services report successful deployment but the public URLs and end-to-end route behaviour were not verified in this audit.

### 5. Node 24 migration

Node 22 is currently validated.

Do not claim Node 24 support until:

- backend install works on Node 24,
- backend build works on Node 24,
- embedded PostgreSQL tests pass on Node 24,
- frontend lint and build pass on Node 24,
- Railway build/runtime is confirmed on Node 24.

## Required next operational check

Run this from a clean local checkout or CI-like machine:

```bash
git clone https://github.com/MarekDesignLeaf/VCUBF.git
cd VCUBF/backend
npm ci
npm run prisma:generate
npm run build
npm run test:embedded
cd ../frontend
npm ci
npm run lint
npm run build
```

Then run production smoke tests against Railway:

1. Open frontend.
2. Log in.
3. Check backend health/version endpoint.
4. Create a temporary client.
5. Create a temporary lead.
6. Create a temporary job.
7. Create a temporary task.
8. Check that audit log records the actions.
9. Delete or archive test records through approved safe flow.
10. Record results in `docs/PRODUCTION_ACCEPTANCE_LOG.md`.

## Current status label

Use this wording:

`VCUF Secretary MVP is implemented, deployed and CI passing, but not fully production accepted.`

Do not use this wording yet:

`Production ready.`

Do not use this wording yet:

`Fully autonomous business operating system.`

Do not use this wording yet:

`All connectors are live.`
