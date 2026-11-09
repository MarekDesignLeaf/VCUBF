# MCP capability metadata (permanent product requirement)

Status: **implemented and covered by automated tests; not accepted live.** No deployment,
reconnect, sender decision, test task or test contact was made in production as part of
this change. Record any live check in `docs/PRODUCTION_ACCEPTANCE_LOG.md`.

## Why

On 3 Nov 2026, after the Secretary connector was reconnected with reading and writing,
ChatGPT reported "39 Secretary functions" and could not name or explain any of them. The
tools were all in `tools/list`, but nothing told the client in one place what each one
does, what it needs, and what it risks; the `initialize` instructions were hand-written
prose naming only a few tools.

Owner requirement: every time the Secretary MCP tool set is added to, removed from or
changed, the plugin must automatically carry an up-to-date machine-readable description of
every capability, versioned and shipped with the software. A hand-maintained list is not
acceptable.

## Design

One catalogue, generated from the tool definitions themselves:

- `backend/src/modules/mcp/capabilities.ts` — the shape of a capability (`McpCapability`),
  the availability reasons, the consistency check (`capabilityProblems`) and the generated
  `initialize` summary (`capabilitySummary`). Pure: no database, no environment.
- `backend/src/modules/mcp/writeTools.ts` — `writeToolCatalogue()` builds, for every write
  tool plus `confirm_action` and `cancel_action`, its `tools/list` entry **and** its
  capability from the same `WriteToolDefinition`. A write tool cannot compile without a
  `sideEffects` text. Permission, Action Contract, risk level, confirmation, idempotency
  and the destructive/irreversible/financial/permanent flags come from the contract and
  the review reason, so they cannot disagree with how the tool actually runs. The
  `destructiveHint` annotation is computed by the same function.
- `backend/src/modules/mcp/routes.ts` — `mcpCatalogue(user, access)` adds the metadata
  tool, `run_read_command`, the catalogue reads (permission and switch from the agent tool
  catalogue) and the gateway reads (each names the command whose permission and switch
  govern it, used both for the check before each run and for the description).
  `tools/list`, the `initialize` summary and `describe_capabilities` are all filtered views
  of that one list. `tools/call` dispatches through `mcpToolRunner`, which the tests check
  against every catalogue name.

### `describe_capabilities`

Always listed, on every connection (read-only and write-approved). Arguments: optional
`tool` to describe one tool. It reads no company records and writes nothing — not even an
audit entry; it uses only the signed-in user already on the request (for the account's
permissions) and the server switches. It is still behind the gateway's door: OAuth or the
owner's token, the gateway switch and the emergency stop.

The answer contains `toolsetRevision`, `toolsetFingerprint`, `server.version`, the
connection (`writeEnabledOnServer`, `writeApproved`, `canWrite`, `passwordChangeRequired`),
counts, and for **every** tool the server has — including those this connection cannot
see:

| Field | Meaning |
| --- | --- |
| `name`, `title`, `purpose` | exactly as `tools/list` shows them |
| `access`, `readOnly` | `metadata`, `read` or `write` |
| `oauthScope` | `secretary.read` or `secretary.write` |
| `requiredPermission` | account permission, `authenticated`, or `per_command` |
| `capabilitySwitch` | the administrator's switch on the assistant policy page, `per_command`, or `null` when no switch exists |
| `actionContract`, `riskLevel` | the Action Contract carried out and its risk level |
| `riskClass`, `destructive`, `irreversible`, `financial`, `permanent` | classification |
| `confirmation` | `none`, `preview_then_confirm`, `preview_confirm_and_typed_name`, `confirms_preview`, `withdraws_preview` |
| `idempotency` | `not_applicable`, `idempotency_key_required`, `once_per_confirmation_id` |
| `readsCompanyRecords`, `sideEffects`, `limitations`, `audit` | what a call touches, changes and records |
| `inputFields`, `requiredInputs` | top-level argument names from the `tools/list` schema |
| `availability` | `listed`, `reason` (`available`, `missing_permission`, `requires_write_scope`, `write_disabled_on_server`, `no_previewed_tool_available`, `connector_not_configured`) and `howToEnable` |

A read-only connection therefore learns that, for example, `create_task` and
`delete_contact_permanently` exist and are `requires_write_scope`, with the instruction to
reconnect and tick the writing box.

### `initialize`

The instructions are the hand-written policy (`MCP_READ_POLICY` / `MCP_WRITE_POLICY`)
followed by a generated summary: the toolset revision, the number of tools on this
connection, every listed tool name grouped as metadata / read / write at once / previewed
/ permanent with typed name / answering a preview, every held-back name grouped by reason
with how to enable it, and a pointer to `describe_capabilities`.

### Versioning and drift guards

