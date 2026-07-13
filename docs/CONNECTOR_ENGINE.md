# Connector Engine — Google Workspace and WhatsApp Business

## Current status

The connector registry covers Gmail, Google Contacts, Google Calendar, Google Drive image selection, Google Photos selection and WhatsApp Business Cloud API. All six have real least-privilege adapters.

The Gmail adapter can:

- authorize a Google account with OAuth 2.0 using the exact selected Gmail scopes (`gmail.readonly`, `gmail.compose` and/or `gmail.send`);
- refresh an expired access token using an encrypted offline refresh token;
- list and read Gmail messages;
- establish a full-sync Gmail `historyId`, then import only added-message history changes;
- fall back to a safe full sync when Gmail reports an expired history cursor;
- idempotently import messages into `CommunicationIntake` with source, message and thread provenance;
- create reviewable Gmail drafts without sending;
- send a final email only through a separate confirmation-gated action;
- explicitly revoke and disconnect Gmail through a confirmation-gated action.

It cannot delete or label Gmail data. No attachment bytes are imported. Draft and send scopes are optional; a source configured only with `read:messages` remains read-only. Recipient, subject and body are shown in the send preview, while audit records retain only counts, lengths and provider result IDs rather than message content.

The Google Contacts adapter uses only `contacts.readonly`. It stages People API contact previews in `ExternalContact`; synchronisation never creates a CRM contact. A user holding both connector and CRM management permissions must review one staged record and confirm its import. Provider deletions archive only the staged record and never delete or deactivate a previously imported CRM contact. Initial sync requests `nextSyncToken`; later calls retrieve only changes. Google's `EXPIRED_SYNC_TOKEN` response triggers a safe full-sync fallback.

Google Calendar uses only `calendar.readonly`. Calendar and event metadata is staged separately from Secretary jobs and tasks. CalendarList and every calendar keep independent sync tokens; HTTP 410 clears only that calendar's stale event staging before a full reload. Provider cancellations never change internal scheduling or capacity records.

Enabled Gmail sources with `read:messages`, Google Contacts sources with `read:contacts`, and Google Calendar sources with `read:calendar` are synchronised by the backend automatically. The server runs a first sweep at startup, requests a sweep immediately after a supported source is enabled and then polls due sources every five minutes by default; `CONNECTOR_BACKGROUND_SYNC_INTERVAL_MINUTES` can set a longer or shorter interval (minimum one minute), while `CONNECTOR_BACKGROUND_SYNC_ENABLED=false` pauses this non-destructive polling for maintenance. A database lease prevents two server instances from processing the same due source together. Each provider sync retains its existing audit record and error status. **Sync now** is only an optional immediate refresh. Google Drive and Google Photos remain explicit user-selection flows, and WhatsApp remains event-driven through signed webhooks.

Google Drive deliberately uses non-sensitive `drive.file` rather than broad restricted Drive scopes. Google Picker grants access only to image files the user explicitly selects. The backend verifies each selected ID with `files.get`, accepts only `image/*`, stores metadata but no bytes, and requires confirmation before creating a Portfolio Photo reference. Registration leaves marketing use false and all review/permission states unreviewed or unknown.

Google Photos is a separate connector. It uses the Google Photos Picker scope `photospicker.mediaitems.readonly`, creates a short-lived server-side Picker session and opens the returned Google-controlled picker in a new tab (never an iframe). The user selects exact Photos items; the backend polls the session, retrieves only the selected item metadata, ignores the temporary `baseUrl` byte-download URL and deletes the completed session when possible. It never scans, searches or imports a whole Google Photos library. Only selected `PHOTO`/`image/*` items can become internal Portfolio Photo references after a separate confirmation.

