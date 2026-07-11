# Connector Engine — Phase 3 Foundation

## Current status

This release implements the Connector Engine contract registry and tenant data-source lifecycle. It does not contain OAuth clients or provider API adapters and therefore does not read or write any external account.

`adapterAvailable: false` is deliberate. A registered source remains disabled and `POST /connectors/sources/:id/enable` returns `CONNECTOR_ADAPTER_UNAVAILABLE` until a provider adapter is implemented and verified.

## Declared connector contracts

The registry is defined in `backend/src/connectors/registry.ts` and currently covers:

- Gmail email;
- Google Contacts;
- Google Calendar;
- Google Drive photo storage.

Every definition declares the master-document fields:

- service name and type;
- readable and writable data;
- required Secretary permissions;
- returned data types;
- supported actions;
- possible errors;
- audit support;
- rollback support;
- proposal/direct-action mode;
- actual adapter availability.

Capability declarations describe the boundary a future adapter must enforce. They are not evidence that provider access works.

## API

| Method | Path | Permission | Behaviour |
|---|---|---|---|
| `GET` | `/connectors/definitions` | `connectors.read` | Lists static connector contracts. |
| `GET` | `/connectors/sources` | `connectors.read` | Lists company-scoped source registrations. |
| `GET` | `/connectors/sources/:id` | `connectors.read` | Gets one company-scoped source. |
| `POST` | `/connectors/sources` | `connectors.manage` | Registers a disabled source. |
| `PUT` | `/connectors/sources/:id` | `connectors.manage` | Updates disabled source metadata/scopes/reference. |
| `POST` | `/connectors/sources/:id/disable` | `connectors.manage` | Immediately disables a source. |
| `POST` | `/connectors/sources/:id/enable` | `connectors.manage` | Confirmation-gated enable boundary; currently fails closed because adapters are unavailable. |

## Secret handling

The database never accepts a token or password field. `credential_reference` is an opaque pointer and must start with one of:

- `env:`
- `vault:`
- `secret-manager:`

The reference is not returned by the API. Responses expose only `credentialReferenceConfigured: true|false`. Audit input and before/after snapshots also redact the reference.

This protects against accidental API exposure, but it is not a production secret store. The deployment owner must configure the referenced secret outside Secretary with encryption, access policy, rotation and audit appropriate to the provider.

## Source lifecycle and safety

1. Register a source. It starts as `setup_required`, disabled.
2. Configure only logical scopes declared by its connector contract.
3. Keep it disabled while changing configuration.
4. Implement and verify the real adapter.
5. Enable only through the risk-3 confirmation boundary.
6. Disable immediately when consent, credentials or business need ends.

Unknown scopes are rejected. Cross-company IDs resolve as not found. Registration, update, disable and failed enable attempts are audited. Disabling is idempotent.

## Adapter completion checklist

A connector definition must not set `adapterAvailable: true` until all of the following exist:

- provider-specific authorisation flow and callback validation;
- encrypted secret retrieval through the opaque reference;
- provider scope verification against configured logical scopes;
- tenant and user permission checks on every operation;
- provenance on every returned record, including provider/source ID;
- pagination, rate-limit and retry handling without duplicate writes;
- deterministic mapping into Secretary intake records;
- confirmation for external sends, writes, publication or calendar changes;
- idempotency keys for writes where the provider supports them;
- audit evidence for request, source records, result and provider error code;
- revoke/disable handling;
- unit, integration and provider-sandbox tests;
- explicit rollback behaviour, or `supportsRollback: false` when reversal cannot be guaranteed.

The first recommended real adapter is read-only Gmail intake with the minimum provider scope. Drafting and sending should remain separate actions, and sending must stay confirmation-gated.
