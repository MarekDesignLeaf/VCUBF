-- CreateTable
CREATE TABLE "client_merge_records" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "primary_client_id" TEXT NOT NULL,
    "duplicate_client_id" TEXT NOT NULL,
    "relinked_record_ids" JSONB NOT NULL,
    "duplicate_was_active" BOOLEAN NOT NULL,
    "merge_status" TEXT NOT NULL DEFAULT 'merged',
    "merged_by" TEXT,
    "merged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unmerged_by" TEXT,
    "unmerged_at" TIMESTAMP(3),
    "unmerge_summary" JSONB,

    CONSTRAINT "client_merge_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_merge_records_company_id_idx" ON "client_merge_records"("company_id");

-- CreateIndex
CREATE INDEX "client_merge_records_company_id_primary_client_id_idx" ON "client_merge_records"("company_id", "primary_client_id");

-- CreateIndex
CREATE INDEX "client_merge_records_company_id_duplicate_client_id_idx" ON "client_merge_records"("company_id", "duplicate_client_id");

-- AddForeignKey
ALTER TABLE "client_merge_records" ADD CONSTRAINT "client_merge_records_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
