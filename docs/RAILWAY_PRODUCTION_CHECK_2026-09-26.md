# Railway production check — 2026-09-26

This file records the Railway production state checked on 2026-09-26.

## Project

Railway project:

`VCUBF`

Project ID:

`ebf291ce-f3ff-48ee-8771-d78c36590940`

Environment:

`production`

Environment ID:

`bd2bea39-6d8a-4f1c-9ce5-ab4465ae3e19`

## Services

| Service | Service ID | Latest checked status | Notes |
| --- | --- | --- | --- |
| backend | `58c09401-35da-4f2e-b722-33e7b74b7faa` | SUCCESS | Connected to `MarekDesignLeaf/VCUBF`, branch `master`, root `/backend` |
| frontend | `e8a7b807-709b-44cb-9788-b116b8fd520c` | SUCCESS | Connected to `MarekDesignLeaf/VCUBF`, branch `master`, root `/frontend` |
| Postgres | `9a4093cf-9c2d-4e89-be72-6b68857280a7` | SUCCESS | Persistent Railway Postgres volume mounted at `/var/lib/postgresql/data` |

## Domains

Backend Railway domain:

`https://backend-production-7952.up.railway.app`

Frontend Railway domain:

`https://frontend-production-ee13.up.railway.app`

Frontend production environment points to:

`VITE_API_URL=https://backend-production-7952.up.railway.app`

Backend healthcheck path configured in Railway:

`/health`

## Build and deploy configuration

### Backend

Source:

- repo: `MarekDesignLeaf/VCUBF`
- branch: `master`
- root directory: `/backend`
- builder: `RAILPACK`
- build environment: `V3`
- runtime: `V2`
- region: `europe-west4-drams3a`
- replicas: `1`
- healthcheck path: `/health`
- watch pattern: `backend/**`

Important backend variables are configured by name, including:

- `DATABASE_URL`
- `JWT_SECRET`
- `CONNECTOR_ENCRYPTION_KEY`
- `OPENAI_API_KEY`
- Google OAuth variables
- Gmail OAuth variables
- WhatsApp variables
- `RAILPACK_NODE_VERSION`

Values were not copied into this document.

### Frontend

Source:

- repo: `MarekDesignLeaf/VCUBF`
- branch: `master`
- root directory: `/frontend`
- builder: `RAILPACK`
- build environment: `V3`
- runtime: `V2`
- region: `europe-west4-drams3a`
- replicas: `1`
- watch pattern: `frontend/**`

Frontend variables by name:

- `VITE_API_URL`
- `RAILPACK_NODE_VERSION`
- `RAILPACK_SPA_OUTPUT_DIR`
- `RAILPACK_STATIC_FILE_ROOT`

## Backend deployment evidence

Latest checked backend deployment:

- deployment ID: `59b9b799-56da-41d7-a54f-df63dfc16ba4`
- status: SUCCESS
- commit: `aaa9fe9da4a55992f52eff45da0a2923414bf835`
- created: 2026-09-22 17:03 UTC
- can rollback: true
- can redeploy: true

Runtime logs around the checked deployment reported:

- Prisma schema loaded from `prisma/schema.prisma`.
- PostgreSQL datasource points to Railway internal Postgres.
- 32 migrations were found.
- No pending migrations to apply.
- Backend started with `VCUBF Secretary backend listening on :8080`.
- Connector background sync is enabled every 5 minutes.

Note:

Older logs also show `SIGTERM` messages when old containers were stopped during replacement. These are expected around deployment replacement and are not by themselves proof of an active failure.

## External URL access check

Attempted URL checks from the assistant web tool:

- `https://backend-production-7952.up.railway.app`
- `https://backend-production-7952.up.railway.app/health`

Result:

The assistant web tool could not access these URLs.

Interpretation:

This is not enough to conclude that the backend is down. Railway reports successful deployment and configured healthcheck. The URL must be checked from a browser, curl, Postman or Railway logs by someone with network access.

Required manual command:

```bash
curl -i https://backend-production-7952.up.railway.app/health
```

Expected result:

- HTTP 200 or documented healthy response.
- Response should come from production backend, not a local machine.

## Resolved by this check

The following previous uncertainty is resolved:

`Railway project/deployment not verified.`

The project exists, services exist, source configuration is connected to the active GitHub repository and deployments report success.

## Still not resolved

The following remain open:

- Browser load of production frontend.
- HTTP health response from outside Railway.
- Real login.
- Real create client/lead/job smoke test.
- Real audit log verification.
- Live connector checks.
- Live voice hardware checks.

## Current deployment wording

Correct wording:

`VCUF is deployed on Railway with backend, frontend and Postgres services reporting successful deployment.`

Incorrect wording until live smoke tests pass:

`VCUF is fully production ready.`
