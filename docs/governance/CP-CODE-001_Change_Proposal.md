# CP-CODE-001 — Reconcile the running codebase with Engineering Bible v6.1

Status: BUILT / TESTED (pure tests locally; DB suite in CI) / INDEPENDENTLY VERIFIED (2 passes, CON-027) → **APPROVAL_REQUIRED** (Owner, GOV-041)
Branch: `reconcile/CP-CODE-001` (3 commits on top of master `6816619`) · Change class: **DC-R2-equivalent for code** — additive, migration backfills only, no behaviour removed, one behaviour tightened (JWT secret fail-closed in Railway environments)
Governing process: SEC-00 §5; SEC-06 lifecycle; audit report `VCUBF_Produkcni_Audit_2026-09-20.md` §7 step 3–5

## 1. Decisions taken by default (Owner may override — each is reversible)
| # | Decision | Default applied | Alternative |
|---|---|---|---|
| D1 | Product identity in code ("Emma") | **Not renamed in this CP.** Recorded as NON-CONFORMANT in `docs/BIBLE_TRACE.md`; wake word treated as a *temporary development invocation keyword* (BOOT-010) pending ADR-026 | rename now (touches 51 files, 2 migrations, Porcupine model) |
| D2 | `docs/PRODUCTION_ARCHITECTURE.md` (17 Jul) vs Bible | Marked **SUPERSEDED**; its stack choices go to ADR-001/003/004/008 as PROPOSED | keep both as parallel authorities (violates GOV-001) |
| D3 | Source of truth for Action Contracts | Registry copied into repo; code contracts **mapped** to capabilities with a CI gate; 19 capabilities the code needs but the registry lacks filed as proposed additions for CP-v6.2 | generate `actionContracts.ts` from registry (bigger refactor; deferred) |

## 2. What changed
- **Tenancy (DAT-090):** `company_id` on `payments`, `invoice_items`, `quote_items`, `job_resource_requirements` — backfilled from owning aggregate, NOT NULL, FK, index. Every model except `Company` now carries the tenant key. RLS itself remains ADR-002.
- **Audit integrity (CON-020/026):** per-company SHA-256 hash chain (`sequence_no`, `prev_hash`, `entry_hash`), serialised with `pg_advisory_xact_lock`; `audit_log` append-only via DB trigger; `scripts/verify-audit-chain.ts`.
- **Idempotency (CON-012, OAS-001):** `Idempotency-Key` on every authenticated mutating request, tenant-scoped, replay/422/409 semantics, 5xx not memoised. Soft mode until the frontend sends keys (`IDEMPOTENCY_REQUIRED=1` enforces).
- **Fail-closed secrets:** `JWT_SECRET` (≥32 chars) mandatory in production/Railway.
- **Risk classes (PERM-011):** 16 contracts raised to the registry's base risk (invoice status 2→4, quote status 2→3, connector OAuth/disconnect →3, website content decision 2→4); `invoiceService` no longer hard-codes risk literals.
- **Traceability (GOV-002/003):** `docs/BIBLE_TRACE.md`; `docs/bible/{capability_registry,capability_registry_proposed_additions,action_capability_map}.csv`; CI gate `scripts/check-action-capability-map.mjs`.
- **CI honesty:** embedded-PG tests now run the real migrations (`migrate deploy`) and fail on schema/migration drift.

## 3. Conflict analysis (SEC-01/SEC-04)
No article weakened. Tighter: audit becomes tamper-evident and append-only; secrets fail closed; risk metadata stricter. Behavioural risk: the append-only trigger also blocks `ON DELETE SET NULL` from `users` → deleting a user with audit rows now fails (no such code path exists today; documented).

## 4. Evidence
- Pure tests: `tests/auditChain.test.ts` (5), `tests/idempotencyFingerprint.test.ts` (1) — pass in authoring sandbox.
- DB-backed tests added: `tests/idempotency.test.ts` (5), `tests/auditChainDb.test.ts` (3) — run in CI (`npm run test:embedded`).
- `node scripts/check-action-capability-map.mjs` → PASS (138 actions, 138 mapped).
- Verification pass 1: REJECT (C1 CI-breaking test, C2 BigInt 500 on /audit/log, M1 chain race, M2 key deletion on disconnect, M3 trigger vs tests + migrations never executed in CI, M4 literal risk, M5 broad catch) — all fixed in `fd76dc5`.
- Verification pass 2: APPROVE-WITH-FIXES (M3 shadow-DB misuse in migrate diff; Docker path still db push; flaky replay test; test title) — all fixed in `55105c0`. Pass-2 closing edits are builder-applied and not re-verified by a third pass (disclosed).
- **Not verified here:** `tsc` and DB tests could not run in the authoring sandbox (Prisma engine download blocked). The first authoritative run is GitHub CI on push.

## 5. How to apply
```
git fetch <bundle or remote> reconcile/CP-CODE-001
git checkout reconcile/CP-CODE-001 && cd backend && npm ci && npm run prisma:generate && npm run build && npm run test:embedded
```
Then open a PR to master; CI must be green before `prisma migrate deploy` runs in production via the `start` script. Production rollout: take a DB backup first (SYS-NFR-005 — none is evidenced today), deploy backend, run `npx tsx scripts/verify-audit-chain.ts`.

## 6. Rollback
Revert the three commits. The migration is backward-compatible for reads (new columns nullable-by-backfill, new table); dropping it requires a down migration: drop trigger/function, drop `idempotency_keys`, drop the four `company_id` columns and the three `audit_log` columns.

## 7. Out of scope (next CPs)
Approval entity + payload-hash binding; state-machine engine (SEC-21); `If-Match`/entity_version; key retention job; express-async-errors; frontend sending `Idempotency-Key`; RLS (ADR-002); persona rename (ADR-026); CP-v6.2 for the 19 proposed capabilities.
