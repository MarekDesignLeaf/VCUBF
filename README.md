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

- **Playbook Engine**: `POST /playbooks`, `PUT /playbooks/:id`, `POST /playbooks/:id/run`,
  `GET /playbooks`, `GET /playbooks/:id`, `GET /playbooks/:id/runs` (Action Contracts
  `create_playbook`, `update_playbook`, `run_playbook`) implement "save the workflow as a
  reusable playbook" from project instructions section 2. A playbook is just an ordered
  list of Voice/Text Command Layer templates with `{placeholder}` variables — the exact
  same syntax a user could type into the command bar. The switch-statement dispatch logic
  that used to live inside the `/command/text` route was extracted into
  `backend/src/lib/commandExecutor.ts#dispatchParsedCommand(user, command)`, a pure
  Action Engine entry point with no HTTP or audit concerns of its own; both the text
  command route and `run_playbook` now call this exact same function, so a playbook step
  behaves identically to typing the same text by hand — there is no second, divergent
  execution path (verified: all 109 pre-existing tests still passed unchanged after the
  refactor, before any playbook code was added). `run_playbook` is
  `confirmationRequired: true` (risk level 3, since one call can chain several mutating
  actions — the "no uncontrolled automation" rule): a request without `confirmed: true`
  resolves every step's variables and returns a `409 CONFIRMATION_REQUIRED` preview
  showing the exact resolved text and interpreted intent for every step, and changes
  nothing; a request with an unresolvable `{placeholder}` (no matching variable supplied)
  fails with `400 MISSING_VARIABLE` naming exactly what's missing, before anything runs.
  Only a second request with `confirmed: true` executes the steps, in order, through
  `dispatchParsedCommand` — and execution **stops at the first failing step** rather than
  continuing silently (covered by a test with a two-step playbook where step one
  references a nonexistent client: only one step result is recorded, and step two never
  ran). Every run is stored as a `PlaybookRun` (variables, full per-step results,
  `overallOk`) for later review, in addition to the run's own audit entry.
- **Frontend — Playbooks**: new Playbooks page (list, "New playbook" form with one
  template per line) and a playbook detail page that auto-detects `{placeholder}` names
  from the step templates via regex and renders an input for each, a "Preview steps"
  button that shows the resolved text and interpreted intent per step before anything
  runs, a "Confirm and run" button that only appears after a preview, a run-result table,
  and run history. Visible to all users with `voice.execute` (the same permission the
  command bar already requires).

- **Learning Engine**: `POST /learning-rules`, `PUT /learning-rules/:id`, `GET
  /learning-rules`, `GET /learning-rules/:id` (Action Contracts `create_learning_rule`,
  `update_learning_rule`) implement the MVP-required "basic learning of aliases and
  workflows" (project instructions section 12) and the explicit-correction rule from
  section 11 — every rule is created deliberately by a user (e.g. "when I say old client
  I mean a client who had work done in the last two years"), never inferred from one
  weak signal, and stays visible, editable and reversible (archive, not delete). A rule
  can optionally set `alias_for`, turning it into a real text-substitution step —
  `backend/src/services/learningService.ts#resolveLearningAliases(user, text)` is applied
  before `parseTextCommand` in **both** `POST /command/text` and each resolved Playbook
  step, so a learned alias genuinely changes how a command is interpreted rather than
  sitting in an unused glossary (e.g. teach "RAL" → "Riverside Apartments Ltd" once, and
  every future "for RAL" resolves to the real client before entity matching runs).
  Substitution uses a single left-to-right pass with terms ordered longest-first, so a
  more specific alias ("Oak Home") wins over a shorter one it contains ("Oak") without
  ever re-scanning already-substituted text. `POST /command/text` now returns
  `appliedAliases` alongside the usual response, and the audit entry records the raw
  text, the resolved text, and which aliases fired, so the interpretation stays fully
  traceable. Text commands: "when I say X I mean Y", "teach me: X means Y", "list
  learning rules".
- **Frontend — Learning**: new Learning page ("Teach a rule" form — term, meaning, an
  optional "Use as text substitution" field, and category), an active/archived list with
  an Archive/Reactivate toggle per rule, and a note explaining that a rule only changes
  command interpretation once the substitution field is filled in.

- **Communication Log Module**: `POST /communications`, `PUT /communications/:id`,
  `GET /communications`, `GET /communications/:id`, `GET /communications/follow-ups-due`
  (Action Contracts `log_communication`, `update_communication_record`) are the
  manual-entry foundation of the Communication Intelligence Module — a real record of
  what was discussed or promised with a client (optionally linked to a job), channel
  (email/whatsapp/sms/phone_call/messenger/in_person/other), direction (inbound/
  outbound), a required summary, an optional full-text capture, and when it actually
  happened (`occurred_at`, not necessarily "now" — a call from yesterday can be logged
  today). Every field is exactly what the user typed in; there is no email/WhatsApp/SMS
  connector in this slice, so nothing is auto-extracted. A referenced `client_id` (and
  `job_id` if given) is validated against the company's real records before a record is
  created, matching the FK-validation pattern in `quoteService.ts`. Follow-up tracking
  is a first-class field (`follow_up_needed` + optional `follow_up_due_at`);
  `listFollowUpsDue` (company-scoped) returns every record still needing follow-up
  whose due date has arrived or was never set, so a follow-up never silently falls off
  the list just because a date wasn't entered. Text commands: "log call with <client>:
  <summary>" / "log email from <client>: <summary>" (channel word and with/from
  direction are mapped deterministically to the real channel/direction values), "list
  communications" / "list communications for <client>", "show follow ups". This module
  is deliberately generic and CRM-linked so a future connector-driven extraction
  workflow (reading real email/WhatsApp/SMS threads) can write into this exact same
  table and linkage instead of being a second, disconnected communication store.
