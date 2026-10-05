-- Two Gmail accounts can be connected side by side. Each source records which
-- Google account it was authorised as (read from the Gmail profile at the end
-- of OAuth, never typed in), and one per company is the default sender used
-- when nobody names an account.
ALTER TABLE "connector_sources" ADD COLUMN "account_email" TEXT;
ALTER TABLE "connector_sources" ADD COLUMN "is_default_sender" BOOLEAN NOT NULL DEFAULT false;

-- Keep today's behaviour for companies that already send from one Gmail
-- source: their oldest active Gmail source becomes the default sender.
UPDATE "connector_sources" AS source
SET "is_default_sender" = true
FROM (
  SELECT DISTINCT ON ("company_id") "id"
  FROM "connector_sources"
  WHERE "connector_key" = 'gmail' AND "is_active" = true
  ORDER BY "company_id", "created_at" ASC
) AS oldest
WHERE source."id" = oldest."id";
