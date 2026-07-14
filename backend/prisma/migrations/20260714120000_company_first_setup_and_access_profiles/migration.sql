-- One installed Secretary workspace has one owning company. Existing data is
-- retained and made explicit; new installations create this company through
-- the public setup flow together with the first administrator.
ALTER TABLE "companies"
  ADD COLUMN "primary_admin_user_id" TEXT,
  ADD COLUMN "setup_completed_at" TIMESTAMP(3);

-- Normalise legacy labels so profiles are consistent in the UI and API.
UPDATE "users" SET "role" = 'administrator' WHERE "role" = 'admin';
UPDATE "users" SET "role" = 'field_worker' WHERE "role" = 'worker';

-- Existing administrators retain every former right and gain company-profile
-- management. No existing non-administrator account is broadened.
UPDATE "users"
SET "permissions" = ARRAY(
  SELECT DISTINCT permission
  FROM unnest("permissions" || ARRAY['company.manage']) AS permission
)
WHERE "role" = 'administrator';

UPDATE "companies" AS company
SET
  "primary_admin_user_id" = (
    SELECT administrator."id"
    FROM "users" AS administrator
    WHERE administrator."company_id" = company."id"
      AND administrator."is_active" = true
      AND administrator."role" = 'administrator'
    ORDER BY administrator."created_at" ASC
    LIMIT 1
  ),
  "setup_completed_at" = COALESCE(company."setup_completed_at", company."created_at")
WHERE company."primary_admin_user_id" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "users" AS administrator
    WHERE administrator."company_id" = company."id"
      AND administrator."is_active" = true
      AND administrator."role" = 'administrator'
  );

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_primary_admin_user_id_fkey"
  FOREIGN KEY ("primary_admin_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "companies_primary_admin_user_id_key" ON "companies"("primary_admin_user_id");

CREATE TABLE "system_setup" (
  "id" TEXT NOT NULL DEFAULT 'primary',
  "company_id" TEXT NOT NULL,
  "initialized_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "system_setup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "system_setup_company_id_key" ON "system_setup"("company_id");

ALTER TABLE "system_setup"
  ADD CONSTRAINT "system_setup_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Mark the existing workspace as already configured, so an upgrade never
-- exposes it to a second unauthenticated bootstrap.
INSERT INTO "system_setup" ("id", "company_id", "initialized_at")
SELECT 'primary', "id", COALESCE("setup_completed_at", "created_at")
FROM "companies"
WHERE "primary_admin_user_id" IS NOT NULL
ORDER BY "created_at" ASC
LIMIT 1
ON CONFLICT ("id") DO NOTHING;
