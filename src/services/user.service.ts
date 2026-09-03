import { User } from "@prisma/client";
import { database } from "./database.service";

export interface UserRecord {
  id: string;
  name: string;
  phone: string;
  passwordHash: string;
  roles: string[];
  createdAt: Date;
}

const mapUser = (user: User): UserRecord => ({
  id: user.id,
  name: user.name,
  phone: user.phone,
  passwordHash: user.passwordHash,
  roles: user.roles,
  createdAt: user.createdAt,
});

export const findUserByPhone = async (phone: string): Promise<UserRecord | null> => {
  const user = await database.user.findUnique({ where: { phone } });
  return user ? mapUser(user) : null;
};

export const findUserById = async (id: string): Promise<UserRecord | null> => {
  const user = await database.user.findUnique({ where: { id } });
  return user ? mapUser(user) : null;
};

export const createUser = async (
  input: { name: string; phone: string; passwordHash: string },
): Promise<UserRecord> => {
  const user = await database.user.create({ data: input });
  return mapUser(user);
};