- `MCP_TOOLSET_FINGERPRINTS` in `routes.ts` is an append-only ledger:
  revision → SHA-256 of the whole catalogue (every listing and capability for a
  write-approved account holding every permission). `MCP_TOOLSET_REVISION` is its last
  key and reaches clients in `serverInfo.version` (`<catalogue version>+<revision>`).
- `tests/mcpCapabilities.test.ts` recomputes the fingerprint. **Any** change to any tool —
  added, removed, renamed, new description, schema, scope, permission, confirmation, risk,
  side effects — fails CI until a new revision is appended. CI also runs
  `scripts/check-ledger-append-only.mjs … MCP_TOOLSET_FINGERPRINTS` against `master`, so a
  shipped revision can never be rewritten.
- The same test fails when a defined tool has no capability, a capability names a tool
  that no runner serves, a name appears twice, required metadata is empty, flags
  contradict (e.g. a permanent tool without the typed-name confirmation), an annotation
  disagrees with the metadata, a reported administrator switch does not exist or cannot be
  turned off, or the hand-written policy text names a tool or argument that does not exist.

### How to change the tool set

1. Change or add the tool definition (`GATEWAY_READ_TOOLS` in `routes.ts`, or
   `WRITE_TOOLS` in `writeTools.ts`, filling every required field including `sideEffects`
   or `policyCommand`/`limitations`).
2. Run `npm run test:embedded`; the fingerprint test prints the mismatch.
3. Append a new revision (`YYYY-MM-DD.short-name`) with the new fingerprint to
   `MCP_TOOLSET_FINGERPRINTS`. Never edit a shipped entry.
4. Update the README MCP section and the relevant acceptance document.
5. After deployment, refresh or reconnect the ChatGPT/Claude connector.

### Revision `2026-11-09.phone-and-pc`

Adds the owner's phone (SMS Bridge) and PC (PC Control Plus) tools; see
`docs/PHONE_PC_INTEGRATION.md`. Reads: `phone_status`, `list_phone_sms`,
`list_phone_chat_messages`, `get_outbound_message_status`, `pc_connection_status` and
the read-only `pc_*` engine tools. Previewed writes: `send_phone_sms`, `reply_phone_chat`,
`resubmit_phone_message`, `pc_browser_open`, `pc_browser_act`, `pc_browser_tabs`,
`pc_ui_act`. The PC tool names and schemas are generated from the pc_engine catalogue
(`pcEngineCatalogue.generated.ts`, checked by
`windows-companion/pc-control/tests/test_engine.py`); `browser_eval` and `browser_close`
are not offered. A tool whose connector is not set up for the caller's company is not
listed and is described with the reason `connector_not_configured`. The fingerprint does
not depend on the environment.

## Safety unchanged

Tenant isolation, OAuth scopes, account permissions, administrator switches, audit,
previews and `confirm_action`, the typed name for permanent deletion, idempotency keys and
the emergency stop are exactly as before; no write path changed. The metadata tool cannot
reach a service, a record, the review queue or the idempotency store.

## Tests run

`tests/mcpCapabilities.test.ts` (new): drift both ways, required fields on every kind of
connection, the fingerprint ledger, policy-text names, truthful metadata for `create_task`,
the WhatsApp sender review tools and `delete_contact_permanently`, a read-only and a
write-approved OAuth connection receiving truthful and complete descriptions, a
permission-less account and the write switch off, no database change (including audit,
reviews and idempotency keys) from `describe_capabilities`, and every described tool being
dispatchable. Existing MCP suites updated for the new always-visible tool.

## Manual production acceptance (owner approval required)

1. Deploy, then refresh (or disconnect and reconnect) the connector in ChatGPT. Expect
   `serverInfo.version` ending `+2026-11-03.capability-metadata`.
2. Read-only connection: ask "What can Secretary do?". Expect the assistant to name the
   tools on the connection and to say that write tools such as `create_task` need a
   reconnect with write approval.
3. Read+write connection: ask the same. Expect all 40 tool names with read/write,
   previewed and permanent ones identified correctly.
4. Ask "Describe delete_contact_permanently." Expect the typed-name confirmation, the
   permanent classification and no administrator switch.
5. Verify in Secretary → Audit that these questions created no `mcp_read_tool` entries for
   `describe_capabilities`.

No business record needs to be created or changed for this acceptance.

## Open risks

- No live ChatGPT or Claude acceptance yet.
- Clients that cache tool lists still need a refresh or reconnect after a new revision;
  `capabilities.tools.listChanged` stays `false` because the server is stateless.
- Read tools are listed to every connection even when the account lacks their permission
  (unchanged behaviour); `describe_capabilities` marks them `missing_permission`.
- Administrator switches and the emergency stop are checked when a tool is called, not in
  the description (that would read company settings).
