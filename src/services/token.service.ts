import { createHash, randomBytes, randomUUID } from "node:crypto";
import jwt, { JwtPayload, SignOptions } from "jsonwebtoken";
import { authConfig, getAccessTokenSecret } from "../config/auth.config";
import { AppError } from "../middlewares/errorHandler";
import { authRedis } from "./auth-redis.service";

export interface AccessTokenPrincipal {
  id: string;
  roles: string[];
}

interface RefreshSession {
  userId: string;
  createdAt: string;
}

const refreshKey = (token: string) =>
  `auth:refresh:${createHash("sha256").update(token).digest("hex")}`;

export const createAccessToken = (principal: AccessTokenPrincipal): string =>
  jwt.sign(
    { roles: principal.roles, type: "access" },
    getAccessTokenSecret(),
    {
      subject: principal.id,
      expiresIn: authConfig.accessTokenTtl as NonNullable<
        SignOptions["expiresIn"]
      >,
      issuer: authConfig.issuer,
      audience: authConfig.audience,
      jwtid: randomUUID(),
      algorithm: "HS256",
    },
  );

export const verifyAccessToken = (token: string): AccessTokenPrincipal => {
  try {
    const payload = jwt.verify(token, getAccessTokenSecret(), {
      issuer: authConfig.issuer,
      audience: authConfig.audience,
      algorithms: ["HS256"],
    }) as JwtPayload;

    if (
      payload.type !== "access" ||
      typeof payload.sub !== "string" ||
      !Array.isArray(payload.roles) ||
      !payload.roles.every((role) => typeof role === "string")
    ) {
      throw new Error("Invalid token claims");
    }
    return { id: payload.sub, roles: payload.roles };
  } catch {
    throw new AppError(401, "Access token is invalid or expired", "INVALID_ACCESS_TOKEN");
  }
};

export const createRefreshSession = async (userId: string): Promise<string> => {
  const token = randomBytes(48).toString("base64url");
  const session: RefreshSession = { userId, createdAt: new Date().toISOString() };
  await authRedis.set(
    refreshKey(token),
    JSON.stringify(session),
    "EX",
    authConfig.refreshTokenTtlSeconds,
  );
  return token;
};

export const consumeRefreshSession = async (
  token: string,
): Promise<RefreshSession | null> => {
  const serialized = (await authRedis.call("GETDEL", refreshKey(token))) as string | null;
  if (!serialized) return null;
  try {
    const session = JSON.parse(serialized) as RefreshSession;
    return typeof session.userId === "string" ? session : null;
  } catch {
    return null;
  }
};

export const revokeRefreshSession = async (token: string): Promise<void> => {
  await authRedis.del(refreshKey(token));
};
