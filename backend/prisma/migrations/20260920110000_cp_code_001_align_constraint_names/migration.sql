-- CP-CODE-001 follow-up: align pre-existing constraint/index names with the
-- names Prisma derives from schema.prisma, so `prisma migrate diff` reports
-- no drift between migration history and the datamodel (CI drift gate).
-- All statements are renames only (no data or structural change) and are
-- idempotent: environments created via `db push` already carry the target
-- names, environments created via `migrate deploy` carry the legacy names.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_google_photos_company_fkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_google_photos_company_id_fkey') THEN
    ALTER TABLE "external_google_photos" RENAME CONSTRAINT "external_google_photos_company_fkey" TO "external_google_photos_company_id_fkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_google_photos_portfolio_fkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_google_photos_portfolio_photo_id_fkey') THEN
    ALTER TABLE "external_google_photos" RENAME CONSTRAINT "external_google_photos_portfolio_fkey" TO "external_google_photos_portfolio_photo_id_fkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_google_photos_source_fkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_google_photos_connector_source_id_fkey') THEN
    ALTER TABLE "external_google_photos" RENAME CONSTRAINT "external_google_photos_source_fkey" TO "external_google_photos_connector_source_id_fkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'external_google_photos_company_removed_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'external_google_photos_company_id_is_removed_idx') THEN
    ALTER INDEX "external_google_photos_company_removed_idx" RENAME TO "external_google_photos_company_id_is_removed_idx";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'external_google_photos_source_media_key')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'external_google_photos_company_id_connector_source_id_exter_key') THEN
    ALTER INDEX "external_google_photos_source_media_key" RENAME TO "external_google_photos_company_id_connector_source_id_exter_key";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'voice_pending_actions_company_id_user_id_action_type_status_exp')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'voice_pending_actions_company_id_user_id_action_type_status_idx') THEN
    ALTER INDEX "voice_pending_actions_company_id_user_id_action_type_status_exp" RENAME TO "voice_pending_actions_company_id_user_id_action_type_status_idx";
  END IF;
END $$;
