-- The secretary's name becomes a setting rather than a hardcoded string.
-- Separate from the hotword: she can be named Petra and answer to
-- "hej sekretarko".
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "assistant_name" TEXT NOT NULL DEFAULT 'Emma';
