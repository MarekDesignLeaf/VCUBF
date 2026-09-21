-- Write idempotency (master documentation section 43). A network retry must not
-- create two invoices, two payments, two purchase orders, two customer messages
-- or two bookings. One row per Idempotency-Key per company records what the key
-- was first used for and the answer the first attempt gave, so a repeat is
-- answered rather than acted on.
--
-- The key is unique within a company, not globally: two tenants may choose the
-- same key without meeting. The row is short-lived — expires_at is what frees a
-- key again instead of blocking it for ever — and is indexed so a retention
-- sweep does not scan the table.
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_records_company_id_key_key" ON "idempotency_records"("company_id", "key");
CREATE INDEX "idempotency_records_company_id_idx" ON "idempotency_records"("company_id");
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
