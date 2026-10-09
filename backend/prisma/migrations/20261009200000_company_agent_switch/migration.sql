-- The per-company agent switch (masterplan F2, §39). The moment an
-- administrator switched the agent on; null means off. Additive and nullable:
-- every existing company stays off.
ALTER TABLE "companies" ADD COLUMN "agent_enabled_at" TIMESTAMP(3);
