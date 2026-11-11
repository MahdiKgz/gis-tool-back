import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { AppError } from "../middlewares/errorHandler";
import { validateNewPassword } from "./auth.service";
import { getAccountMailer } from "./account-email.service";
import { database } from "./database.service";
import { hashPassword, verifyPassword } from "./password.service";

const VERIFY_MINUTES = 30;
const RESET_MINUTES = 15;
const MINUTE_MS = 60_000;
const emailFields = { email: true, emailVerifiedAt: true, pendingEmail: true } as const;
const emptyVerification = { pendingEmail: null, emailTokenHash: null, emailTokenExpires: null };
const emptyReset = { resetTokenHash: null, resetTokenExpires: null };

const readBody = (body: unknown): Record<string, unknown> =>
  body && typeof body === "object" ? (body as Record<string, unknown>) : {};

const invalidLink = () => new AppError(400, "This link is invalid or expired", "INVALID_EMAIL_LINK");
const emailUnavailable = () => new AppError(409, "This email cannot be used", "EMAIL_UNAVAILABLE");
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const readTokenHash = (body: unknown) => {
  const { token } = readBody(body);
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidLink();
  return hashToken(token);
};

export const normalizeAccountEmail = (value: unknown) => {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  const [local, domain] = email.split("@");
  if (
    email.length > 254 ||
    !local ||
    local.length > 64 ||
    !domain ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/.test(email) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)
  ) {
    throw new AppError(400, "A valid email address is required", "INVALID_EMAIL");
  }
  return email;
};

export const getAccountEmail = (userId: string) =>
  database.user.findUniqueOrThrow({ where: { id: userId }, select: emailFields });

export const requestEmailVerification = async (userId: string, body: unknown) => {
  const input = readBody(body);
  const email = normalizeAccountEmail(input.email);
  const password = typeof input.password === "string" ? input.password : "";
  const user = await database.user.findUnique({ where: { id: userId } });
  if (
    !user ||
    !password ||
    Buffer.byteLength(password) > 128 ||
    !(await verifyPassword(password, user.passwordHash))
  ) {
    throw new AppError(403, "Current password is incorrect", "INVALID_CURRENT_PASSWORD");
  }
  if (user.email === email) {
    throw new AppError(409, "This email is already verified", "EMAIL_ALREADY_VERIFIED");
  }
  const sendMail = getAccountMailer();
  const token = randomBytes(32).toString("base64url");
  const emailTokenHash = hashToken(token);
  const now = Date.now();
  const updated = await database.user.updateMany({
    where: {
      id: userId,
      sessionVersion: user.sessionVersion,
      email: user.email,
      OR: [
        { emailTokenExpires: null },
        { emailTokenExpires: { lte: new Date(now + (VERIFY_MINUTES - 1) * MINUTE_MS) } },
      ],
    },
    data: {
      pendingEmail: email,
      emailTokenHash,
      emailTokenExpires: new Date(now + VERIFY_MINUTES * MINUTE_MS),
    },
  });
  if (!updated.count) {
    throw new AppError(429, "Try requesting a new link in one minute", "RATE_LIMITED");
  }
  try {
    await sendMail(email, "verify", token, VERIFY_MINUTES);
  } catch (error) {
    await database.user.updateMany({ where: { id: userId, emailTokenHash }, data: emptyVerification });
    throw error;
  }
  return getAccountEmail(userId);
};

export const confirmAccountEmail = async (userId: string, body: unknown) => {
  const emailTokenHash = readTokenHash(body);
  const user = await database.user.findFirst({
    where: { id: userId, emailTokenHash, emailTokenExpires: { gt: new Date() } },
    select: { pendingEmail: true },
  });
  if (!user?.pendingEmail) throw invalidLink();

  try {
    const updated = await database.user.updateMany({
      where: { id: userId, emailTokenHash, emailTokenExpires: { gt: new Date() } },
      data: {
        email: user.pendingEmail,
        emailVerifiedAt: new Date(),
        ...emptyVerification,
        ...emptyReset,
      },
    });
    if (!updated.count) throw invalidLink();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw emailUnavailable();
    }
    throw error;
  }
  return getAccountEmail(userId);
};

export const requestPasswordReset = async (
  email: string,
  sendMail: ReturnType<typeof getAccountMailer>,
) => {
  const token = randomBytes(32).toString("base64url");
  const resetTokenHash = hashToken(token);
  const now = new Date();
  const updated = await database.user.updateMany({
    where: {
      email,
      emailVerifiedAt: { not: null },
      OR: [{ resetTokenExpires: null }, { resetTokenExpires: { lte: now } }],
    },
    data: { resetTokenHash, resetTokenExpires: new Date(now.getTime() + RESET_MINUTES * MINUTE_MS) },
  });
  if (!updated.count) return;
  try {
    await sendMail(email, "reset", token, RESET_MINUTES);
  } catch (error) {
    await database.user.updateMany({ where: { resetTokenHash }, data: emptyReset });
    throw error;
  }
};

export const resetAccountPassword = async (body: unknown) => {
  const resetTokenHash = readTokenHash(body);
  const password = validateNewPassword(readBody(body).password);
  const user = await database.user.findFirst({
    where: { resetTokenHash, resetTokenExpires: { gt: new Date() }, emailVerifiedAt: { not: null } },
    select: { id: true },
  });
  if (!user) throw invalidLink();

  const passwordHash = await hashPassword(password);
  const updated = await database.user.updateMany({
    where: { id: user.id, resetTokenHash, resetTokenExpires: { gt: new Date() } },
    data: {
      passwordHash,
      sessionVersion: { increment: 1 },
      ...emptyReset,
      ...emptyVerification,
    },
  });
  if (!updated.count) throw invalidLink();
};
