ALTER TABLE "job_resource_requirements" ALTER COLUMN "estimated_cost" TYPE NUMERIC(14,2) USING ROUND("estimated_cost"::numeric, 2), ALTER COLUMN "actual_cost" TYPE NUMERIC(14,2) USING ROUND("actual_cost"::numeric, 2);
ALTER TABLE "service_catalogue_items" ALTER COLUMN "base_price_min" TYPE NUMERIC(14,2) USING ROUND("base_price_min"::numeric, 2), ALTER COLUMN "base_price_max" TYPE NUMERIC(14,2) USING ROUND("base_price_max"::numeric, 2), ALTER COLUMN "reference_rate_gbp" TYPE NUMERIC(14,2) USING ROUND("reference_rate_gbp"::numeric, 2);
ALTER TABLE "quote_items" ALTER COLUMN "unit_price" TYPE NUMERIC(14,2) USING ROUND("unit_price"::numeric, 2), ALTER COLUMN "unit_cost" TYPE NUMERIC(14,2) USING ROUND("unit_cost"::numeric, 2);
ALTER TABLE "invoice_items" ALTER COLUMN "unit_price" TYPE NUMERIC(14,2) USING ROUND("unit_price"::numeric, 2);
ALTER TABLE "payments" ALTER COLUMN "amount" TYPE NUMERIC(14,2) USING ROUND("amount"::numeric, 2);
