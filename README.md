# VCUF — Secretary Web App (MVP)

Web frontend + backend for **VCUF (VoiceControl Universal Framework)**, built around
**Secretary** as the single source of truth. See the master documentation in the parent
project folder (`VCUF_Master_Documentation_Secretary_Voice_Control_EN.docx`) for the full
architecture.

This repo covers three vertical slices of the MVP: **Secretary Core** (auth,
permissions, audit log), **CRM Core** (clients, jobs), and **Lead Intake Module** (leads).

## Structure

```
backend/    Node.js + TypeScript + Express + Prisma + PostgreSQL (Secretary backend API)
frontend/   React + TypeScript + Vite (web client — desktop and Android via PWA)
```

## Why web-first

Per the architecture, the frontend must contain no business logic — it only displays
state and confirms actions (see doc section 41). A single web/PWA codebase covers desktop
and Android without a separate native build; a native Android wrapper (for offline/push)
and a Tauri/Electron desktop wrapper can be added later over the same API without
rewriting anything.

## Backend — local setup

```bash
cd backend
cp .env.example .env        # edit DATABASE_URL if needed
npm install
docker compose up -d        # starts local Postgres on :5432
npm run prisma:migrate      # creates the schema
npm run seed                # creates admin@example.com / ChangeMe123!
npm run dev                 # http://localhost:4000
```

Run tests (needs a real Postgres reachable via `DATABASE_URL`):

```bash
npm test
```

Or run tests with a disposable embedded Postgres (no Docker required):

```bash
npm run test:embedded
```

## Frontend — local setup

```bash
cd frontend
cp .env.example .env        # VITE_API_URL, defaults to http://localhost:4000
npm install
npm run dev                 # http://localhost:5173
```

## What's implemented

- **Auth**: `POST /auth/login`, `GET /auth/me`, JWT, bcrypt password hashing.
- **Permission Engine**: every route checks the user's permission list (see doc section 30).
- **Audit Engine**: every mutating action (client create, job create, job status change —
  success, validation failure, rejection) writes an audit_log row: who, what, risk level,
  result, and before/after state where relevant (doc section 37).
- **CRM Core — Clients**: create (with duplicate detection by email or name+phone),
  list, get, search. Action Contract for `create_client` lives in
  `backend/src/lib/actionContracts.ts` as structured data, not a prompt.
- **CRM Core — Jobs**: create (linked to an existing client, validated against
  cross-tenant access), list (filterable by client/status), get, and status change along
  a fixed lifecycle (`nova → naplanovano → v_realizaci → ceka_na_material /
  ceka_na_klienta → dokonceno / zruseno`). Action Contracts: `create_job`,
  `change_job_status`. Status codes are stable ASCII technical names — display labels
  live in the frontend's translation layer (`JOB_STATUS_LABELS`), not hardcoded into
  the backend, per the language rule.
- **Frontend**: login, dashboard shell, clients list/detail/create, jobs list/detail
  with a status-change dropdown, "new job" form embedded on the client detail page
  (a job cannot be created without picking an existing client — no orphan jobs).
- **Lead Intake Module — Leads**: create (manual entry), list (filterable by status),
  get, and **convert to client** — creates a real CRM Core client from the lead's
  contact details (or reuses an existing client with a matching email, so conversion
  never forks a duplicate), links the lead to the resulting client, and marks the
  lead `converted`. A lead cannot be converted twice (409 `UNSUPPORTED_ACTION`).
  Action Contracts: `create_lead`, `convert_lead_to_client`.
- **Frontend — Leads**: leads list with inline "new lead" form, lead detail page
  with a "Convert to client" button that redirects straight to the new client record.

Backend: 26/26 tests passing (auth + permissions + validation + duplicate detection +
cross-tenant client check + status-transition validation + audit-entry assertions,
including before/after state on status changes, lead conversion and duplicate-
client reuse on conversion) against a real Postgres instance.

Frontend: `npm run build` and `npm run dev` both verified working (clean production
build, dev server responds 200).

## What's deliberately NOT here yet

Real capacity-aware job **allocation** (assigning a job to a specific employee based on
skills/availability/workload — see doc section 24A) is intentionally not implemented.
This slice only gives a job a client and a status lifecycle. Also still missing from
MVP scope: calendar, capacity warnings, communication intelligence, website/photo
modules, voice command layer, playbooks. Build order should follow the roadmap in the
master documentation (Phase 1 → Phase 2 → …), not be improvised per-feature.

## Deployment

- **Backend**: designed to deploy to Railway (Postgres + Node service). Set
  `DATABASE_URL`, `JWT_SECRET`, `PORT` as environment variables; run
  `npm run build && npx prisma migrate deploy && npm start`.
- **Frontend**: any static host (Railway static site, Vercel, Netlify). Set
  `VITE_API_URL` to the deployed backend URL at build time.

## Git

This folder is an initialised git repository. To push it to GitHub:

```bash
git remote add origin <your-new-github-repo-url>
git branch -M main
git push -u origin main
```