WhatsApp Business uses a direct, deployment-level Cloud API connection for one business phone number. Meta webhook ownership is verified with a private verify token and every POST body must pass `X-Hub-Signature-256` verification with the Meta app secret. Inbound text and supported message captions are imported idempotently into `CommunicationIntake`; media bytes are not downloaded. Each signed inbound sender is also staged as an external contact. A valid number creates one CRM contact only when there is no active match; exactly one active normalized-phone match is linked, and multiple matches remain staged for duplicate review. Existing CRM contacts are never overwritten. The connector cannot backfill a complete historic WhatsApp address book: it synchronises only sender metadata delivered with new inbound webhooks. Outgoing text is previewed first and is sent only after explicit confirmation. Meta delivery status webhooks are accepted but currently remain audit/result metadata rather than a separate message-status table.

## API

| Method | Path | Permission | Behaviour |
|---|---|---|---|
| `GET` | `/connectors/definitions` | `connectors.read` | Lists static connector contracts and honest adapter availability. |
| `GET` | `/connectors/sources` | `connectors.read` | Lists company-scoped source registrations without credentials. |
| `GET` | `/connectors/sources/:id` | `connectors.read` | Gets one company-scoped source without credentials. |
| `POST` | `/connectors/setup/prepare` | `connectors.manage` | Idempotently registers missing disabled sources for one or all connectors and returns non-secret setup state. |
| `POST` | `/connectors/sources` | `connectors.manage` | Registers a disabled source. |
| `PUT` | `/connectors/sources/:id` | `connectors.manage` | Updates disabled source metadata and logical scopes. |
| `POST` | `/connectors/sources/:id/oauth/start` | `connectors.manage` | Creates an expiring one-time state and returns Google's authorization URL. |
| `GET` | `/connectors/gmail/oauth/callback` | one-time OAuth state | Exchanges the provider code, verifies `gmail.readonly`, encrypts tokens and redirects to the frontend. |
| `GET` | `/connectors/google-contacts/oauth/callback` | one-time OAuth state | Exchanges the provider code, verifies `contacts.readonly`, encrypts tokens and redirects to the frontend. |
| `GET` | `/connectors/google-drive/oauth/callback` | one-time OAuth state | Exchanges the provider code, verifies `drive.file`, encrypts tokens and redirects to the frontend. |
| `GET` | `/connectors/google-photos/oauth/callback` | one-time OAuth state | Exchanges the provider code, verifies the Google Photos Picker scope, encrypts tokens and redirects to the frontend. |
| `POST` | `/connectors/sources/:id/enable` | `connectors.manage` | Confirmation-gated enable after verified authorization. |
| `POST` | `/connectors/sources/:id/sync` | `connectors.manage` | Reads up to 50 Gmail messages and imports unseen messages. |
| `POST` | `/connectors/sources/:id/gmail/drafts` | `connectors.manage` | Creates a Gmail draft without sending it. |
| `POST` | `/connectors/sources/:id/gmail/messages/send` | `connectors.manage` | Previews, then sends a Gmail message after explicit confirmation. |
| `GET` | `/connectors/whatsapp/webhook` | Meta verify token | Verifies webhook ownership and returns Meta's challenge. |
| `POST` | `/connectors/whatsapp/webhook` | Meta signature | Imports signed inbound WhatsApp messages and synchronises sender contacts idempotently. |
| `POST` | `/connectors/sources/:id/whatsapp/messages/send` | `connectors.manage` | Previews, then sends a WhatsApp text after explicit confirmation. |
| `POST` | `/connectors/sources/:id/disconnect` | `connectors.manage` | Confirmation-gated Google token revocation and local credential/cursor deletion. |
| `GET` | `/connectors/sources/:id/drive-picker-token` | `connectors.manage` | Returns a short-lived Drive Picker configuration without a refresh token. |
| `POST` | `/connectors/sources/:id/drive-images/stage` | `connectors.manage` | Verifies and stages metadata for explicitly selected Drive image IDs. |
| `GET` | `/connectors/sources/:id/drive-images` | `connectors.read` | Lists staged Drive image metadata. |
| `POST` | `/connectors/sources/:id/drive-images/:imageId/register` | `connectors.manage` + `crm.manage` | Confirmation-gated Portfolio Photo reference from one Drive image. |
| `POST` | `/connectors/sources/:id/google-photos/picker-sessions` | `connectors.manage` | Creates a short-lived Google Photos Picker session. |
| `GET` | `/connectors/sources/:id/google-photos/picker-sessions/:sessionId` | `connectors.manage` | Reads picker completion state with no media bytes or token exposure. |
| `POST` | `/connectors/sources/:id/google-photos/picker-sessions/:sessionId/import` | `connectors.manage` | Stages metadata from completed user-selected Google Photos items and cleans up the session. |
| `GET` | `/connectors/sources/:id/google-photos/items` | `connectors.read` | Lists staged Google Photos metadata. |
| `POST` | `/connectors/sources/:id/google-photos/items/:photoId/register` | `connectors.manage` + `crm.manage` | Confirmation-gated Portfolio Photo reference from one Google Photos item. |
| `GET` | `/connectors/sources/:id/external-contacts` | `connectors.read` | Lists company-scoped staged Google contacts or synchronised WhatsApp sender contacts. |
| `POST` | `/connectors/sources/:id/external-contacts/:contactId/import` | `connectors.manage` + `crm.manage` | Confirmation-gated import of one reviewed contact into CRM. |
| `POST` | `/connectors/sources/:id/disable` | `connectors.manage` | Immediately prevents further synchronisation. |

