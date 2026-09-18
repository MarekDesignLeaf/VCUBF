-- AlterTable
ALTER TABLE "users" ADD COLUMN "digest_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "digest_hour_utc" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "users" ADD COLUMN "digest_last_sent_at" TIMESTAMP(3);
