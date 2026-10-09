-- Agent runs (masterplan F1, layer G). A shadow run records what the agent
-- would have proposed for a request the deterministic parser handled, and how
-- that compares with what actually happened. It never stores message text
-- (decision D4): the request is a keyed fingerprint, proposed tool arguments
-- are fingerprints, and the parser outcome is intent and action names only.
CREATE TABLE "agent_runs" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'shadow',
  "channel" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "input_fingerprint" TEXT NOT NULL,
  "catalogue_version" TEXT NOT NULL,
  "catalogue_fingerprint" TEXT NOT NULL,
  "toolset_fingerprint" TEXT NOT NULL,
  "build" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "error_code" TEXT,
  "steps" INTEGER NOT NULL DEFAULT 0,
  "proposed_tools" JSONB NOT NULL,
  "parser_intent" TEXT NOT NULL,
  "parser_action" TEXT,
  "agreement" TEXT NOT NULL,
  "tokens_in" INTEGER,
  "tokens_out" INTEGER,
  "duration_ms" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_runs_company_id_created_at_idx" ON "agent_runs"("company_id", "created_at");
CREATE INDEX "agent_runs_company_id_mode_agreement_idx" ON "agent_runs"("company_id", "mode", "agreement");
CREATE INDEX "agent_runs_cohort_idx" ON "agent_runs"("company_id", "mode", "model", "toolset_fingerprint", "build");

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
