const parsePositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const authConfig = {
  accessTokenTtl: process.env.JWT_ACCESS_TTL || "15m",
  issuer: process.env.JWT_ISSUER || "snapgis-api",
  audience: process.env.JWT_AUDIENCE || "snapgis-web",
  refreshTokenTtlSeconds: parsePositiveInteger(
    process.env.REFRESH_TOKEN_TTL_SECONDS,
    7 * 24 * 60 * 60,
  ),
  refreshCookieName: "snapgis_refresh",
  refreshCookiePath: "/api/auth",
};

export const getAccessTokenSecret = (): string => {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_ACCESS_SECRET must contain at least 32 characters");
  }
  return secret;
};
