ALTER TABLE "companies"
ADD COLUMN "emma_disabled_capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
