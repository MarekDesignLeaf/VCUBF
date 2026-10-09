-- Emergency stop (masterplan layer H, project description §49). The moment the
-- administrator switched it on; null means normal operation. Additive and
-- nullable: existing companies stay in normal operation.
ALTER TABLE "companies" ADD COLUMN "safe_mode_since" TIMESTAMP(3);
