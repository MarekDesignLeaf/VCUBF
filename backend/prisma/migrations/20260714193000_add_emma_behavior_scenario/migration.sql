ALTER TABLE "companies"
ADD COLUMN "emma_behavior_scenario" TEXT,
ADD COLUMN "emma_behavior_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "emma_behavior_updated_at" TIMESTAMP(3);
