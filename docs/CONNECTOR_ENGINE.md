# Connector Engine — Phase 3 Gmail read-only adapter

## Current status

The connector registry and tenant source lifecycle cover Gmail, Google Contacts, Google Calendar and Google Drive photo storage. Gmail is the first real adapter and is deliberately read-only. The other three definitions remain contract-only and fail closed.

The Gmail adapter can:

- authorize a Google account with OAuth 2.0 using only `gmail.readonly`;
- refresh an expired access token using an encrypted offline refresh token;
- list and read Gmail messages;
- idempotently import them into `CommunicationIntake` with source, message and thread provenance.

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
| `POST` | `/connectors/sources/:id/disable` | `connectors.manage` | Immediately prevents further synchronisation. |

`POST /connectors/sources/:id/sync` accepts optional `max_results` (1–50), `query` (Gmail search syntax) and `page_token`. It returns imported/skipped counts and the next page token. The query and message content are not written to the audit log.

## OAuth and credential security

Configure these values outside source control:

- `GMAIL_OAUTH_CLIENT_ID`
- `GMAIL_OAUTH_CLIENT_SECRET`
- `GMAIL_OAUTH_REDIRECT_URI`
- `CONNECTOR_ENCRYPTION_KEY` — exactly 32 random bytes encoded as base64
- `FRONTEND_URL`

The redirect URI must exactly match the Google Cloud OAuth web-client configuration. Real values must never be committed.

OAuth states are random, valid for ten minutes, stored only as SHA-256 hashes and consumed atomically before code exchange. Starting a new flow suspends the source and invalidates older states; disabling also removes pending states. The callback rechecks that the initiating user is still active and still has `connectors.manage`. Provider token bundles are encrypted with AES-256-GCM and authenticated against their company/source/provider context. APIs and audit snapshots expose only `authorizationConfigured: true|false`; authorization codes, access tokens, refresh tokens, client secrets, search text and message content are excluded.

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
4. Use **Sync now** to import messages.
5. Disable immediately when access is no longer needed.

Cross-company source IDs resolve as not found. Provider failures set `lastSyncStatus` and a non-secret `lastErrorCode`. Registration, OAuth start/completion, enable/disable and sync are audited without provider secrets or message content.

## Remaining connector work

- scheduled/background Gmail sync and incremental history cursors;
- an explicit disconnect/revoke action and credential deletion/rotation workflow;
- attachment metadata and separately authorized attachment ingestion;
- provider sandbox verification for a production Google Cloud project;
- read-only adapters for Contacts, Calendar and Drive photos;
- separate confirmation-gated Gmail draft/send actions if later authorized.

Official implementation references: [Google OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [Gmail messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get), and [Google restricted scopes](https://support.google.com/cloud/answer/13464325).
