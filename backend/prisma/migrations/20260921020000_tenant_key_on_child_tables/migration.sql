-- Multi tenant isolation (master documentation section 52) requires that one
-- company can never reach another company's data. Four child tables named
-- their tenant only through a parent row: a resource requirement through its
-- job, quote and invoice lines through their document, a payment through its
-- invoice. Any query that reached those tables without joining the parent had
-- no tenant key to filter on, so isolation depended on every call site
-- remembering the join. The tenant key now sits on the row itself. Existing
-- rows are backfilled from the parent that already carries it, so the value is
-- derived from authoritative data rather than assumed.

ALTER TABLE "job_resource_requirements" ADD COLUMN "company_id" TEXT;
UPDATE "job_resource_requirements" AS child
SET "company_id" = parent."company_id"
FROM "jobs" AS parent
WHERE parent."id" = child."job_id";
ALTER TABLE "job_resource_requirements" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "job_resource_requirements"
  ADD CONSTRAINT "job_resource_requirements_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "job_resource_requirements_company_id_idx" ON "job_resource_requirements"("company_id");

ALTER TABLE "quote_items" ADD COLUMN "company_id" TEXT;
UPDATE "quote_items" AS child
SET "company_id" = parent."company_id"
FROM "quotes" AS parent
WHERE parent."id" = child."quote_id";
ALTER TABLE "quote_items" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "quote_items"
  ADD CONSTRAINT "quote_items_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "quote_items_company_id_idx" ON "quote_items"("company_id");

ALTER TABLE "invoice_items" ADD COLUMN "company_id" TEXT;
UPDATE "invoice_items" AS child
SET "company_id" = parent."company_id"
FROM "invoices" AS parent
WHERE parent."id" = child."invoice_id";
ALTER TABLE "invoice_items" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "invoice_items"
  ADD CONSTRAINT "invoice_items_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "invoice_items_company_id_idx" ON "invoice_items"("company_id");

ALTER TABLE "payments" ADD COLUMN "company_id" TEXT;
UPDATE "payments" AS child
SET "company_id" = parent."company_id"
FROM "invoices" AS parent
WHERE parent."id" = child."invoice_id";
ALTER TABLE "payments" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "payments_company_id_idx" ON "payments"("company_id");
