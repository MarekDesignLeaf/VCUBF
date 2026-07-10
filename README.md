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
- **Backend — services layer refactor**: business logic extracted out of route handlers
  into `backend/src/services/*Service.ts` (clients, jobs, leads), each returning a
  uniform `ServiceResult<T>` (`ok()`/`fail()`). Routes are now thin wrappers that call a
  service and map the result to an HTTP response — this keeps route files as pure
  transport, with all validation, duplicate checks, and audit calls living in one place
  per module, ready to be reused by the command layer below (or a future voice layer)
  without duplicating logic.
- **Voice and Text Command Layer**: `POST /command/text` accepts `{ text }` and
  interprets it with a **deterministic, rule-based parser** (`backend/src/lib/
  commandParser.ts`) — regex pattern matching, no LLM involved, so behaviour is fully
  predictable and auditable (per the language/no-hidden-logic rule). Supported intents:
  create client, create lead, create job for an existing client, change a job's status
  (accepts natural words like "scheduled"/"done"/"in progress", mapped to the ASCII
  status codes), convert a lead, and list clients/jobs/leads. When a command references
  an entity by name (e.g. "job kitchen refit") and more than one record matches, the
  layer returns `409 AMBIGUOUS_REFERENCE` with the candidate list rather than guessing.
  Unrecognised text returns `{ intent: "unrecognized" }` — it never invents an action.
  Action Contract `execute_text_command` (permission `voice.execute`, risk level 2).
  Every call writes its own audit entry recording the raw text, the interpreted intent,
  and the result, in addition to the audit entry the underlying action (e.g.
  `create_client`) writes itself.
- **Frontend — Command Bar**: a text command box on the dashboard with example quick-fill
  buttons and a running history of the last 8 commands showing intent, success/failure,
  and message — the first concrete piece of the Voice and Text Command Layer's UI
  (text input today; a voice/speech front-end can be layered on top of the same
  `/command/text` endpoint later without backend changes).

