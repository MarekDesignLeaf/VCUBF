CREATE TABLE "voice_device_states" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'offline',
  "mode" TEXT NOT NULL DEFAULT 'wake_word',
  "listening" BOOLEAN NOT NULL DEFAULT false,
  "last_transcript" TEXT,
  "last_response" TEXT,
  "last_heard_at" TIMESTAMP(3),
  "pending_control" TEXT,
  "heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "voice_device_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voice_device_states_user_id_key" ON "voice_device_states"("user_id");
CREATE INDEX "voice_device_states_company_id_heartbeat_at_idx" ON "voice_device_states"("company_id", "heartbeat_at");
ALTER TABLE "voice_device_states" ADD CONSTRAINT "voice_device_states_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "voice_device_states" ADD CONSTRAINT "voice_device_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
