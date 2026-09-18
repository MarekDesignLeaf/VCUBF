-- Voice alias learning counters.
-- Purely additive: existing learning rules keep working untouched, and rules
-- created by hand are marked fully confirmed so they stay active.
ALTER TABLE "learning_rules" ADD COLUMN IF NOT EXISTS "confirmations" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "learning_rules" ADD COLUMN IF NOT EXISTS "last_heard_at" TIMESTAMP(3);

UPDATE "learning_rules" SET "confirmations" = 3 WHERE "status" = 'active' AND "confirmations" = 0;
