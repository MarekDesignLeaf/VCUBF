CREATE TABLE "device_pairings" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "secret_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "user_id" TEXT,
  "company_id" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "approved_at" TIMESTAMP(3),
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_pairings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "device_pairings_code_key" ON "device_pairings"("code");
CREATE INDEX "device_pairings_expires_at_status_idx" ON "device_pairings"("expires_at", "status");
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