- **Job Allocation and Capacity Management Module**: `backend/src/services/
  capacityService.ts` computes an employee's **real** current-week workload from actual
  job data (`estimated_duration_hours` + `planned_start_at` on active jobs assigned to
  them), never from whether a calendar slot merely looks empty (doc section 24A/26).
  `PUT /crm/jobs/:id/assign` (Action Contract `assign_job`) assigns a job to an employee
  and returns two structured, non-blocking warnings when relevant: an `OVERLOAD` warning
  when the projected load would exceed the employee's declared `weekly_capacity_hours`,
  or a `NO_PLANNED_DATE` warning stating capacity could not be evaluated because the job
  has no planned start date — the system says what is missing rather than guessing. It
  also reports `missingSkills` (job `required_skills` not in the employee's `skills`)
  without blocking the assignment — a human can still deliberately overload or skill-gap
  an assignment for a priority job, but the decision is visible and audited, never
  silent. `GET /crm/employees` lists employees with their current-week workload attached
  (read-only, Action Contract `check_capacity`, risk level 0); `GET /crm/employees/:id/
  capacity` returns the same computation standalone. Text command: "assign job X to Y"
  resolves both the job and the employee by name, with the same `409 AMBIGUOUS_REFERENCE`
  handling as other intents.
- **Frontend — Employees & capacity**: new Employees page listing each person's skills
  and a workload bar (hours used / weekly capacity, flagged red when overloaded). Job
  detail page gained an "Assigned to" dropdown (showing "(overloaded)" next to
  already-stretched employees) and warning banners for overload / missing-skill /
  no-planned-date cases returned by the assign endpoint. The "new job" form on the client
  detail page now also captures planned start date, estimated hours, and required
  skills, so capacity data actually gets entered end-to-end instead of only existing in
  the schema.

- **Calendar and Scheduling Intelligence Module**: `backend/src/services/
  calendarService.ts` adds three real, data-driven views on top of the capacity engine —
  it deliberately does not build a day-level scheduling grid, it answers the actual
  business questions the architecture asks for. `GET /calendar/jobs?from=&to=` returns
  the real agenda of planned jobs in a date window. `GET /calendar/overload` (Action
  Contract `detect_overload`, risk 0, read-only) scans the next N weeks (default 4) for
  every employee and reports every week where their real computed load would exceed
  their declared capacity, attaching the standard menu of realistic mitigation options
  from the project instructions (reschedule, split into stages, subcontractor, temp
  hire, start recruitment, price increase for low-priority work, waiting list, etc.) —
  structured operational guidance, not a fabricated business claim. `GET /calendar/
  suggest` (Action Contract `suggest_schedule`, risk 0, read-only) ranks employees for a
  hypothetical new job by real spare capacity (the soonest upcoming week that would NOT
  overload them) and skill fit — an employee with no real available week in the window
  gets `earliestAvailableWeekStart: null` rather than a guessed date, honouring the "must
  not offer a date only because a slot looks empty" rule. Text command: "show overload" /
  "check overload".
- **Frontend — Calendar**: new Calendar page showing a 4-week agenda grouped by day
  (job, client, status, assigned employee), with an upfront capacity warning banner
  listing every overloaded employee-week and a collapsible list of suggested mitigation
  options when any exist.

- **Employee and Permission Model — management**: `POST /crm/employees` (create) and
  `PUT /crm/employees/:id` (update role, permissions, skills, weekly capacity, active
  status) — Action Contracts `create_employee` / `update_employee`, the **first actions
  in this codebase with `confirmationRequired: true`**, implementing the confirm-before-risky-
  action rule from project instructions section 9 generically: submitting without
  `confirmed: true` changes nothing and instead returns `409 CONFIRMATION_REQUIRED` with a
  full preview (`{ before, changes }` for updates, or the record that would be created);
  only a second request with `confirmed: true` actually writes, and the resulting audit
  entry records `confirmed: true` alongside the before/after state. Permissions are
  restricted to a fixed, structured list (`KNOWN_PERMISSIONS` — `crm.read`, `crm.manage`,
  `users.manage`, `audit.read`, `voice.execute`; exposed at `GET /crm/employees/meta/
  permissions`) rather than accepting arbitrary strings. Deactivating an employee
  (`is_active: false`) removes them from the active employee list and capacity views but
  keeps their record (and audit history) intact for review via `GET /crm/employees/:id/
  manage`. This module intentionally does **not** send invitation emails, set wages, or
  confirm employment terms — per the "do not legally hire anyone... without explicit user
  approval" rule, it only manages system access for someone the user has already decided
  to bring on.
- **Frontend — Employee management**: "New employee" and "Manage" links on the Employees
  page (shown only to users holding `users.manage`), leading to a create/edit form with
  permission checkboxes, skills, weekly capacity, and an active toggle. The form
  implements the two-step confirm flow directly: "Review changes" shows the exact preview
  JSON the backend returned, and only "Confirm and save" commits it.

- **Service Catalogue Module**: `POST /service-catalogue` / `PUT /service-catalogue/:id`
  (Action Contracts `create_service_catalogue_item`, `update_service_catalogue_item`)
  manage the company's real, user-entered menu of services — name, description,
  category, price range + unit, default duration, and default required skills. Nothing
  here is invented: every field is exactly what the user typed in, per the "no fake
  facts" rule — this exists precisely so later modules (quoting, website content) can
  read real service data instead of re-typing or guessing it. Deactivating a service
  (`is_active: false`) removes it from the default list without deleting its history.
  `Job` gained an optional `service_catalogue_item_id` link (`GET /crm/jobs/:id` includes
  the linked service's name) so a job can trace back to the catalogue entry it was based
  on. Text command: "create service X, category Y".
- **Frontend — Service catalogue**: new Services page (list, filter to active-only,
  a "New service" form covering all catalogue fields, and per-row activate/deactivate).
  The "new job" form on the client detail page gained a "Based on a service" dropdown
  that prefills the job title, estimated hours, and required skills from the selected
  catalogue entry (still editable, and only fills blank fields — it never overwrites
  something the user already typed).

- **Quote, Pricing and Profitability Module**: `POST /quotes`, `PUT /quotes/:id`, `PUT
  /quotes/:id/status`, `GET /quotes`, `GET /quotes/:id` (Action Contracts `prepare_quote`,
  `update_quote`, `change_quote_status`) build a real, itemised quote for a client
  (optionally linked to a job), with each line's unit price and unit cost either pulled
  from a real service catalogue entry or typed in directly — never invented. Margin is
  computed honestly: `backend/src/services/quoteService.ts` sums `quantity × unit_price`
  for the subtotal, but only sums `quantity × unit_cost` into the cost total for lines
  where a cost was actually entered, and if **any** line is missing a cost the reported
  `marginAmount`/`marginPct` are `null` (unknown) rather than computed from a partial,
  misleading cost total — the system says what is missing instead of guessing a margin.
  Quotes move through a fixed lifecycle (`draft → sent → accepted / rejected / expired`);
  changing status is an internal record only — no email/message is sent to the client,
  since no communication connector exists yet. A referenced `service_catalogue_item_id`
  or `job_id` is validated against the company's real records before a quote is created.
  Text command: "list quotes" / "list quotes for <client>" (full quote creation needs a
  line-item form, so it isn't a one-line voice command in this slice).
- **Frontend — Quotes**: new Quotes list page (title, client, status, subtotal, margin —
  showing "—" instead of a number when margin is unknown) and a create/edit page with a
  repeatable line-item editor (optional service-catalogue picker per line that prefills
  description/price without overwriting anything already typed), a live client-side
  margin preview using the exact same "unknown if any cost is missing" rule as the
  backend, and a status dropdown on existing quotes. "New quote" links were added from
  both the client detail page and the job detail page, prefilling the client/job.

- **Recruitment and Workforce Expansion Module**: `POST /recruitment/job-openings`,
  `PUT /recruitment/job-openings/:id`, `POST /recruitment/job-openings/:id/draft-advert`,
  `POST /recruitment/job-openings/:id/candidates`, `PUT /recruitment/candidates/:id` (Action
  Contracts `create_job_opening`, `update_job_opening`, `draft_job_advert`,
  `create_candidate`, `update_candidate`) track a real hiring need — role, reason,
  urgency, required skills, expected tasks, experience and language requirements, all
  exactly what the user entered — through to real candidates moving through a fixed
  pipeline (`new → screening → interview → trial_day → offer → hired / rejected`).
  `draft_job_advert` (risk 1, drafting-only per project instructions section 9) builds
  advert text using `backend/src/services/recruitmentService.ts#buildAdvertText`, a pure
  template that only ever reads the opening's own fields — pay, benefits and employment
  terms are deliberately never included, and there is no job-board connector, so nothing
  is ever published automatically; the draft is stored on the opening for the user to
  copy or edit. Moving a candidate to `hired` is still only a pipeline record — it does
  not create a user account, set a wage, or confirm employment terms (covered explicitly
  by a test); turning a hired candidate into real system access remains a separate,
  deliberate step on the Employees page. A new fixed permission, `recruitment.manage`,
  was added to `KNOWN_PERMISSIONS` and gates every route in this module. Text command:
  "list job openings".
- **Frontend — Recruitment**: new Recruitment page (visible in navigation only to users
  holding `recruitment.manage`, matching the Employee-management gating pattern) listing
  openings with status/urgency/skills/candidate count and a "New job opening" form; a job
  opening detail page with a status dropdown, a "Generate/Regenerate draft" button showing
  the exact advert text the backend produced, an "Add candidate" form, and a per-candidate
  stage dropdown — with a standing note that a "Hired" candidate still needs a real
  employee account created deliberately from the Employees page.

Backend: 109/109 tests passing across 12 suites (auth, CRM clients, CRM jobs, CRM leads,
command parser unit tests, command/text integration tests, capacity/allocation,
calendar/scheduling, employee/permission management, service catalogue, quotes, and
recruitment) — covering permissions, validation, duplicate detection, cross-tenant
checks, status-transition validation, lead conversion and duplicate-client reuse,
command parsing for every supported intent, ambiguous-reference handling,
capacity/overload computation, skill-gap detection, calendar date-range queries,
upcoming overload detection, employee-suggestion ranking, the confirm-before-write flow
(nothing changes until `confirmed: true`), deactivation, catalogue CRUD and
job-to-catalogue linking, quote line-item totals/margin computation (including the
"unknown margin" case), quote status transitions, job-opening/candidate CRUD, advert
drafting content assertions, candidate pipeline transitions (including that "hired"
never creates a user account), and audit-entry assertions — against a real Postgres
instance.

Frontend: `npm run build` and `npm run dev` both verified working (clean production
build, dev server responds 200).

## What's deliberately NOT here yet

A day-level scheduling grid with travel time, tool/material/vehicle requirements, and
staged multi-visit scheduling is not implemented — the calendar slice works at weekly
granularity, matching the capacity engine underneath it. Employee creation issues no
invitation email and generates no temporary password reset flow — an admin sets the
initial password directly, since there is no email connector yet. Quotes have no PDF
export or "send to client" action — status is tracked internally only, since no
communication connector exists yet to actually deliver anything. Recruitment adverts are
drafted text only — there is no job-board connector to place them, no candidate-sourcing
integration, and no trial-day scheduling tie-in to the calendar module yet; a hired
candidate must still be turned into an employee account manually. Also still missing from
MVP scope: communication intelligence (email/WhatsApp enquiry extraction), website/photo
modules, business growth content generation, playbooks, and a real voice (speech)
front-end (the Voice and Text Command Layer currently accepts typed text only). Build
order should follow the roadmap in the master documentation (Phase 1 → Phase 2 → …), not
be improvised per-feature.

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
