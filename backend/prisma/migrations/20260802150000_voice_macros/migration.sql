-- Commands the user taught by performing them.
--
-- The fingerprint covers the sequence of steps and not the text typed into them,
-- so recording the same flow twice with different values is recognised as one
-- command with two names rather than two near-identical macros.
CREATE TABLE "voice_macros" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "step_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "voice_macros_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voice_macros_company_id_fingerprint_key" ON "voice_macros"("company_id", "fingerprint");
CREATE INDEX "voice_macros_company_id_status_idx" ON "voice_macros"("company_id", "status");

-- A phrase belongs to exactly one command, so saying it can never be ambiguous.
CREATE TABLE "voice_macro_names" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "macro_id" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "spoken" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "voice_macro_names_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voice_macro_names_company_id_term_key" ON "voice_macro_names"("company_id", "term");
CREATE INDEX "voice_macro_names_macro_id_idx" ON "voice_macro_names"("macro_id");

ALTER TABLE "voice_macros" ADD CONSTRAINT "voice_macros_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "voice_macro_names" ADD CONSTRAINT "voice_macro_names_macro_id_fkey"
    FOREIGN KEY ("macro_id") REFERENCES "voice_macros"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "voice_macro_names" ADD CONSTRAINT "voice_macro_names_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
