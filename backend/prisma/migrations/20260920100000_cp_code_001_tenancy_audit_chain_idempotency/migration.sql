-- CP-CODE-001 reconciliation hotfix (Engineering Bible v6.1: DAT-090, CON-012/OAS-001, CON-020/026)
-- 1. Tenant key on line-item and payment tables, backfilled from the owning aggregate.
ALTER TABLE "payments" ADD COLUMN "company_id" TEXT;
UPDATE "payments" p SET "company_id" = i."company_id" FROM "invoices" i WHERE p."invoice_id" = i."id";
ALTER TABLE "payments" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "payments_company_id_idx" ON "payments"("company_id");

ALTER TABLE "invoice_items" ADD COLUMN "company_id" TEXT;
UPDATE "invoice_items" x SET "company_id" = i."company_id" FROM "invoices" i WHERE x."invoice_id" = i."id";
ALTER TABLE "invoice_items" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "invoice_items_company_id_idx" ON "invoice_items"("company_id");

ALTER TABLE "quote_items" ADD COLUMN "company_id" TEXT;
UPDATE "quote_items" x SET "company_id" = q."company_id" FROM "quotes" q WHERE x."quote_id" = q."id";
ALTER TABLE "quote_items" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "quote_items_company_id_idx" ON "quote_items"("company_id");

ALTER TABLE "job_resource_requirements" ADD COLUMN "company_id" TEXT;
UPDATE "job_resource_requirements" x SET "company_id" = j."company_id" FROM "jobs" j WHERE x."job_id" = j."id";
ALTER TABLE "job_resource_requirements" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "job_resource_requirements" ADD CONSTRAINT "job_resource_requirements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "job_resource_requirements_company_id_idx" ON "job_resource_requirements"("company_id");

-- 2. Audit hash chain (per company). Existing rows keep NULL hashes; the chain starts at the first row written after this migration.
ALTER TABLE "audit_log" ADD COLUMN "sequence_no" BIGINT;
ALTER TABLE "audit_log" ADD COLUMN "prev_hash" TEXT;
ALTER TABLE "audit_log" ADD COLUMN "entry_hash" TEXT;
CREATE UNIQUE INDEX "audit_log_company_id_sequence_no_key" ON "audit_log"("company_id", "sequence_no");
-- Append-only guard: ordinary application role must not be able to rewrite history (CON-020/026).
CREATE OR REPLACE FUNCTION audit_log_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (CON-020)';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_no_update ON "audit_log";
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

-- 3. Idempotency keys for mutating requests (OAS-001).
CREATE TABLE "idempotency_keys" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "user_id" TEXT,
  "key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "response_status" INTEGER,
  "response_body" JSONB,
  "state" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "idempotency_keys_company_id_key_key" ON "idempotency_keys"("company_id", "key");
CREATE INDEX "idempotency_keys_company_id_created_at_idx" ON "idempotency_keys"("company_id", "created_at");
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
