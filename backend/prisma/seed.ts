import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Never create a hidden Demo Company or a known administrator password.
  // Local/demo setup is explicit and follows the same company-first model as
  // the public onboarding screen.
  const companyName = process.env.SEED_COMPANY_NAME?.trim();
  const administratorEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const administratorPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!companyName || !administratorEmail || !administratorPassword) {
    console.log("Seed skipped. Use the first-run setup screen, or provide SEED_COMPANY_NAME, SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD for an explicit local seed.");
    return;
  }

  const existingSetup = await prisma.systemSetup.findUnique({ where: { id: "primary" } });
  if (existingSetup) {
    console.log("Seed skipped. This Secretary workspace is already configured.");
    return;
  }

  const permissions = [
    "company.manage", "crm.read", "crm.manage", "users.manage", "audit.read",
    "voice.execute", "recruitment.manage", "connectors.read", "connectors.manage",
  ];
  const passwordHash = await bcrypt.hash(administratorPassword, 12);
  await prisma.$transaction(async (tx) => {
    const company = await tx.company.create({ data: { name: companyName, setupCompletedAt: new Date() } });
    const administrator = await tx.user.create({
      data: { companyId: company.id, email: administratorEmail, passwordHash, displayName: "Administrator", role: "administrator", permissions },
    });
    await tx.company.update({ where: { id: company.id }, data: { primaryAdminUserId: administrator.id } });
    await tx.systemSetup.create({ data: { id: "primary", companyId: company.id } });
  });
  console.log("Seed complete. The named company and its explicit administrator were created.");
}

main().finally(() => prisma.$disconnect());
