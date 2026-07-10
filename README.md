# VCUF — Secretary Web App (MVP)

Web frontend + backend for **VCUF (VoiceControl Universal Framework)**, built around
**Secretary** as the single source of truth. See the master documentation in the parent
project folder (`VCUF_Master_Documentation_Secretary_Voice_Control_EN.docx`) for the full
architecture.

This repo is the first vertical slice of the MVP: **Secretary Core** (auth, permissions,
audit log) + **CRM Core** (clients).

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

## What's implemented (vertical slice 1)

- **Auth**: `POST /auth/login`, `GET /auth/me`, JWT, bcrypt password hashing.
- **Permission Engine**: every route checks the user's permission list (see doc section 30).
- **Audit Engine**: every `create_client` call (success, validation failure, duplicate
  rejection) writes an audit_log row — who, what, risk level, result (doc section 37).
- **CRM Core — Clients**: create (with duplicate detection by email or name+phone),
  list, get, search. Action Contract for `create_client` lives in
  `backend/src/lib/actionContracts.ts` as structured data, not a prompt.
- **Frontend**: login, dashboard shell, clients list/detail/create form wired to the
  real API, JWT stored client-side, protected routes.

Backend: 10/10 tests passing (auth + permission + validation + duplicate detection +
audit-entry assertions) against a real Postgres instance.

## What's deliberately NOT here yet

Everything else in the MVP scope from the master doc — jobs, calendar, capacity,
communication intelligence, website/photo modules, voice command layer, playbooks —
is out of scope for this first slice. Build order should follow the roadmap in the
master documentation (Phase 1 → Phase 2 → …), not be improvised per-feature.

## Deployment

- **Backend**: designed to deploy to Railway (Postgres + Node service). Set
  `DATABASE_URL`, `JWT_SECRET`, `PORT` as environment variables; run
  `npm run build && npx prisma migrate deploy && npm start`.
- **Frontend**: any static host (Railway static site, Vercel, Netlify). Set
  `VITE_API_URL` to the deployed backend URL at build time.

## Known sandbox limitation (dev environment only)

`vite build` / `vite dev` crash with a low-level "Bus error" inside the restricted
Linux sandbox this was built in (native esbuild/rollup binary incompatibility with the
sandbox's syscall filtering). This is **not a code issue** — `tsc -b` type-checks clean.
It will run normally on a real machine, GitHub Actions, or Railway. Worth a quick
`npm run dev` smoke test on your own machine before trusting the UI further.
