-- The prior combined key named a Drive-only connector as "Google Drive
-- Photos". Preserve its source ID, encrypted credential and staged image
-- references while making it unambiguously Google Drive.
UPDATE "connector_sources"
SET
  "connector_key" = 'google_drive',
  "display_name" = CASE
    WHEN "display_name" = 'Google Drive Photos' THEN 'Google Drive'
    ELSE "display_name"
  END
WHERE "connector_key" = 'google_drive_photos';

UPDATE "connector_credentials"
SET "provider" = 'google_drive'
WHERE "provider" = 'google_drive_photos';

-- Google Photos is a separate provider and stores only metadata for items
-- explicitly selected through Google Photos Picker. Temporary base URLs and
-- bytes are intentionally not represented in this schema.
CREATE TABLE "external_google_photos" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "connector_source_id" TEXT NOT NULL,
  "picker_session_id" TEXT NOT NULL,
  "external_media_item_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "media_type" TEXT NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "created_time" TIMESTAMP(3),
  "portfolio_photo_id" TEXT,
  "is_removed" BOOLEAN NOT NULL DEFAULT false,
  "staged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "external_google_photos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "external_google_photos_source_media_key"
  ON "external_google_photos"("company_id", "connector_source_id", "external_media_item_id");
CREATE INDEX "external_google_photos_company_removed_idx"
  ON "external_google_photos"("company_id", "is_removed");

ALTER TABLE "external_google_photos"
  ADD CONSTRAINT "external_google_photos_company_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "external_google_photos"
  ADD CONSTRAINT "external_google_photos_source_fkey"
  FOREIGN KEY ("connector_source_id") REFERENCES "connector_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_google_photos"
  ADD CONSTRAINT "external_google_photos_portfolio_fkey"
  FOREIGN KEY ("portfolio_photo_id") REFERENCES "portfolio_photos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
