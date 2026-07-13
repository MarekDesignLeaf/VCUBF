CREATE TABLE "voice_pending_actions" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "action_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "source_id" TEXT,
  "payload" JSONB,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "resolved_at" TIMESTAMP(3),
  CONSTRAINT "voice_pending_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "voice_pending_actions_status_check"
    CHECK ("status" IN ('pending', 'sending', 'sent', 'cancelled', 'expired', 'failed'))
);

CREATE INDEX "voice_pending_actions_company_id_user_id_action_type_status_expires_at_idx"
  ON "voice_pending_actions"("company_id", "user_id", "action_type", "status", "expires_at");

ALTER TABLE "voice_pending_actions"
  ADD CONSTRAINT "voice_pending_actions_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "voice_pending_actions"
  ADD CONSTRAINT "voice_pending_actions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "voice_pending_actions"
  ADD CONSTRAINT "voice_pending_actions_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "connector_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
