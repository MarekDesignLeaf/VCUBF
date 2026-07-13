CREATE TABLE "voice_conversations" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMP(3),
  CONSTRAINT "voice_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "voice_conversation_messages" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "source_event_id" TEXT,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "voice_conversation_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "voice_conversations_company_id_user_id_started_at_idx" ON "voice_conversations"("company_id", "user_id", "started_at");
CREATE UNIQUE INDEX "voice_conversation_messages_conversation_id_sequence_key" ON "voice_conversation_messages"("conversation_id", "sequence");
CREATE UNIQUE INDEX "voice_conversation_messages_conversation_id_source_event_id_key" ON "voice_conversation_messages"("conversation_id", "source_event_id");
CREATE INDEX "voice_conversation_messages_company_id_occurred_at_idx" ON "voice_conversation_messages"("company_id", "occurred_at");
ALTER TABLE "voice_conversations" ADD CONSTRAINT "voice_conversations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "voice_conversations" ADD CONSTRAINT "voice_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "voice_conversation_messages" ADD CONSTRAINT "voice_conversation_messages_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "voice_conversation_messages" ADD CONSTRAINT "voice_conversation_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "voice_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
