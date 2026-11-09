# Phone and PC integration through the Secretary MCP gateway

Status: **in development** on branch `claude/modest-keller-42onis`. Not deployed,
not accepted live. No real message has been sent and no production data was
touched while building it.

## Goal

ChatGPT (and any MCP client) controls the owner's phone channels and PC through
one connector, the Secretary MCP gateway, with Secretary's own guarantees:
company isolation, OAuth scopes, account permissions, administrator switches,
the emergency stop, audit, idempotency, and preview → explicit yes → action for
everything that leaves the company.

Secretary does not get a second orchestrator or database. It talks to the two
systems that already exist and own the devices:

| System | Owns | Secretary uses |
| --- | --- | --- |
| **SMS Bridge API** (`MarekDesignLeaf/sms-bridge-api`) | the Android phone (SIM, SMS store, notification listener) | `X-Admin-Token` HTTP API: `/api/dashboard/status`, `/api/phone/health`, `/api/phone/messages`, `/api/chat/messages`, `/api/send`, `/api/messages/{id}`, `/api/chat/reply`, `/api/chat/reply/{id}` |
| **PC Control Plus relay** (`MarekDesignLeaf/pc-control-plus`) | the Windows PC agent (local approvals, permission profile, browser and UI Automation through the shared `pc_engine`) | `POST /v1/call {tool, args}` with the client token, only tools the relay allows |
| **Secretary** (this repo) | WhatsApp Business Cloud API (official), CRM, communications, audit | existing services, unchanged |

## Channels and what each can honestly do

| Channel | Read | Send | Limits stated to the AI |
| --- | --- | --- | --- |
| SMS (phone SIM via SMS Bridge) | SMS the phone owner synchronised to the bridge (filters: address, text, time) | new SMS to an E.164 number; preview → yes → queued on the phone | only synchronised SMS are visible; daily send cap on the bridge; the phone must be online |
| WhatsApp **Business** (official Cloud API, existing connector) | inbound messages received by webhook into communication intakes, sender review | reply inside the 24-hour customer-service window (existing service) | only the business number; templates outside 24 h are not in scope |
| WhatsApp / Messenger **from the phone's notifications** (SMS Bridge listener) | only messages whose notification the phone showed after notification access was granted | reply through the notification's reply action, to a chat with a recent notification | **no history, no media, no contacts list, no new chats**; a dismissed notification can make the reply fail; delivery is not confirmed by WhatsApp |
| PC browser and Windows apps (PC Control Plus) | page snapshots, text, extraction, web fetch, window/control snapshots | browser and UI actions; the PC asks its owner again locally | public HTTPS only; the owner's other tabs untouched; see `pc-control-plus` README |

Never claimed: a full WhatsApp chat history, reading the personal WhatsApp app,
delivery or read receipts the interface does not report.

## Trust boundaries

1. **MCP client → Secretary**: OAuth scope (`secretary.read` / `secretary.write`),
   account permission, administrator switch per Action Contract, company of the
   user, emergency stop (`safe mode`).
2. **Secretary → bridge / relay**: a server-side secret per system (environment
   variable, never in the database, code or a response), and a **company
   binding**: each system serves exactly one Secretary company
   (`*_COMPANY_ID`). Any other company sees the tools as
   `connector_not_configured` and can never reach the device.
3. **Relay → PC**: PC Control Plus' own rules stay in force (local Windows
   approval, read-only profile, public HTTPS only). Secretary's confirmation
   does not replace the PC owner's local approval.
4. Nothing generic crosses a boundary: tool names and argument schemas come
   from catalogues (Action Contracts here, `pc_engine.TOOLS` for the PC), there
   is no execute, shell or raw HTTP proxy, and the relay additionally only runs
   tools in its own allowlist.

## Operation state, idempotency and uncertain results

- Every external send is a **reviewed write**: the first call returns the exact
  preview and a `confirmation_id`; only `confirm_action` after the user's
  explicit yes sends.
- The request to the bridge carries a request id derived from the company and
  the confirmation (`vcubf-<company>-<confirmation>`), and the bridge
  de-duplicates on it, so the same confirmation can never produce two messages.
- If the call to the bridge fails after it may have been received (timeout,
  connection lost), the outcome is stored as `OUTCOME_UNKNOWN` and is **never
  retried automatically**. `get_outbound_message_status` reports what the
  bridge knows; a re-submission is a new, explicit, previewed action and reuses
  the same request id, so it cannot send twice.
