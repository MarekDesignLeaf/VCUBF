/**
 * Verifies the per-company audit hash chain (CON-020/026). Exit 1 on any break.
 * Usage: npx tsx scripts/verify-audit-chain.ts [companyId]
 */
import { prisma } from "../src/db.js";
import { verifyChain } from "../src/lib/auditChain.js";

async function main() {
  const only = process.argv[2];
  const companies = only ? [{ id: only }] : await prisma.company.findMany({ select: { id: true } });
  let failed = 0;
  for (const c of companies) {
    const rows = await prisma.auditLog.findMany({ where: { companyId: c.id, sequenceNo: { not: null } }, orderBy: { sequenceNo: "asc" } });
    const r = verifyChain(rows.map((x) => ({ ...x, sequenceNo: x.sequenceNo!, interpretedIntent: x.interpretedIntent, errorMessage: x.errorMessage })));
    console.log(`${c.id}: ${r.ok ? "OK" : "BROKEN"} (${r.checked} entries${r.ok ? "" : `, first broken seq ${r.firstBrokenSequenceNo}: ${r.reason}`})`);
    if (!r.ok) failed += 1;
  }
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
