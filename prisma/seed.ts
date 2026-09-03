import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/services/password.service";

const prisma = new PrismaClient();

const testUsers = [
  {
    name: "SnapGIS Admin",
    phone: "09120000001",
    password: "SnapGIS.Admin.2026",
    roles: ["admin", "user"],
  },
  {
    name: "SnapGIS Test User",
    phone: "09120000002",
    password: "SnapGIS.User.2026",
    roles: ["user"],
  },
] as const;

const main = async (): Promise<void> => {
  for (const testUser of testUsers) {
    const passwordHash = await hashPassword(testUser.password);
    await prisma.user.upsert({
      where: { phone: testUser.phone },
      update: {
        name: testUser.name,
        passwordHash,
        roles: [...testUser.roles],
      },
      create: {
        name: testUser.name,
        phone: testUser.phone,
        passwordHash,
        roles: [...testUser.roles],
      },
    });
  }

  console.log(`Seeded ${testUsers.length} SnapGIS test users.`);
};

main()
  .catch((error: unknown) => {
    console.error("Failed to seed SnapGIS test users:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
