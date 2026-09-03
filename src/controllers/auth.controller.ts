import { NextFunction, Request, Response } from "express";
import { authConfig } from "../config/auth.config";
import { AppError } from "../middlewares/errorHandler";
import { getAuthenticatedUserId } from "../middlewares/auth.middleware";
import {
  getAccount,
  loginAccount,
  refreshAccountSession,
  registerAccount,
} from "../services/auth.service";
import { revokeRefreshSession } from "../services/token.service";

const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: authConfig.refreshCookiePath,
  maxAge: authConfig.refreshTokenTtlSeconds * 1000,
});

const sendAuthResult = (
  res: Response,
  statusCode: number,
  result: Awaited<ReturnType<typeof loginAccount>>,
) => {
  res.cookie(authConfig.refreshCookieName, result.refreshToken, cookieOptions());
  res.setHeader("Cache-Control", "no-store");
  return res.status(statusCode).json({
    success: true,
    data: { accessToken: result.accessToken, user: result.user },
  });
};

export const register = async (req: Request, res: Response, next: NextFunction) => {
  try {
    return sendAuthResult(res, 201, await registerAccount(req.body));
  } catch (error) {
    next(error);
  }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    return sendAuthResult(res, 200, await loginAccount(req.body));
  } catch (error) {
    next(error);
  }
};

export const refresh = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.[authConfig.refreshCookieName];
    if (typeof token !== "string" || token.length === 0) {
      throw new AppError(401, "A refresh session is required", "REFRESH_SESSION_REQUIRED");
    }
    return sendAuthResult(res, 200, await refreshAccountSession(token));
  } catch (error) {
    res.clearCookie(authConfig.refreshCookieName, cookieOptions());
    next(error);
  }
};

export const logout = async (req: Request, res: Response, next: NextFunction) => {
  const token = req.cookies?.[authConfig.refreshCookieName];
  try {
    if (typeof token === "string" && token.length > 0) await revokeRefreshSession(token);
    res.clearCookie(authConfig.refreshCookieName, cookieOptions());
    res.setHeader("Cache-Control", "no-store");
    return res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const me = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getAccount(getAuthenticatedUserId(req));
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ success: true, data: { user } });
  } catch (error) {
    next(error);
  }
};
