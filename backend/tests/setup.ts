import bcrypt from "bcryptjs";
import { prisma } from "../src/db.js";

export const TEST_COMPANY_ID = "10000000-0000-0000-0000-000000000001";

export async function resetDb() {
  // Delete in FK-dependency order: audit log and jobs reference clients/users/
  // service catalogue items; jobs must go before the catalogue items they
  // may reference.
  await prisma.auditLog.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.serviceCatalogueItem.deleteMany({});
  await prisma.lead.deleteMany({});
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
      permissions: ["crm.read", "crm.manage", "users.manage", "audit.read", "voice.execute"],
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