`POST /connectors/sources/:id/sync` accepts optional `max_results` (1–50), `query`, `page_token` and `full_sync`. Without a query/page token, the first call establishes a profile `historyId`; later calls use `history.list` with `messageAdded`. Provider page continuation is stored internally. A Gmail 404 for an expired cursor automatically triggers a full fallback. The query, cursor, page token and message content are not written to the audit log.

## OAuth and credential security

Configure these values outside source control:

- `GMAIL_OAUTH_CLIENT_ID`
- `GMAIL_OAUTH_CLIENT_SECRET`
- `GMAIL_OAUTH_REDIRECT_URI`
- `GOOGLE_CONTACTS_OAUTH_CLIENT_ID`
- `GOOGLE_CONTACTS_OAUTH_CLIENT_SECRET`
- `GOOGLE_CONTACTS_OAUTH_REDIRECT_URI`
- `GOOGLE_CALENDAR_OAUTH_CLIENT_ID`
- `GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET`
- `GOOGLE_CALENDAR_OAUTH_REDIRECT_URI`
- `GOOGLE_DRIVE_OAUTH_CLIENT_ID`
- `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`
- `GOOGLE_DRIVE_OAUTH_REDIRECT_URI`
- `GOOGLE_DRIVE_PICKER_APP_ID` — Google Cloud project number
- `GOOGLE_DRIVE_PICKER_API_KEY` — browser-restricted Picker API key
- `GOOGLE_PHOTOS_OAUTH_CLIENT_ID`
- `GOOGLE_PHOTOS_OAUTH_CLIENT_SECRET`
- `GOOGLE_PHOTOS_OAUTH_REDIRECT_URI`
- `CONNECTOR_ENCRYPTION_KEY` — exactly 32 random bytes encoded as base64
- `FRONTEND_URL`
- `WHATSAPP_GRAPH_API_VERSION`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_BUSINESS_ACCOUNT_ID`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- `META_APP_SECRET`

The redirect URI must exactly match the Google Cloud OAuth web-client configuration. Real values must never be committed.

OAuth states are random, valid for ten minutes, stored only as SHA-256 hashes and consumed atomically before code exchange. Starting a new flow suspends the source and invalidates older states; disabling also removes pending states. The callback rechecks that the initiating user is still active and still has `connectors.manage`. Provider token bundles are encrypted with AES-256-GCM and authenticated against their company/source/provider context. APIs and audit snapshots expose only non-secret booleans such as `configurationAvailable` and `authorizationConfigured`; authorization codes, access tokens, refresh tokens, client secrets, search text and message content are excluded.

Disconnect is separate from Disable. Disable immediately blocks Secretary access but retains the encrypted credential. Disconnect requires risk-3 confirmation, disables first, revokes the refresh token at Google, then deletes the encrypted credential and sync cursor. Google documents that revocation can remove every OAuth scope granted to that Google Cloud project for the account, so this impact is shown before confirmation. If provider revocation fails, the source stays disabled and the encrypted credential is retained for a safe retry.

`gmail.readonly` and `gmail.compose` are Google restricted scopes; `gmail.send` is sensitive. A public production deployment may require Google OAuth verification and, depending on how restricted data is stored or transmitted, an additional security assessment. Deployment approval is an operational prerequisite, not something the application can self-certify.

`contacts.readonly` is requested separately with its own redirect URI. Public use of Google user-data scopes may require OAuth app verification. Contacts credentials must remain outside source control and are encrypted with the same connector key boundary as Gmail.

## Import mapping and idempotency

Each imported Gmail message creates one `CommunicationIntake`:

- `channel = email`;
- sender name/email from the `From` header;
- subject plus readable text/plain body (HTML or snippet fallback);
- received time from `Date`, then Gmail `internalDate` fallback;
- `connectorSourceId`, `externalMessageId`, `externalThreadId`;
- `sourceReference = gmail:<source-id>:<message-id>`.

The database unique key `(companyId, connectorSourceId, externalMessageId)` prevents duplicate intake records. Repeated synchronisation reports existing messages as skipped. Message text is capped at 100,000 characters to bound local storage.

## Source lifecycle

Say **Emma, set up all connectors** (or name one connector) to use the guided path. It prepares missing disabled sources, skips and reports unavailable deployment configuration, opens each Google OAuth flow in sequence, resumes after callback, obtains the mandatory Enable confirmation, and performs the first supported Gmail/Contacts/Calendar sync. It never approves provider consent, confirms external access, selects Drive files or Google Photos items, or creates missing provider credentials on the user's behalf.

The same lifecycle can be completed manually:

1. Register Gmail (choose read, draft and/or send scopes), Google Contacts (`read:contacts`), Google Drive (`select:image_files`), Google Photos (`select:user_selected_photos`) or WhatsApp Business (`read:messages`, `send:messages`).
2. Choose **Authorize Gmail/Contacts/Drive/Google Photos** and complete Google's consent screen.
3. Review and explicitly enable the source.
4. After Enable, the server starts the first supported Gmail/Contacts/Calendar sync automatically. Use **Sync now** only when an immediate refresh is useful. Gmail imports Communication Intake; Contacts creates reviewable staging records only.
5. For Contacts, choose **Review contacts** and explicitly confirm any CRM import.
6. Use **Disable** to stop access temporarily, or confirmed **Disconnect** to revoke and delete authorization.

For WhatsApp, configure the six server variables, register and enable one source, then set the Meta callback URL to `/connectors/whatsapp/webhook` with the same verify token. Inbound messages and sender-contact synchronisation arrive automatically; there is no manual sync button.

Cross-company source IDs resolve as not found. Provider failures set `lastSyncStatus` and a non-secret `lastErrorCode`. Registration, OAuth start/completion, enable/disable and sync are audited without provider secrets or message content.

## Remaining connector work

- Gmail push notifications (background polling is implemented);
- encryption-key rotation workflow;
- attachment metadata and separately authorized attachment ingestion;
- provider sandbox verification plus production Google Picker origin/API-key restrictions;
- WhatsApp approved-template sending outside the customer-service window and persisted delivery-state history;
- multi-business WhatsApp Embedded Signup (the current direct connection intentionally supports one phone number).

Official implementation references: [Google OAuth 2.0 for web server applications and revocation](https://developers.google.com/identity/protocols/oauth2/web-server), [People API connections.list](https://developers.google.com/people/api/rest/v1/people.connections/list), [Calendar events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Google Picker](https://developers.google.com/workspace/drive/picker/reference/picker), [Drive files metadata](https://developers.google.com/workspace/drive/api/guides/file-metadata), [Gmail synchronization guide](https://developers.google.com/workspace/gmail/api/guides/sync), [WhatsApp Cloud API webhook contact payload](https://www.postman.com/meta/whatsapp-business-platform/request/36ymkut/received-contact-messages), and [Google restricted scopes](https://support.google.com/cloud/answer/13464325).
