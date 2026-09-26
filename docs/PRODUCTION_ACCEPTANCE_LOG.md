# Production acceptance log

Use this file to record real production checks. Do not record mocked tests here unless they are clearly marked as mocked.

Project:

`VCUF / Secretary`

Railway project:

`VCUBF`

Environment:

`production`

## Acceptance status summary

| Area | Status | Last checked | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Railway project exists | Passed | 2026-09-26 | Railway project `VCUBF` found | Backend, frontend and Postgres services exist |
| Railway backend deploy | Passed | 2026-09-26 | Latest backend deployment reports SUCCESS | Commit `aaa9fe9da4a55992f52eff45da0a2923414bf835` |
| Railway frontend deploy | Passed | 2026-09-26 | Latest frontend deployment reports SUCCESS | Created 2026-09-22 01:36 UTC |
| Railway Postgres deploy | Passed | 2026-09-26 | Latest Postgres deployment reports SUCCESS | Volume mounted at `/var/lib/postgresql/data` |
| GitHub CI | Passed | 2026-09-26 | Latest checked run reports success | Node 22 CI runtime |
| Production frontend load | Passed | 2026-09-26 | `https://frontend-production-ee13.up.railway.app` opened and loaded in browser | Page load confirmed by owner; browser console not checked in this step |
| Production backend health | Passed | 2026-09-26 | `curl -i https://backend-production-7952.up.railway.app/health` returned HTTP 200 and JSON `{ "status": "ok", "build": "aaa9fe9da4a5" }` | Confirmed from Windows command prompt by owner |
| Production login | Not checked |  |  | Requires valid production user |
| Production database migration | Passed | 2026-09-26 | Railway backend logs show 32 migrations found and no pending migrations to apply | Production Postgres connected through Railway internal hostname |
| Production create client | Not checked |  |  | Use temporary test record |
| Production create lead | Not checked |  |  | Use temporary test record |
| Production create job | Not checked |  |  | Use temporary test record |
| Production task/calendar | Not checked |  |  | Use temporary test task/calendar item |
| Production audit log | Not checked |  |  | Verify write actions create audit rows |
| Gmail connector live read | Not checked |  |  | Mocked tests do not count |
| Gmail connector live send | Not checked |  |  | Must require approval |
| Google Calendar live sync | Not checked |  |  | Must avoid duplicate import incident |
| Google Drive/photo live access | Not checked |  |  | Must verify permissions and source metadata |
| WhatsApp or messaging connector | Not checked |  |  | Must verify legal/API limits |
| Windows voice live microphone | Not checked |  |  | Hardware acceptance required |
| Windows voice false wake rejection | Not checked |  |  | Hardware/noise acceptance required |
| Windows voice backend command | Not checked |  |  | Must verify command reaches backend |
| Windows voice confirmation before write | Not checked |  |  | Required for risky actions |

## How to record a production check

Use this format for each acceptance run.

```text
Date:
Tester:
Environment:
Commit:
Service:
Action tested:
Input:
Expected result:
Actual result:
Result: Passed / Failed / Blocked
Evidence:
Notes:
Follow up issue:
```

## Required smoke test sequence

### 1. Frontend access

- Open production frontend URL.
- Confirm the page loads.
- Confirm no blank screen.
- Confirm browser console has no blocking error.

Result:

```text
Passed 2026-09-26.

URL opened:

https://frontend-production-ee13.up.railway.app

Observed result:

The production frontend loaded in the browser.

Limitation:

Browser console was not checked in this step.
```

### 2. Backend health

- Open backend health/version endpoint.
- Confirm service responds.
- Confirm response comes from production backend, not local machine.

Result:

```text
Passed 2026-09-26.

Command used:

curl -i https://backend-production-7952.up.railway.app/health

Observed response:

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Server: railway-hikari
x-railway-edge: lhr1

{"status":"ok","build":"aaa9fe9da4a5"}
```

### 3. Authentication

- Log in with a valid production user.
- Confirm token/session is created.
- Confirm invalid credentials are refused.
- Confirm user role and company context are correct.

Result:

```text
Not checked
```

### 4. CRM write and audit

- Create a temporary client named `VCUF Acceptance Test Client`.
- Confirm the client appears in CRM.
- Confirm company separation is preserved.
- Confirm audit log records the creation.
- Delete or archive the test record through approved safe flow.

Result:

```text
Not checked
```

### 5. Lead and job workflow

- Create a temporary lead.
- Convert or link it to a temporary job if the UI/API supports it.
- Confirm task and job records link correctly.
- Confirm audit entries exist.

Result:

```text
Not checked
```

### 6. Calendar and capacity

- Create a temporary task or job calendar entry.
- Confirm it appears in the correct user/company context.
- Confirm capacity logic does not treat an empty slot as automatically realistic if the workflow supports capacity checks.
- Remove test entry through approved flow.

Result:

```text
Not checked
```

### 7. Connector checks

Each connector must be checked separately.

Connector:

```text
Gmail / Google Calendar / Google Drive / WhatsApp / other
```

For each connector, record:

- authorised account,
- exact read scope,
- exact write scope,
- test input,
- whether action was read-only, draft, send or publish,
- whether confirmation was required,
- audit result,
- error handling.

Result:

```text
Not checked
```

### 8. Windows voice acceptance

- Confirm only one companion instance runs.
- Confirm wake word is detected.
- Confirm false wake examples do not trigger.
- Confirm dictated phone number is not cut after first group.
- Confirm a safe read-only command reaches backend.
- Confirm a risky write command asks for confirmation.
- Confirm audit entry is created after approved write.

Result:

```text
Not checked
```

## Production readiness rule

The project may be described as:

`implemented, deployed and CI passing`

The project must not be described as:

`production ready`

until every required production acceptance row above is either passed or explicitly removed from scope with a reason.