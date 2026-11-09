-- WhatsApp Business delivery status: the latest state Meta reported for a
-- message the business number sent. Additive only: a new table, no existing
-- row changed.
CREATE TABLE "whatsapp_message_statuses" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "connector_source_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "recipient_id" TEXT,
    "error_code" TEXT,
    "error_title" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_message_statuses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_message_statuses_company_id_connector_source_id_me_key" ON "whatsapp_message_statuses"("company_id", "connector_source_id", "message_id");
CREATE INDEX "whatsapp_message_statuses_company_id_occurred_at_idx" ON "whatsapp_message_statuses"("company_id", "occurred_at");

ALTER TABLE "whatsapp_message_statuses" ADD CONSTRAINT "whatsapp_message_statuses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "whatsapp_message_statuses" ADD CONSTRAINT "whatsapp_message_statuses_connector_source_id_fkey" FOREIGN KEY ("connector_source_id") REFERENCES "connector_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