- **Frontend — Communications**: new Communications page (list with channel and
  follow-up-needed filters, and a "Log communication" quick-entry form — client picker,
  channel/direction selects, summary, occurred-at, and a follow-up checkbox + due date).
  Client detail and job detail pages each gained a "Communications" section showing the
  five most recent records for that client/job plus a "Log communication" link that
  prefills `client_id` (and `job_id` from the job page).

- **Notification and Escalation Module**: `GET /notifications` (Action Contract
  `get_attention_feed`, risk 0, read-only) builds a single, unified "things needing
  attention" feed by computing it fresh, on every read, from real data already owned by
  other modules — it stores no duplicate business facts. Sources: overdue Communication
  Log follow-ups (`communicationService.listFollowUpsDue`), real capacity overload weeks
  from the Job Allocation/Calendar module (`calendarService.detectUpcomingOverload`,
  including the same real mitigation menu), and draft/sent quotes whose `valid_until`
  date has passed or is within 7 days (`backend/src/services/notificationService.ts`).
  Severity (`urgent`/`warning`) is derived directly from real dates and utilisation
  percentages already stored elsewhere — nothing is invented or guessed. The only new
  persisted state is which computed item a user has explicitly acknowledged
  (`NotificationAcknowledgement`, keyed by a deterministic `notificationKey` such as
  `follow_up:<id>`), so a handled item stops resurfacing without ever touching the
  underlying communication record, overload finding, or quote it points to.
  `POST /notifications/acknowledge` (Action Contract `acknowledge_notification`, risk 1)
  and `POST /notifications/:key/unacknowledge` (Action Contract
  `unacknowledge_notification`, risk 1) are both idempotent and fully reversible — no
  confirmation is required since nothing but a "seen" marker changes, matching the
  Learning Engine's visible/editable/reversible standard for low-risk state. Text
  commands: "list notifications" / "show notifications" / "what needs attention".
- **Frontend — Notifications**: new Notifications page (linked in the sidebar right
  under Dashboard) listing every attention-feed item with a severity badge, type, title,
  message, and due date, an "Acknowledge"/"Unacknowledge" button per row, and a "show
  acknowledged items too" toggle so a handled item can still be reviewed rather than
  disappearing for good.

- **Data Quality Engine**: `GET /data-quality` (Action Contract `analyze_data_quality`,
  risk 0, read-only) is a purely structural, rule-based scan of real CRM Core client
  records — `backend/src/services/dataQualityService.ts` flags **possible** duplicate
  clients by exact (case-insensitive) email match, digit-normalized phone match (also
  normalizing the UK "+44"/"0" prefix so "+44 7700 900123" and "07700900123" compare
  equal), exact display-name match, or a small Levenshtein edit distance on the name for
  obvious typo duplicates — and flags clients with neither an email nor a phone number on
  file as missing a contact method. Nothing is invented and nothing is ever merged,
  edited, or deleted automatically — per the CRM rule, an uncertain identity match is only
  ever presented for a human to review on the real client record. This module adds no new
  persisted state: findings feed additively into the existing Notification and Escalation
  Module feed via a new `buildDataQualityItems` source function (matching the extension
  point that module was explicitly designed for), reusing its existing
  acknowledge/unacknowledge mechanism rather than inventing a second "dismiss" concept.
  Text commands: "check data quality" / "show data quality issues" / "show duplicate
  clients".
