# Connector Engine — Phase 3 Gmail read-only adapter

## Current status

The connector registry and tenant source lifecycle cover Gmail, Google Contacts, Google Calendar and Google Drive photo storage. Gmail is the first real adapter and is deliberately read-only. The other three definitions remain contract-only and fail closed.

The Gmail adapter can:

- authorize a Google account with OAuth 2.0 using only `gmail.readonly`;
- refresh an expired access token using an encrypted offline refresh token;
- list and read Gmail messages;
- establish a full-sync Gmail `historyId`, then import only added-message history changes;
- fall back to a safe full sync when Gmail reports an expired history cursor;
- idempotently import messages into `CommunicationIntake` with source, message and thread provenance;
- explicitly revoke and disconnect Gmail through a confirmation-gated action.

It cannot draft, send, delete, label or otherwise change Gmail data. No attachment bytes are imported. External write actions remain separate future work and must retain explicit confirmation boundaries.

## API

| Method | Path | Permission | Behaviour |
|---|---|---|---|
| `GET` | `/connectors/definitions` | `connectors.read` | Lists static connector contracts and honest adapter availability. |
| `GET` | `/connectors/sources` | `connectors.read` | Lists company-scoped source registrations without credentials. |
| `GET` | `/connectors/sources/:id` | `connectors.read` | Gets one company-scoped source without credentials. |
| `POST` | `/connectors/sources` | `connectors.manage` | Registers a disabled source. |
| `PUT` | `/connectors/sources/:id` | `connectors.manage` | Updates disabled source metadata and logical scopes. |
| `POST` | `/connectors/sources/:id/oauth/start` | `connectors.manage` | Creates an expiring one-time state and returns Google's authorization URL. |
| `GET` | `/connectors/gmail/oauth/callback` | one-time OAuth state | Exchanges the provider code, verifies `gmail.readonly`, encrypts tokens and redirects to the frontend. |
| `POST` | `/connectors/sources/:id/enable` | `connectors.manage` | Confirmation-gated enable after verified authorization. |
| `POST` | `/connectors/sources/:id/sync` | `connectors.manage` | Reads up to 50 Gmail messages and imports unseen messages. |
| `POST` | `/connectors/sources/:id/disconnect` | `connectors.manage` | Confirmation-gated Google token revocation and local credential/cursor deletion. |
| `POST` | `/connectors/sources/:id/disable` | `connectors.manage` | Immediately prevents further synchronisation. |

`POST /connectors/sources/:id/sync` accepts optional `max_results` (1–50), `query`, `page_token` and `full_sync`. Without a query/page token, the first call establishes a profile `historyId`; later calls use `history.list` with `messageAdded`. Provider page continuation is stored internally. A Gmail 404 for an expired cursor automatically triggers a full fallback. The query, cursor, page token and message content are not written to the audit log.

## OAuth and credential security

Configure these values outside source control:

- `GMAIL_OAUTH_CLIENT_ID`
- `GMAIL_OAUTH_CLIENT_SECRET`
- `GMAIL_OAUTH_REDIRECT_URI`
- `CONNECTOR_ENCRYPTION_KEY` — exactly 32 random bytes encoded as base64
- `FRONTEND_URL`

The redirect URI must exactly match the Google Cloud OAuth web-client configuration. Real values must never be committed.

OAuth states are random, valid for ten minutes, stored only as SHA-256 hashes and consumed atomically before code exchange. Starting a new flow suspends the source and invalidates older states; disabling also removes pending states. The callback rechecks that the initiating user is still active and still has `connectors.manage`. Provider token bundles are encrypted with AES-256-GCM and authenticated against their company/source/provider context. APIs and audit snapshots expose only `authorizationConfigured: true|false`; authorization codes, access tokens, refresh tokens, client secrets, search text and message content are excluded.

Disconnect is separate from Disable. Disable immediately blocks Secretary access but retains the encrypted credential. Disconnect requires risk-3 confirmation, disables first, revokes the refresh token at Google, then deletes the encrypted credential and sync cursor. Google documents that revocation can remove every OAuth scope granted to that Google Cloud project for the account, so this impact is shown before confirmation. If provider revocation fails, the source stays disabled and the encrypted credential is retained for a safe retry.

`gmail.readonly` is a Google restricted scope. A public production deployment may require Google OAuth verification and, depending on how restricted data is stored or transmitted, an additional security assessment. Deployment approval is an operational prerequisite, not something the application can self-certify.

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

1. Register a Gmail source with logical scope `read:messages`.
2. Choose **Authorize Gmail** and complete Google's consent screen.
3. Review and explicitly enable the source.
4. Use **Initial sync**, then **Sync changes** for incremental imports.
5. Use **Disable** to stop access temporarily, or confirmed **Disconnect** to revoke and delete authorization.

Cross-company source IDs resolve as not found. Provider failures set `lastSyncStatus` and a non-secret `lastErrorCode`. Registration, OAuth start/completion, enable/disable and sync are audited without provider secrets or message content.

## Remaining connector work

- scheduled/background invocation and Gmail push notifications;
- encryption-key rotation workflow;
- attachment metadata and separately authorized attachment ingestion;
- provider sandbox verification for a production Google Cloud project;
- read-only adapters for Contacts, Calendar and Drive photos;
- separate confirmation-gated Gmail draft/send actions if later authorized.

Official implementation references: [Google OAuth 2.0 for web server applications and revocation](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail synchronization guide](https://developers.google.com/workspace/gmail/api/guides/sync), [Gmail history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list), [Gmail getProfile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile), [Gmail messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [Gmail messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get), and [Google restricted scopes](https://support.google.com/cloud/answer/13464325).
