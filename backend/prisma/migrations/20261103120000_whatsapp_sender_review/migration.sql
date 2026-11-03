-- WhatsApp sender review: a signed inbound sender is staged for a person to
-- classify, instead of becoming a CRM contact automatically. Additive only:
-- every existing staged row starts as "pending" (not yet reviewed), and no
-- CRM contact, client or communication is changed or removed.
ALTER TABLE "external_contacts" ADD COLUMN "review_status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "external_contacts" ADD COLUMN "review_classification" TEXT;
ALTER TABLE "external_contacts" ADD COLUMN "review_note" TEXT;
ALTER TABLE "external_contacts" ADD COLUMN "reviewed_by" TEXT;
ALTER TABLE "external_contacts" ADD COLUMN "reviewed_at" TIMESTAMP(3);

CREATE INDEX "external_contacts_company_id_connector_source_id_review_sta_idx" ON "external_contacts"("company_id", "connector_source_id", "review_status");
