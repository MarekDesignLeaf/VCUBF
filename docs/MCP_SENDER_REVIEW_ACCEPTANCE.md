# MCP: WhatsApp sender review and guarded contact deletion (issue #74)

Status: **implemented and covered by automated tests; not accepted live.** No production
deployment, MCP reconnect, sender decision or contact deletion has been performed as part
of this change. Record any live check in `docs/PRODUCTION_ACCEPTANCE_LOG.md`.

## Diagnosis

Reproduced on 3 Nov 2026 after PR #73 was deployed: the connected ChatGPT Secretary tools
offered `run_read_command`, the catalogue read tools and the basic write tools
(`create_contact`, `update_contact`, `archive_contact`, …) but nothing for the WhatsApp
sender review or permanent deletion.

Cause: not a stale registration and not an access-control fault. The MCP tool list is built
in code (`backend/src/modules/mcp/routes.ts` and `writeTools.ts`), and PR #73 deliberately
classified `review_whatsapp_sender` and `delete_contact_permanently` as *interactive, web UI
only* (`EMMA_NON_DIRECT_ACTIONS`) and added no MCP tool for them. The only way to reach the
review was the Connectors page, which needs a Secretary web login.

## What the gateway now offers

| Tool | Kind | Needs |
| --- | --- | --- |
| `list_whatsapp_senders` | read | any MCP token, `crm.read`, administrator switch *list channel messages* on |
| `get_whatsapp_sender` | read | as above |
| `approve_whatsapp_sender` | previewed → `confirm_action` | `secretary.write`, `crm.manage` |
| `reject_whatsapp_sender` | previewed → `confirm_action` | `secretary.write`, `crm.manage` |
| `reopen_whatsapp_sender` | previewed → `confirm_action` | `secretary.write`, `crm.manage` |
| `defer_whatsapp_sender` | previewed → `confirm_action` | `secretary.write`, `crm.manage` |
| `delete_contact_permanently` | previewed → `confirm_action` **with `confirm_display_name`** | `secretary.write`, `crm.manage` |

Every tool runs through the owning service from PR #73
(`whatsappSenderReviewService`, `crmPermanentDeletionService`), so the same rules apply as
in the web UI: company scoping, the sender revision bound to the approval, dependency
checks and the preview digest re-checked under the row lock and the emergency-stop lock,
no change to WhatsApp messages, no automatic CRM contacts. Each call is audited twice: as
`mcp_write_tool` / `mcp_read_tool` (tool, phase, OAuth client, argument fingerprint) and by
the owning service (`review_whatsapp_sender`, `delete_contact_permanently`).

Permanent deletion through MCP:

1. `delete_contact_permanently {contact_id}` returns the exact contact, its client and
   connector links, what is kept, the digest, `confirm_display_name_required` and a
   `confirmation_id`. Nothing is deleted.
2. The assistant shows the preview, asks for an explicit yes and asks the user to type the
   exact name.
3. `confirm_action {confirmation_id, confirm_display_name}`. A missing or wrong name is
   refused with `CONFIRMATION_TEXT_MISMATCH` and consumes nothing. A preview that no longer
   matches (any edit to the contact or its links) is refused with `PREVIEW_CHANGED`. The
   confirmation works once, for ten minutes, only for the same user and OAuth connection.

Client permanent deletion is **not** exposed through MCP; it stays in the web UI.
Archiving (`archive_contact`) remains the reversible default.

Authentication is unchanged: the MCP OAuth 2.1 flow still needs the person's approval on
the consent page once per connection; no web session is needed for any tool call after
that. Nothing about the web login was changed or bypassed.

## Rollout (owner approval required for each step)

1. Merge the PR into `master`; let Railway deploy `backend` (no migration in this change).
2. Confirm on Railway that `MCP_GATEWAY_ENABLED=true` and `MCP_WRITE_ENABLED=true` are set
   on `backend` (they are already, if `create_contact` is offered today).
3. In ChatGPT, open the Secretary connector settings and **refresh** the connector's
   actions; if the new tools do not appear, **disconnect and connect again**. The
   `initialize` answer now reports `serverInfo.version` ending in
   `+2026-11-03.whatsapp-sender-review`. When reconnecting, approve **reading and writing**
   (tick the writing box), otherwise only the two read tools appear.
4. Claude: remove and re-add the custom connector the same way, if used.

## Manual production acceptance procedure

Use only the owner's account. Do not decide about real senders or delete real contacts
during acceptance unless the owner explicitly asks for that specific record.

1. **Discovery** — ask the assistant to list Secretary tools. Expect the seven tools above
   plus `confirm_action` and `cancel_action`. Record the tool names.
2. **Read** — "List the WhatsApp senders waiting for review." Expect
   `list_whatsapp_senders` with the source name, counts by status and senders sorted with
   work-related candidates first. Expect no browser window and no Secretary password prompt.
3. **Detail** — "Show the sender <name>." Expect `get_whatsapp_sender` with their messages
   and `allowedDecisions`.
4. **Approval preview only** — "Prepare approving <name> as a customer, but do not
   confirm." Expect a preview (contact create/link, client none/create/link) and a
   `confirmation_id`; then "Cancel it." Expect `cancel_action`; verify in Secretary that the
   sender is still pending and no contact was created.
5. **Deletion on a throwaway contact** — "Create a contact named MCP Acceptance Test with
   phone +447700900000." Then "Delete the contact MCP Acceptance Test permanently." Expect
   the preview and a request to type the name. Type a wrong name first: expect
   `CONFIRMATION_TEXT_MISMATCH` and the contact still present. Then type
   `MCP Acceptance Test` exactly: expect `deleted: true`.
6. **Audit** — in Secretary → Audit, find `mcp_read_tool`, `mcp_write_tool`
   (`prepare`, `cancel`, `confirm`) and one `delete_contact_permanently` success for the
   throwaway contact, all under the owner's company and user.
7. **Real decisions** — only after the owner names the sender and the classification, use
   the same preview → yes → `confirm_action` flow for each sender. Each preview replaces
   the previous one, so confirm one sender at a time.

Record date, environment, account, tool names seen, results and audit ids in
`docs/PRODUCTION_ACCEPTANCE_LOG.md`.

## Open risks

- No live ChatGPT/Claude acceptance has been performed; only automated tests against an
  embedded PostgreSQL database.
- ChatGPT caches tool lists per connection; until the connector is refreshed or
  reconnected, the new tools are invisible even after deployment.
- Permanent contact deletion via MCP has no separate administrator switch:
  `review_whatsapp_sender` and `delete_contact_permanently` are not voice capabilities, so
  the assistant policy page cannot switch them off. Access is controlled by
  `MCP_WRITE_ENABLED`, the per-connection `secretary.write` approval and `crm.manage`.
- The assistant (not the person) technically sends `confirm_display_name`; the tool text
  requires it to be what the user typed, but the server cannot tell who typed it. The
  preview, the explicit yes and the digest re-check remain the hard guards.
