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

  const passwordHash = await bcrypt.hash("ChangeMe123!", 10);

  await prisma.user.upsert({
    where: { email: "admin@example.com" },
    update: {},
    create: {
      companyId: company.id,
      email: "admin@example.com",
      passwordHash,
      displayName: "Admin",
      role: "admin",
      permissions: ["crm.read", "crm.manage", "users.manage", "audit.read", "voice.execute"],
    },
  });

  console.log("Seed complete. Login with admin@example.com / ChangeMe123!");
}

main().finally(() => prisma.$disconnect());
