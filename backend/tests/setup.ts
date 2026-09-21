import bcrypt from "bcryptjs";
import { prisma } from "../src/db.js";

export const TEST_COMPANY_ID = "10000000-0000-0000-0000-000000000001";

/**
 * Refuses to touch anything but the isolated test database.
 *
 * resetDb() deletes every row in the schema. Run through
 * scripts/test-with-embedded-pg.mjs that is the throwaway database on port
 * 55432; run directly (node --test tests/foo.test.ts) it is whatever .env
 * points at — the development database. There is no safe way to tell those
 * apart after the fact, so refuse up front.
 */
function assertTestDatabase() {
  const url = process.env.DATABASE_URL ?? "";
  const isolated = url.includes(":55432/") || /\/[^/]*_test(\?|$)/.test(url);
  if (isolated) return;
  throw new Error(
    "Refusing to reset a database that is not the isolated test database.\n" +
    "DATABASE_URL points at: " + (url.replace(/\/\/[^@]*@/, "//***@") || "(unset)") + "\n" +
    "Run the suite with: npm test    (it starts its own Postgres on port 55432)"
  );
}

export async function resetDb() {
  assertTestDatabase();
  // Delete in FK-dependency order: audit log first; quote items reference
  // quotes which reference clients/jobs; jobs reference clients/users/
  // catalogue items; jobs must go before the catalogue items they may
  // reference.
  await prisma.idempotencyRecord.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.systemSetup.deleteMany({});
  await prisma.passwordResetToken.deleteMany({});
  await prisma.assistantMemory.deleteMany({});
  await prisma.voiceDeviceState.deleteMany({});
  await prisma.voiceConversationMessage.deleteMany({});
  await prisma.voiceConversation.deleteMany({});
  await prisma.voicePendingAction.deleteMany({});
  await prisma.devicePairing.deleteMany({});
  await prisma.connectorOAuthState.deleteMany({});
  await prisma.connectorCredential.deleteMany({});
  await prisma.notificationAcknowledgement.deleteMany({});
  await prisma.learningRule.deleteMany({});
  await prisma.playbookRun.deleteMany({});
  await prisma.playbook.deleteMany({});
  await prisma.candidate.deleteMany({});
  await prisma.jobOpening.deleteMany({});
  await prisma.quoteItem.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.invoiceItem.deleteMany({});
  await prisma.invoice.deleteMany({});
  await prisma.quote.deleteMany({});
  await prisma.documentRecord.deleteMany({});
  await prisma.task.deleteMany({});
  await prisma.communicationIntake.deleteMany({});
  await prisma.connectorSource.deleteMany({});
  await prisma.communicationRecord.deleteMany({});
  await prisma.photoServiceSelection.deleteMany({});
  await prisma.portfolioPhoto.deleteMany({});
  await prisma.websiteContentProposal.deleteMany({});
  await prisma.websiteAuditFinding.deleteMany({});
  await prisma.websiteAudit.deleteMany({});
  await prisma.industryServiceLink.deleteMany({});
  await prisma.industry.deleteMany({});
  await prisma.businessContextItem.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.jobResourceRequirement.deleteMany({});
  await prisma.serviceCatalogueItem.deleteMany({});
  await prisma.lead.deleteMany({});
  await prisma.contact.deleteMany({});
  await prisma.clientMergeRecord.deleteMany({});
  await prisma.client.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.company.deleteMany({});
}

export async function seedCompanyAndAdmin() {
  const company = await prisma.company.create({
    data: { id: TEST_COMPANY_ID, name: "Test Co" },
  });
  const passwordHash = await bcrypt.hash("Password123!", 10);
  const admin = await prisma.user.create({
    data: {
      companyId: company.id,
      email: "admin@test.local",
      passwordHash,
      displayName: "Test Admin",
      role: "administrator",
      permissions: ["company.manage", "crm.read", "crm.manage", "users.manage", "audit.read", "voice.execute", "recruitment.manage", "connectors.read", "connectors.manage"],
    },
  });
  const worker = await prisma.user.create({
    data: {
      companyId: company.id,
      email: "worker@test.local",
      passwordHash,
      displayName: "Test Worker",
      role: "field_worker",
      permissions: [],
    },
  });
  await prisma.company.update({ where: { id: company.id }, data: { primaryAdminUserId: admin.id, setupCompletedAt: new Date() } });
  await prisma.systemSetup.create({ data: { id: "primary", companyId: company.id } });
  return { company, admin, worker };
}
