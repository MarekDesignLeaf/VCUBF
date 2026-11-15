# Production acceptance log

Use this file to record real production checks. Do not record mocked tests here unless they are clearly marked as mocked.

Project:

`VCUF / Secretary`

Railway project:

`VCUBF`

Environment:

`production`

## Phone / PC gateway verification — 9 November 2026

These results apply to the exact checked paths, not full product acceptance.
Actual ChatGPT connection: existing Secretary plugin
`plugin_asdk_app_6ae7860efa388191bf1640aba2486b8d`, test chat
https://chatgpt.com/c/6af17584-00a4-83eb-ab1f-2ded1bd59a63.
No screenshots or coordinate fallback were used.

| Requirement | Direct evidence | Remaining limit |
| --- | --- | --- |
| Secretary deployment and migration | Railway deployment `0ec27613-96fe-44a4-95fe-e942f6a5c1b2` SUCCESS; /health build `b18614371533`; startup logs applied `20261109120000_whatsapp_message_status` | Timestamp follow-up PR77 needs post-deploy read-back |
| Upgrade existing plugin | Same plugin/account refreshed, 100 tools: 40 read, 60 write; live describe_capabilities version1.5.0 / revision1.5.0+2026-11-09.full-device-scope | Long-running clients may need their own tool refresh |
| Samsung and SMS reading | phone_status online; 50 synchronized SMS; list_phone_sms(limit=1) returns one real row | Only owner-synchronized SMS |
| One approved self SMS | Exactly one preview/confirmation and matching outbound; remote_id `8f3d4658-2b2e-4e4d-8e07-b469dc094d32`; get_outbound_message_status=sent, Android SMS sent callback; one matching incoming SMS device_sms_id6377; independent bridge read agrees | NEVER repeat this test. Request_id `vcubf-00000000-4e8cfb56-5206-40e7-ac02-15c8460d9f99`. Phone sent callback alone is not a carrier delivery receipt; incoming copy proves self-receipt |
| Phone WhatsApp notification input | Actual list_phone_chat_messages(limit=5) returns five WhatsApp notifications; listener active | No Messenger notifications in this page; no full app history or notification reply delivery proof |
| PC text reading | Actual pc_ui_windows returns9 windows; pc_web_fetch python.org HTTP200 / Welcome to Python.org | Interactive browser CDP is disabled; no browser-action acceptance |
| Guarded PC write/read | pc_write_workspace_text preview `c0d246cd-0ad1-454b-8a9a-16abdf1fbab8` confirmed once, backup=null; actual pc_read_text returns expected disposable acceptance-file text; independent disk read agrees (Windows CRLF) | Existing local write approval preserved; does not validate every PC action |
| Signed shared PC engine | Engine1.1.1 exact SHA256 `7e1858530d55362a46935fbb1554ed85f2c0265e168531b633108f7c61631883`, accepted nonce heartbeat; PCP signed release `a267875cb7d9d812bf5e3589a1aa7299f80274c1`, deployment `1f87def3-3dac-48c2-861d-1cd198db01a5` SUCCESS; pinned public key independently matches | Raw shell and permission/approval resets remain owner-local |
| Agent governance | Independently reviewed shared contracts/executors; disposable migrated PostgreSQL agent11/11 and MCP17/17; per-person/tenant, concurrent confirmations, emergency stop, unknown outcome and audit tests | These are isolated integration tests, not live assistant-path acceptance |
| WhatsApp Business sending | Connector read ready; reviewed implementation, delivery webhook and concurrency regression tests pass | No live recipient/body was authorized for another test; Business send/reply/delivery remains unverified |

No real CRM contact or task was created for these checks. Existing OAuth scopes,
tenant bindings and PC permissions were retained. No other test message was sent.
SMS/chats are not yet linked into CRM communication records; phone/PC connector
bindings currently use server configuration rather than administrator-managed
ConnectorSource rows. Full requested all-function acceptance remains open.

### Follow-up verification, 9 November2026

- Timestamp fix PR77: production deployment
  `a6c1a002-0087-4b3b-87aa-4a7cba146284` SUCCESS, health build705d4aa3188d.
  Actual Secretary list_phone_sms with the one-second time range
  07:33:45–07:33:46 UTC returns exactly one row, device_sms_id6377,
  at2026-11-09T07:33:45.483Z. Independent raw Bridge timestamp agrees.
  No second SMS was sent. Backend final CI112files/1083passed/0failed.
- Blocked-popup issue78 reproduced in real Chromium: deliberately delay the
  first recovery until the popup's Page event; engine1.1.1 leaves two tabs.
  Engine1.1.2 fixes event settlement and recovery without weakening URL policy
  or closing pre-existing/unowned tabs. Security/catalogue/text-only checks35/35
  pass; exact final release regression/integrity checks4/4 pass; PCP tests80pass,
  1skip,81subtests. These remain isolated browser tests, not owner-browser
  live acceptance.
- PCP PR13 mergedf6379426; independent signing run42585227083 SUCCESS;
  signed commitdabf4c4809586785254c4874230329c21474f977; deployment
  826a9062-8ecf-4ad0-82c8-c487f098e2cb SUCCESS. Served manifest verified with
  installed local trust pin. Normal Windows updater installed onlypc_engine.py
  at08:23:00 and accepted authenticated child heartbeat08:23:08 PID51144.
  Active engine1.1.2 SHA256
  22c7c652641018e60191a0992360a3b2d0384f31e5174b8131e93d71ba95a666.
  Secretary's generated signed snapshot is refreshed to that exact release;
  matching gateway deployment is pending this follow-up PR's CI.

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
