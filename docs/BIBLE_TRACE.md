# BIBLE_TRACE — code ↔ VCUBF Secretary Engineering Bible v6.1

Purpose (GOV-002/GOV-003, SEC-12): make every module in this repository traceable to the specification that governs it, the delivery wave it belongs to (SEC-07 §3), and its honest status. Status vocabulary is SEC-00 §6: SPECIFIED · IMPLEMENTED (code exists, evidence incomplete) · VERIFIED (tests + evidence) · PRODUCTION. Nothing here is VERIFIED yet: CI proves build and unit/DB tests, not the SEC-05 release gates.

Reconciliation date: 20 September 2026 (CP-CODE-001). Bible package: v6.1 (CP-v6.1, APPROVAL_REQUIRED).

## Module map

| Code module (backend/src) | Governing spec | Wave | Status | Gap to spec |
|---|---|---|---|---|
| middleware/auth, modules/auth, devicePairing | SEC-04, SEC-11 §7, SEC-31 | W1 | IMPLEMENTED | JWT only; no step-up/identity assurance levels; Voice ID absent (SEC-02 §4) |
| middleware/permissions, User.permissions[] | SEC-11, SEC-31 | W1 | IMPLEMENTED | flat permission strings (`crm.manage`) vs registry capabilities — bridged by `docs/bible/action_capability_map.csv`; no delegation, no data-class scopes |
| lib/actionContracts, lib/audit, modules/audit | SEC-01 CON-010/011, SEC-04, SEC-25 | W1 | IMPLEMENTED | contracts are static metadata (no persisted contract, payload_hash, Approval entity, OUTCOME_UNKNOWN); audit hash-chain (advisory-lock serialised) + append-only trigger added in CP-CODE-001; `GET /audit/log` serialises sequence_no as string |
| middleware/idempotency (new) | CON-012, SEC-29 OAS-001, API-030 | W1 | IMPLEMENTED (CP-CODE-001) | soft mode by default; `IDEMPOTENCY_REQUIRED=1` enforces; frontend does not yet send keys; 5xx not memoised (trade-off: a 5xx emitted after a committed mutation releases the key, so a retry may duplicate — acceptable until Approval/OUTCOME_UNKNOWN model lands); Express 4 async handler rejections bypass the error handler (pre-existing) and leave keys IN_PROGRESS; no If-Match/entity_version yet; no key retention job |
| modules/company, SystemSetup | SEC-40 | W1 | IMPLEMENTED | bootstrap sequence partial; no BOOT-001 activation evidence record |
| modules/crm (clients, contacts, leads, employees), services/client*/contact*/lead* | SEC-02 §5, SEC-08, SEC-28 | W1/W3 | IMPLEMENTED | dedupe basic; no provenance/uncertainty states on extracted records |
| modules/crm/jobs, services/jobService, jobResourceService | SEC-02 §9–10, SEC-21 (Job) | W1 | IMPLEMENTED | job statuses are a flat list; SEC-21 transition table/guards not enforced; completion evidence gate absent |
| modules/calendar, services/calendarService, capacityService | SEC-02 §9, SEC-39 BR-020..024 | W5 | IMPLEMENTED (partial) | capacity is calendar-vacancy based; no skills/materials/travel feasibility (BR-022), no route/ETA |
| modules/quotes, services/quoteService, quotePdfService | SEC-02 §8, SEC-21 (Quote), SEC-39 §2 | W4 | IMPLEMENTED (partial) | no accepted_payload_hash, no INTERNAL_REVIEW/approval; totals not reconciled to SEC-39 rules (minor units) |
| modules/invoices, services/invoiceService, invoicePdfService, Payment | SEC-02 §16, SEC-21 (Invoice/Payment), SEC-39 §3 | W4 | IMPLEMENTED (partial) | Decimal money (Bible: minor units); payments have no provider lifecycle/reconciliation; tenancy key added in CP-CODE-001 |
| modules/communications, services/communicationService, communication intake | SEC-02 §5, SEC-26 | W3 | IMPLEMENTED | provenance kept; no communication risk policy for sends beyond confirmation flag |
| connectors/*, modules/connectors, services/*ConnectorService, connectorBackgroundSync | SEC-26, SEC-22 | W3 | IMPLEMENTED | Gmail, Google Calendar/Contacts/Drive/Photos, WhatsApp; no declared capability registry per connector (SEC-26 schema), no reconciliation semantics |
| modules/command, lib/commandParser, lib/commandExecutor, services/voiceAssistantService | SEC-02 §2/§4, SEC-03, SEC-10, SEC-33 | W2 | IMPLEMENTED | **strong**: LLM emits canonical command → deterministic parser → contracts (CON-002/CON-010 honoured); but per-user wake word (CON-073 requires tenant-level), persona "Emma" (CON-071) |
| services/emma* (behaviour, policy, executable actions, surface catalogue) | SEC-41, SEC-17, SEC-33 | W2 | IMPLEMENTED — **NON-CONFORMANT NAME** | retains fixed persona; decision pending (see CP-CODE-001 §Decisions) |
| services/assistantMemoryService, memoryModelService, learningService, playbookService | SEC-02 §19, SEC-03 §9 | W1/W10 | IMPLEMENTED (partial) | memory records lack confidence/owner/permission fields; playbook approval gate absent |
| modules/catalogue, industries, services/industryService, serviceCatalogueService | SEC-02 §7 (industry adaptability), SEC-28 | W1 | IMPLEMENTED | — |
| modules/recruitment, services/recruitmentService | SEC-02 §12 | W7 | IMPLEMENTED (partial) | no publish gate (recruitment.publish R4) — drafts only, which is acceptable |
| modules/website-audits, website-content-proposals, portfolio, services/websiteAudit*, portfolioService | SEC-02 §15 | W9 | IMPLEMENTED (partial) | decide step now R4 (CP-CODE-001); provenance for public claims not enforced (CON-030/031) |
| modules/metrics, notifications, data-quality, business-context, documents, tasks | SEC-02 §19–20, SEC-15 | W1 | IMPLEMENTED | notifications lack "why it matters / risk if ignored" structure (SEC-02 §20) |
| frontend/ (React PWA + Capacitor) | SEC-17, SEC-02 §21 | W2/W6 | IMPLEMENTED | no business logic (good); **0 tests**; no adaptive UI registry; Field Worker Mode absent |
| windows-companion/ | SEC-02 §4, SEC-41 | W2 | IMPLEMENTED (single-machine) | Porcupine model trained on "Emma"; NPU Whisper; not reproducible on other machines |

## Not present in code (SPECIFIED only)
Approval entity and payload-hash binding (SEC-04/SEC-25) · state-machine engine with guards (SEC-21) · Voice ID / step-up / Team Session (SEC-02 §4) · customer portal, booking, Front Desk phone agent (SEC-02 §6–7) · Field Worker Mobile Mode, offline sync (SEC-02 §10) · timesheets, payroll, earnings engine (SEC-02 §11) · inventory, assets, fleet (SEC-02 §13) · route/ETA (SEC-02 §9) · predictions, Digital Twin, scenarios (SEC-18) · agent orchestration, Verification Agent, model routing (SEC-03/SEC-10) · self-evolution (SEC-06) · SEC-42 cost/quota/degradation · safe mode (CON-041) · tenant RLS (DAT-090; schema-level `company_id` now complete, RLS pending ADR-002).

## Deployment reality (Railway project VCUBF, 20 Sep 2026)
backend deployed from `84c64f2` (15 Jul), frontend from 17 Jul, master at `6816619` (18 Jul); production traffic ≈ health-checks only; no staging environment; DB backups not evidenced (SYS-NFR-005).

## Test evidence
Pure: `tests/auditChain.test.ts`, `tests/idempotencyFingerprint.test.ts` (run in authoring sandbox). DB-backed (CI): `tests/idempotency.test.ts`, `tests/auditChainDb.test.ts`; CI now applies real migrations (`prisma migrate deploy`) and fails on schema/migration drift.

## Bridge artefacts in this repo
- `docs/bible/capability_registry.csv` — copy of the canonical registry (v6.1, 49 capabilities)
- `docs/bible/capability_registry_proposed_additions.csv` — 19 capabilities the code needs that the registry lacks; to be proposed to the Bible as CP-v6.2
- `docs/bible/action_capability_map.csv` — every `actionName` in code → capability, risk comparison, accepted deviations
- `backend/scripts/check-action-capability-map.mjs` — CI gate: unmapped action or code risk looser than registry fails the build
