# Phone and PC integration through the Secretary MCP gateway

Status (9 November 2026): PR76 merged and deployed as `b18614371533`.
The existing Secretary plugin was refreshed in place: 100 tools, 40 read and
60 write. Actual ChatGPT checks passed for capability metadata, phone/SMS
reads, PC permissions/window reads and public HTTPS text fetching. One explicitly
approved self-addressed SMS was sent and received, with exactly one outbound
operation. Do not repeat that test. Live notification replies, WhatsApp Business
delivery and interactive browser control remain unverified; full acceptance is
not claimed from these partial checks.

### Phone timestamp contract

Android SMS `received_at`, notification `ts` and their `since`/`until` filters
use Unix milliseconds, as supplied by Android. Bridge bookkeeping fields
(`last_upload_at`, `gateway_last_seen`, listener `reported_at` and outbound
`updated_at`) use Unix seconds. Secretary converts each according to its field
contract and returns ISO dates. Do not infer units from the number's magnitude.

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
| WhatsApp **Business** (official Cloud API, existing connector) | inbound messages received by webhook into communication intakes, sender review | MCP `send_whatsapp_business_message` (to a number) and `reply_whatsapp_business_message` (to a received message by its id from `get_whatsapp_sender`), previewed, through the existing service | only the business number; free-form only within 24 h of the person's last message; no templates, media or history beyond received webhooks; Meta takes no request id, so an unanswered send stays **unknown** and is never retried |
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

### The PC: every PC Control Plus tool, each with its own trust boundary

The PC tools come from two generated catalogues, never from a hand-written list:

- the shared engine (`pc_engine.TOOLS` → `pcEngineCatalogue.generated.ts`);
- the relay's own tools (files, desktop input, `web_*`, `ui_*`, goals, camera,
  permissions) → `pcpRelayCatalogue.generated.ts`, written by
  `windows-companion/pc-control/server/import_pcp_catalogue.py --refresh --pcp <checkout>`
  from the relay's MCP tool list (names, descriptions, JSON schemas, relay job ids).

**Pinned upstream with release provenance, checked without credentials.**
pc-control-plus is private, so VCUBF vendors a minimal snapshot of exactly the pinned
signed release in `windows-companion/pc-control/pcp-upstream/`. It holds:

- the nine files the import reads: `relay.py`, `oauth.py`, `pc_engine.py`,
  `requirements.txt`, `release-manifest.json` and the four control-loop modules;
- three git objects: the commit, its root tree and the `remote/` tree.

No history and no other file is vendored (no `.env.example`, no agent or installer
code). The pin `windows-companion/pc-control/pcp-upstream.json` names the commit, its
tree, the release id and the release public key, pinned in VCUBF and never taken from
upstream.

`import_pcp_catalogue.py --check` (no network, no token) proves:

1. the commit object hashes to the pinned commit and names the pinned tree;
2. the root tree hashes to that tree, its `remote/` entry to the remote tree, and every
   vendored file to its blob there — `relay.py` included, which the release manifest
   does not sign;
3. nothing else is in the snapshot;
4. the manifest's Ed25519 signature verifies with the pinned key for the pinned release
   id, and the vendored signed files have their signed SHA-256;
5. the attested goal modules are those signed files;
6. the committed catalogue records this snapshot and is exactly what the relay in it
   produces now.

CI job `relay-catalogue` runs that, then the tamper tests
(`windows-companion/pc-control/tests/test_pcp_snapshot.py`: changed `relay.py`, changed
signed file, rewritten tree, wrong commit, tree, release or key, extra file, stale
catalogue, failed refresh changes nothing).

**Updating** (on a machine with an authenticated pc-control-plus checkout at the signed
release to pin):

```bash
python windows-companion/pc-control/server/import_pcp_catalogue.py --refresh --pcp ../pc-control-plus
```

