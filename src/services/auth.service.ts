import { Prisma } from "@prisma/client";
import { AppError } from "../middlewares/errorHandler";
import { hashPassword, verifyPassword } from "./password.service";
import {
  consumeRefreshSession,
  createAccessToken,
  createRefreshSession,
} from "./token.service";
import {
  createUser,
  findUserById,
  findUserByPhone,
  UserRecord,
} from "./user.service";

export interface PublicUser {
  id: string;
  name: string;
  phone: string;
  roles: string[];
  createdAt: string;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

const normalizeDigits = (value: string) =>
  value
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));

export const normalizePhone = (phone: string): string =>
  normalizeDigits(phone).replace(/[\s()-]/g, "");

export const validateRegistrationInput = (body: unknown) => {
  if (!body || typeof body !== "object") {
    throw new AppError(400, "A JSON request body is required", "INVALID_REQUEST_BODY");
  }
  const input = body as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const phone = typeof input.phone === "string" ? normalizePhone(input.phone) : "";
  const password = typeof input.password === "string" ? input.password : "";

  if (name.length < 2 || name.length > 100) {
    throw new AppError(400, "Name must contain between 2 and 100 characters", "INVALID_NAME");
  }
  if (!/^09\d{9}$/.test(phone)) {
    throw new AppError(400, "Phone must be a valid 11-digit Iranian mobile number", "INVALID_PHONE");
  }
  if (password.length < 8 || Buffer.byteLength(password, "utf8") > 128) {
    throw new AppError(400, "Password must contain between 8 and 128 bytes", "INVALID_PASSWORD");
  }
  return { name, phone, password };
};

export const validateLoginInput = (body: unknown) => {
  if (!body || typeof body !== "object") {
    throw new AppError(400, "A JSON request body is required", "INVALID_REQUEST_BODY");
  }
  const input = body as Record<string, unknown>;
  const phone = typeof input.phone === "string" ? normalizePhone(input.phone) : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!/^09\d{9}$/.test(phone) || password.length === 0) {
    throw new AppError(400, "A valid phone and password are required", "INVALID_CREDENTIALS_INPUT");
  }
  return { phone, password };
};

export const toPublicUser = (user: UserRecord): PublicUser => ({
  id: user.id,
  name: user.name,
  phone: user.phone,
  roles: user.roles,
  createdAt: user.createdAt.toISOString(),
});

const issueCredentials = async (user: UserRecord): Promise<AuthResult> => ({
  accessToken: createAccessToken({ id: user.id, roles: user.roles }),
  refreshToken: await createRefreshSession(user.id),
  user: toPublicUser(user),
});

export const registerAccount = async (body: unknown): Promise<AuthResult> => {
  const input = validateRegistrationInput(body);
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await createUser({
      name: input.name,
      phone: input.phone,
      passwordHash,
    });
    return issueCredentials(user);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "An account with this phone already exists", "PHONE_ALREADY_EXISTS");
    }
    throw error;
  }
};

let dummyHash: Promise<string> | undefined;

export const loginAccount = async (body: unknown): Promise<AuthResult> => {
  const input = validateLoginInput(body);
  const user = await findUserByPhone(input.phone);
  dummyHash ??= hashPassword("snapgis-dummy-password");
  const passwordMatches = await verifyPassword(
    input.password,
    user?.passwordHash ?? (await dummyHash),
  );
  if (!user || !passwordMatches) {
    throw new AppError(401, "Phone or password is incorrect", "INVALID_CREDENTIALS");
  }
  return issueCredentials(user);
};

export const refreshAccountSession = async (refreshToken: string): Promise<AuthResult> => {
  const session = await consumeRefreshSession(refreshToken);
  if (!session) {
    throw new AppError(401, "Refresh session is invalid or expired", "INVALID_REFRESH_SESSION");
  }
  const user = await findUserById(session.userId);
  if (!user) {
    throw new AppError(401, "Refresh session is invalid or expired", "INVALID_REFRESH_SESSION");
  }
  return issueCredentials(user);
};

export const getAccount = async (userId: string): Promise<PublicUser> => {
  const user = await findUserById(userId);
  if (!user) throw new AppError(401, "Authenticated user no longer exists", "USER_NOT_FOUND");
  return toPublicUser(user);
};
