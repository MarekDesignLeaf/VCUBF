# VCUF Cowork Instructions

These instructions apply to all Cowork, Claude Code and AI programming sessions working on this repository.

## Authoritative project

This repository, `MarekDesignLeaf/VCUBF`, is the authoritative active implementation of VCUF, the VoiceControl Universal Framework built around Secretary.

Do not treat `Secretary_Server` as the main product. It is an older FastAPI clean backend foundation and may be used only as reference material when explicitly required.

Do not treat `Secretary_Android` as the main product. It is an older Android client direction and must not drive backend architecture.

The active product is the integrated web first Secretary system in this repository:

- `backend/` is the Secretary backend and single source of truth.
- `frontend/` is the web, PWA and Capacitor client.
- `windows-companion/` is the Windows voice companion runtime.
- `docs/` contains operational and architecture documentation.

## Core architecture rule

Secretary is the central business operating system.

Voice is only the control layer.

Connectors are inputs and outputs.

The backend is the source of truth.

The frontend must not contain business logic. It displays state, receives input and confirms actions.

## Do not rebuild the wrong thing

Do not build a generic chatbot.

Do not build a macro recorder.

Do not build general desktop automation as the first product.

Do not centre the project around CorelDRAW or any other commercial software.

Do not create disconnected prototypes outside the existing backend, frontend and Windows companion structure.

Do not duplicate entities or create a second database model without reconciling it with `backend/prisma/schema.prisma`.

## Required development flow

Before changing code, identify:

1. Which module is affected.
2. Which Prisma models are affected.
3. Which API route or service owns the business logic.
4. Which permissions are required.
5. Whether the action must be audited.
6. Whether confirmation is required.
7. Whether tests already exist.
8. Which tests must be added or updated.
9. Whether live connector acceptance is required.
10. Whether documentation must be updated.

Every non-trivial change must preserve:

- multi-tenant company separation,
- permissions,
- audit trail,
- idempotency for external or repeated actions,
- source-backed data,
- no invented clients, jobs, prices, availability, reviews, photographs or credentials,
- backend ownership of business logic.

## Safety and approval rules

Read-only analysis may run without user confirmation.

Drafts and proposals may be prepared without external side effects.

Internal data changes must be permission checked and auditable.

External communication must require confirmation unless a specific approved automatic rule exists.

Public website or social publication must require confirmation.

Financial, legal, deletion, employment, connector credential and irreversible actions must require explicit confirmation and audit.

Never silently send email, publish content, delete data, change prices, confirm employment terms, submit legal forms or expose private data.

## Current operational source of truth

The current active Railway project is `VCUBF`.

Production environment contains these services:

- `backend`
- `frontend`
- `Postgres`

As of 2026-09-26, Railway reports the latest backend, frontend and Postgres deployments as successful. This does not replace live functional acceptance.

GitHub Actions CI exists and runs backend build, Prisma generation, embedded PostgreSQL tests, frontend lint and frontend build on Node 22.

Node 22 is the current validated CI runtime. Node 24 remains a target only until a real migration is completed and verified.

## Testing expectations

For backend work, run or update:

```bash
cd backend
npm ci
npm run prisma:generate
npm run build
npm run test:embedded
```

For frontend work, run or update:

```bash
cd frontend
npm ci
npm run lint
npm run build
```

For Windows voice work, also check the relevant PowerShell and Python runtime tests in `windows-companion/` and update voice documentation if behaviour changes.

Do not claim production readiness from mocked tests only.

Do not claim live microphone, live Gmail, live Google Calendar, live browser macro or live connector acceptance unless that exact live acceptance was performed and recorded.

## Language strategy

Internal code identifiers use stable English names.

Customer facing production output is primarily British English.

Owner control may support Czech and English.

Polish must be architecturally prepared but not implemented as a separate system.

Do not hardcode user-facing text directly into business logic where localisation or templates are expected.

## Source and evidence rules

The system must work only with real company data.

If data is missing, say it is missing.

If something is inferred, mark it as inference.

If something will be published, sent or used externally, its source must be clear.

Do not invent:

- services,
- references,
- certifications,
- photographs,
- clients,
- reviews,
- prices,
- experience,
- employees,
- dates,
- availability,
- work results,
- capacity,
- skills.

## Module priorities

When there is a conflict, prioritise these foundations:

1. Company, users, roles and permissions.
2. CRM, clients, leads, jobs, tasks and communications.
3. Audit and action contracts.
4. Calendar, capacity and job allocation.
5. Quotes, invoices, payments and profitability.
6. Connectors and communication intake.
7. Voice and text command layer.
8. Business growth, website review, portfolio and service catalogue.
9. Playbooks and learning.
10. Recruitment and workforce expansion.

## Required reporting format

When finishing a session, report:

- what was changed,
- files changed,
- tests run,
- tests not run and why,
- risks still open,
- exact next step.

If a task cannot be completed because access is missing, state the missing access precisely. Do not guess and do not pretend the task is complete.