`--refresh` reads the checkout's HEAD from git objects, not from the working tree. It
writes the snapshot, the pin and the catalogue together, and only after the new snapshot
passes every check; a failure changes nothing. A new release key is given explicitly
with `--public-key-b64`. Today the pin is release `5aa7630` (`signed-release`
`dabf4c4`, tree `ac2dab7`), shared engine1.1.2.

Secretary's decision per relay tool is `backend/src/modules/mcp/pcRelayPolicy.ts`;
`tests/mcpDevices.test.ts` fails when a relay tool has no decision or a decision names
no tool:

| Decision | Tools | How it runs |
| --- | --- | --- |
| read | `system_info`, `monitors_list`, `list_directory`, `read_text`, `search_files`, `audit_tail`, `approvals_list`, `permission_status`, `web_tabs_list`, `web_list_fields`, `web_dom`, `ui_tree`, `ui_wait`, `web_goal_status`, `ui_goal_status` | at once under `read_pc`; leaves nothing running or queued |
| reviewed | `write_file` (text or base64; the preview shows binary content by size and SHA-256), `write_workspace_text`, `make_directory`, `move_file`, **`delete_file`, `delete_workspace_file`** (the PC first saves a backup copy, refuses paths outside its profile or workspace), **`run_approved_script`** (only a `name.ps1`/`name.py` from the owner's approved-scripts folder, no shell, 12 s), keyboard input to the window in front (`desktop_type`, `desktop_hotkey`, `desktop_focus_window`), `open_url`, `web_*` steps, `ui_batch`, `web_goal_start` / `ui_goal_start` (they keep running on the PC) and their cancel | preview (with the PC's protections) → yes → one call, `operate_pc`; never read-only; the PC asks its owner again |
| not offered | owner-local, pending review: `run_command` (an unreviewed shell), `permission_set`, `approvals_reset` (the PC's own safety settings); by the text-state rule: `desktop_click`, `desktop_drag`, `desktop_scroll`, `desktop_batch` (screen coordinates), `screenshot`, `web_screenshot`, `camera_*` (images never drive automation); `web_close`; the relay's `ui_windows` (the engine's is offered) | listed in `describe_capabilities.notOffered` with the reason; refused before any request |

This is not every PC function: the shell, the PC's safety switches, coordinate input
and image capture stay on the PC, each with its reason, until reviewed.

**Text state only (owner's rule).** PC control through Secretary works only from text
state: page snapshots (DOM) and Windows UI Automation. No screenshot, camera or
screen-coordinate tool is offered, and no image ever drives a step. The rule is in every
PC tool's limitations and in the gateway instructions. A control loop (a goal: an AI
deciding step after step on the PC) is offered only while the importer attests from the
PC Control Plus source that the whole loop takes no screenshots
(`pcpRelayCatalogue.control_loops`: `web_goal` works from the DOM, `ui_goal` from UI
Automation, each with its modules' SHA-256). A loop whose source uses pixels, or that has
no attestation, is not offered, whatever the policy says (`decideRelayJob`, tested).

Arguments are checked against the relay's own schema, strictly. The approval on the PC itself stays in force
for every sensitive step.

### Single owner, server-side tokens

SMS Bridge and the PC relay each serve one owner. Each is bound to exactly one
Secretary company (`SMS_BRIDGE_COMPANY_ID`, `PCP_COMPANY_ID`): for every other company
its tools are not listed, are described as `connector_not_configured`, and every call is
refused before any request, so no other company can use the upstream token. The tokens
and upstream addresses live only in the backend's environment: they are never in
`tools/list`, `initialize`, `describe_capabilities`, a preview or an answer (tested).

## Secretary's own assistant and agent (control tower)

The same contracts are executable actions (`emmaExecutableActionCatalogue.ts`), so the
agent tool catalogue (ledger `TOOL_CATALOGUE_FINGERPRINTS` 1.5.0) and voice/text commands
offer them through the existing deterministic engine. There is no second orchestrator. The owning
service is `backend/src/services/deviceActionService.ts`:

| Action | Contract | Agent kind |
| --- | --- | --- |
| `phone_status`, `list_phone_sms`, `list_phone_chats`, `phone_message_status` | `read_phone_messages` | read (runs at once) |
| `send_phone_sms`, `reply_phone_chat` | `send_phone_sms`, `reply_phone_chat` | external, preview → yes |
| `whatsapp_message_status` | `read_whatsapp_delivery_status` | read |
| `list_pc_tools`, `read_pc` | `read_pc` | read |
| `operate_pc` | `operate_pc` | administration, preview → yes |

WhatsApp Business send and reply were already agent actions (`send_whatsapp`,
`reply_whatsapp`). Every call goes through the caller's permission and the
administrator's switch (`evaluateEmmaCommand`, at proposal and again at execution);
a send or PC step answers `CONFIRMATION_REQUIRED` with the exact preview and runs only
with the yes, after checking the emergency stop again. An SMS or chat reply carries the
bridge request id fixed in its preview; an unknown outcome is audited as
`OUTCOME_UNKNOWN`, never retried by itself, and settled by preparing the same message
with `reuse_request_id` (accepted only for a request id Secretary recorded as unknown for
this company; SMS Bridge de-duplicates on it). `read_pc` and `operate_pc` take only the
catalogue tools above (`list_pc_tools` lists them with their parameters and what is not
offered). The communication specialist plans with the phone tools. Tested in
`tests/agentDevices.test.ts`.

## WhatsApp Business delivery status

Meta's status webhooks (sent, delivered, read, failed with Meta's error) are recorded
from the verified webhook into `whatsapp_message_statuses`, one row per sent message,
only ever moved forward. They are read with `get_whatsapp_message_status` (by message
id), `get_outbound_message_status` (by the MCP confirmation) and the agent action
`whatsapp_message_status`. A message Meta has not reported on is `not_reported`; nothing
is guessed.

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

VCUBF CI needs no secret for the relay catalogue: it checks the vendored snapshot.

Confirm that `release_public_key_b64` in `pcp-upstream.json` equals the
`PCP_RELEASE_PUBLIC_KEY_B64` pinned on the PC.

The migration `20261109120000_whatsapp_message_status` adds one table; it changes no
existing row.

## Scope of this PR

Done: SMS Bridge, PC Control Plus and WhatsApp Business through the MCP gateway and
through Secretary's own assistant and agent, under the same contracts; operation state
and unknown outcomes for every send; WhatsApp delivery status; every PC Control Plus
tool decided (engine and relay), PC control from text state only; the relay catalogue
pinned to a signed release with a drift check in CI; locale-free fingerprints. Tests run
against local fake services only.

## Still open (not done here)

- **Owner-local PC functions pending review:** `run_command`, `permission_set`,
  `approvals_reset`. Coordinate input and image capture are not offered under the
  text-state rule.
- **`ConnectorSource` binding for phone and PC:** they are bound to one company by
  environment (`*_COMPANY_ID`), not by a row an administrator enables in Secretary.
- **CRM linking:** phone SMS and notification chats are not written to CRM
  communication records.
- **Live acceptance:** phone/SMS reads, one self-addressed SMS, notification
  input and PC text reads/writes have direct evidence recorded in the acceptance
  log. Notification replies, Business delivery and interactive browser actions
  remain open (see below).
- **PC steps run twice in parallel:** guarded by the single claim of the review or
  agent proposal, not by the PC (PC Control Plus takes no request id). Phone sends are
  additionally de-duplicated by SMS Bridge on the request id.

## Live verification still required (owner / Codex)

Record live checks in `docs/PRODUCTION_ACCEPTANCE_LOG.md`. Automated adapter
tests use local fake bridges; they do not substitute for the checks below.
Already recorded checks must not trigger another real SMS test.

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
6. One `reply_whatsapp_business_message` to a message received on the business
   number within 24 hours: one reply in that thread, quoting it; a repeated yes
   sends nothing.
7. Disconnect the bridge during a send in a test environment (not production)
   to see `unknown`, then `resubmit_phone_message` resolving it without a
   second message.