- **Frontend — Data Quality**: new Data Quality page (linked in the sidebar next to
  Notifications) showing the full structural report — a table of possible duplicate
  client pairs (with the matched reason and detail, and links to both client records) and
  a table of clients missing a contact method — plus the same findings surfacing in the
  Notifications feed for acknowledgement.

Backend: 166/166 tests passing across 17 suites (auth, CRM clients, CRM jobs, CRM leads,
command parser unit tests, command/text integration tests, capacity/allocation,
calendar/scheduling, employee/permission management, service catalogue, quotes,
recruitment, playbooks, learning, communication log, notifications/escalation, and data
quality) —
covering permissions, validation, duplicate
detection, cross-tenant checks, status-transition validation, lead conversion and
duplicate-client reuse, command parsing for every supported intent, ambiguous-reference
handling, capacity/overload computation, skill-gap detection, calendar date-range
queries, upcoming overload detection, employee-suggestion ranking, the confirm-before-
write flow (nothing changes until `confirmed: true`), deactivation, catalogue CRUD and
job-to-catalogue linking, quote line-item totals/margin computation (including the
"unknown margin" case), quote status transitions, job-opening/candidate CRUD, advert
drafting content assertions, candidate pipeline transitions (including that "hired"
never creates a user account), playbook CRUD, missing-variable and confirm-preview
handling, successful multi-step execution creating real records, stop-on-first-failure
behaviour, learning-rule CRUD, that an unconfirmed alias (no `alias_for` set) does not
change interpretation, that a confirmed alias resolves before parsing and is reflected in
both the response and the audit log, that archiving a rule stops it applying, longest-
term-wins precedence for overlapping aliases, and audit-entry assertions; the
Communication Log Module — permission checks, validation errors, CLIENT_NOT_FOUND/
JOB_NOT_FOUND on invalid links, successful create with audit before/after assertions,
list filtering by client/job/channel/follow-up-needed, the follow-ups-due view, update,
single-record get, and a company-scoping test proving a company B record is never
visible, listed, or updatable by company A; and the Data Quality Engine — email/phone/
name duplicate detection (including UK phone-prefix normalization), a negative case
proving an unrelated client is never flagged, missing-contact-method detection (and that
a client with either an email or phone is not flagged), additive integration into the
unified notification feed, acknowledging a data-quality finding via the existing
notification mechanism without touching the underlying client record, and the "check
data quality" text command — against a real Postgres instance.

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
candidate must still be turned into an employee account manually. Playbooks are limited
to the intents the deterministic command parser already understands, and a playbook step
can't branch on a previous step's result, only run in a fixed order and stop on first
failure — there is still no automatic step that proposes a playbook from a repeated
sequence of manual actions (a genuine Memory Model / pattern-detection layer, beyond the
explicit-correction rules the Learning Engine now handles). Learning rules are
whole-term substitutions only — a rule can't yet rewrite part of a sentence based on
context (e.g. it can't tell "old client" apart in "call the old client" vs. "he's quite
old" — it just doesn't fire on any term it wasn't taught verbatim, matching the "must
not guess" rule rather than trying to be clever about it). Also still missing from MVP
scope: automated communication intelligence — the Communication Log Module now gives
every communication a real, CRM-linked, auditable home, but extracting new
communications automatically from an email/WhatsApp/SMS connector (rather than manual
entry), duplicate/near-duplicate detection across channels, and AI-assisted
summarisation of a raw thread into a structured record are still not implemented; the
data model and CRM linkage are deliberately built so that future connector-driven
extraction work writes into this same table instead of creating a second, disconnected
communication store. The Notification and Escalation Module's feed is pull-only (a
page you open, or a text command you run) — there is no push delivery yet: no email
digest, no SMS/WhatsApp alert, and no in-app real-time badge/websocket, since no
notification-delivery connector exists. It also only aggregates three real signal types
(overdue follow-ups, capacity overload, expiring quotes); it does not yet cover other
escalation-worthy conditions the architecture lists (e.g. a lead sitting unconverted too
long, a job stuck in one status too long) — extending coverage means adding another
`buildXItems` source function, not a new module. The Data Quality Engine is a read-only
analysis layer only: it does not merge, edit, or delete client records, and there is no
"merge these clients" action yet — a possible duplicate must currently be resolved
manually on the two client records after a human reviews it; it also only compares
Client records within CRM Core (email/phone/name), not leads, jobs, or cross-entity
matches, and there is no configurable similarity threshold (the Levenshtein cutoff and
phone-normalization rule are fixed in code, not a per-company setting). Also still
missing: website/photo modules, business growth content generation, and a real voice
(speech) front-end (the Voice and Text Command Layer currently accepts typed text only).
Build order should follow the roadmap in the master documentation (Phase 1 → Phase 2 →
…), not be improvised per-feature.

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
