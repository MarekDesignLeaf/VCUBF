import bcrypt from "bcryptjs";
import { prisma } from "../src/db.js";

export const TEST_COMPANY_ID = "10000000-0000-0000-0000-000000000001";

export async function resetDb() {
  // Delete in FK-dependency order: audit log first; quote items reference
  // quotes which reference clients/jobs; jobs reference clients/users/
  // catalogue items; jobs must go before the catalogue items they may
  // reference.
  await prisma.auditLog.deleteMany({});
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
      role: "admin",
      permissions: ["crm.read", "crm.manage", "users.manage", "audit.read", "voice.execute", "recruitment.manage", "connectors.read", "connectors.manage"],
    },
  });
  const worker = await prisma.user.create({
    data: {
      companyId: company.id,
      email: "worker@test.local",
      passwordHash,
      displayName: "Test Worker",
      role: "worker",
      permissions: [],
    },
  });
  return { company, admin, worker };
}
