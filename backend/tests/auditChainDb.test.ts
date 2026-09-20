import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { prisma } from "../src/db.js";
import { recordAudit } from "../src/lib/audit.js";
import { GENESIS_HASH, verifyChain } from "../src/lib/auditChain.js";
import { resetDb, seedCompanyAndAdmin, TEST_COMPANY_ID } from "./setup.js";

describe("Audit hash chain (CON-020 / CON-026)", () => {
  before(async () => { await resetDb(); await seedCompanyAndAdmin(); });
  after(async () => { await resetDb(); await prisma.$disconnect(); });

  it("chains entries per company and verifies after a JSONB round-trip", async () => {
    for (let i = 0; i < 5; i += 1) {
      await recordAudit({ companyId: TEST_COMPANY_ID, actionName: `chain_${i}`, inputPayload: { i, when: new Date(), amount: 12.5 }, dataAfter: { nested: { z: 1, a: [1, "x"] } }, riskLevel: 1, result: "success" });
    }
    const rows = await prisma.auditLog.findMany({ where: { companyId: TEST_COMPANY_ID, sequenceNo: { not: null } }, orderBy: { sequenceNo: "asc" } });
    assert.equal(rows.length, 5);
    assert.equal(rows[0].prevHash, GENESIS_HASH);
    const r = verifyChain(rows.map((x) => ({ ...x, sequenceNo: x.sequenceNo! })));
    assert.deepEqual(r, { ok: true, checked: 5 });
  });

  it("assigns unique consecutive sequence numbers under concurrent writers", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => recordAudit({ companyId: TEST_COMPANY_ID, actionName: `conc_${i}`, riskLevel: 0, result: "success" })));
    const rows = await prisma.auditLog.findMany({ where: { companyId: TEST_COMPANY_ID }, orderBy: { sequenceNo: "asc" }, select: { sequenceNo: true } });
    const seqs = rows.map((x) => Number(x.sequenceNo));
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  });

  it("is append-only at the database level", async () => {
    const row = await prisma.auditLog.findFirst({ where: { companyId: TEST_COMPANY_ID } });
    await assert.rejects(prisma.auditLog.update({ where: { id: row!.id }, data: { result: "rejected" } }), /append-only/);
    await assert.rejects(prisma.auditLog.delete({ where: { id: row!.id } }), /append-only/);
  });
});