- What a confirmed send sent (tool and arguments) is kept next to its outcome
  in the confirmation's own idempotency record (the review queue clears its
  payload once it resolves), so its state can be looked up by
  `confirmation_id` for as long as that record is kept. No new table.
- A bridge that refuses the connection or whose host does not resolve cannot
  have received anything: that is answered as `PROVIDER_UNAVAILABLE`
  ("Nothing was sent"), not as unknown.
- Bridge states are passed through as they are: `queued`, `leased`, `sent`,
  `failed`, `uncertain` (the phone took the job but did not confirm it; the
  bridge never retries it), `cancelled`; for notification replies the device
  action states `queued`, `leased`, `completed`, `failed`, `denied`, `uncertain`.

## Capability catalogue

All phone and PC tools are entries of the generated MCP capability catalogue
(`describe_capabilities`), with availability and the exact reason when they
are not usable: `requires_write_scope`, `missing_permission`,
`write_disabled_on_server`, `connector_not_configured` (system not set up for
this company), each with how to enable it. The PC tool names, parameters,
levels and guidance are generated from `pc_engine.TOOLS`
(`backend/src/modules/mcp/pcEngineCatalogue.generated.ts`, written by
`windows-companion/pc-control/server/export_catalogue.py` and drift-checked by
`windows-companion/pc-control/tests/test_engine.py`). `browser_eval` and
`browser_close` are not offered through Secretary.

## Configuration (no secrets in the repository)

Set on the Railway `backend` service:

| Variable | Secret | Meaning |
| --- | --- | --- |
| `SMS_BRIDGE_URL` | no | base URL of the SMS Bridge API, `https://…` |
| `SMS_BRIDGE_ADMIN_TOKEN` | **yes** | the bridge's `ADMIN_TOKEN` (header `X-Admin-Token`) |
| `SMS_BRIDGE_COMPANY_ID` | no | the Secretary company (UUID) the phone belongs to |
| `SMS_BRIDGE_DEVICE_ID` | no | optional: the paired device id of the phone; empty = the bridge's default device |
| `PCP_RELAY_URL` | no | base URL of the PC Control Plus relay, `https://…` |
| `PCP_CLIENT_TOKEN` | **yes** | the relay's `PCP_CLIENT_TOKEN` (Bearer) |
| `PCP_COMPANY_ID` | no | the Secretary company (UUID) the PC belongs to |

Writes additionally need `MCP_GATEWAY_ENABLED=true`, `MCP_WRITE_ENABLED=true`
(already used) and a connection approved for `secretary.write`.

## Phases

1. **This PR**: SMS Bridge and PC Control Plus adapters; MCP read tools
   (phone status, SMS, notification chats, PC connection, PC read tools) and
   reviewed writes (send SMS, notification reply, PC browser/UI actions);
   operation status; catalogue integration; tests against local fake bridges.
2. Official WhatsApp Business reply through MCP (existing service, 24-hour
   window), and linking sent/received phone messages to CRM communication
   records.
3. Agent (control-tower) access to the same contracts; live acceptance with
   the owner's phone and PC.

## Live verification still required (owner / Codex)

Nothing here is accepted live until recorded in
`docs/PRODUCTION_ACCEPTANCE_LOG.md`. All tests run against local fake bridges.

1. `phone_status` on the owner's connection: the bridge reports the Samsung
   SM-S938B online and its last sync.
2. `list_phone_sms` and `list_phone_chat_messages` return real synchronised
   SMS and notification-captured chats; another company sees the tools as
   `connector_not_configured`.
3. One `send_phone_sms` to the owner's own number: preview, explicit yes,
   exactly one SMS on the phone, `get_outbound_message_status` → `sent`; a
   repeated yes sends nothing.
4. One `reply_phone_chat` in a WhatsApp chat that has a current notification
   on the phone: the reply appears once; status → `completed`.
5. `pc_connection_status` and one read (`pc_browser_snapshot`) with the PC
   agent online; one `pc_browser_open` of a harmless public page after the yes,
   approved on the PC by the owner.
6. Disconnect the bridge during a send in a test environment (not production)
   to see `unknown`, then `resubmit_phone_message` resolving it without a
   second message.
