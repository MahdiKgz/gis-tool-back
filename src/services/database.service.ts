import { PrismaClient } from "@prisma/client";

export const database = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

export const initializeDatabase = async (): Promise<void> => {
  await database.$connect();
  await database.user.findFirst({ select: { id: true } });
};
