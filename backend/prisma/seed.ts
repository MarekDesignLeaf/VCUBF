import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const company = await prisma.company.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Demo Company",
    },
  });

  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  const adminPermissions = [
    "crm.read",
    "crm.manage",
    "users.manage",
    "audit.read",
    "voice.execute",
    "recruitment.manage",
    "connectors.read",
    "connectors.manage",
  ];

  await prisma.user.upsert({
    where: { email: "admin@example.com" },
    update: { permissions: adminPermissions, passwordHash },
    create: {
      companyId: company.id,
      email: "admin@example.com",
      passwordHash,
      displayName: "Admin",
      role: "admin",
      permissions: adminPermissions,
    },
  });

  console.log(`Seed complete. Login with admin@example.com / ${process.env.SEED_ADMIN_PASSWORD ? "the configured SEED_ADMIN_PASSWORD" : "ChangeMe123!"}`);
}

main().finally(() => prisma.$disconnect());
