CREATE TABLE "assistant_memories" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "owner_user_id" TEXT,
  "scope" TEXT NOT NULL DEFAULT 'personal',
  "content" TEXT NOT NULL,
  "normalized_content" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "archived_at" TIMESTAMP(3),
  CONSTRAINT "assistant_memories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_memories_scope_check" CHECK ("scope" IN ('personal', 'company')),
  CONSTRAINT "assistant_memories_status_check" CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "assistant_memories_owner_check" CHECK (
    ("scope" = 'personal' AND "owner_user_id" IS NOT NULL) OR
    ("scope" = 'company' AND "owner_user_id" IS NULL)
  )
);

CREATE INDEX "assistant_memories_company_id_scope_status_idx"
  ON "assistant_memories"("company_id", "scope", "status");
CREATE INDEX "assistant_memories_company_id_owner_user_id_status_idx"
  ON "assistant_memories"("company_id", "owner_user_id", "status");

ALTER TABLE "assistant_memories"
  ADD CONSTRAINT "assistant_memories_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assistant_memories"
  ADD CONSTRAINT "assistant_memories_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
