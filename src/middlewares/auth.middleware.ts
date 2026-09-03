import { NextFunction, Request, Response } from "express";
import { AppError } from "./errorHandler";
import { verifyAccessToken } from "../services/token.service";

export const requireAuthentication = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  try {
    const authorization = req.header("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      throw new AppError(401, "A Bearer access token is required", "AUTHENTICATION_REQUIRED");
    }
    const principal = verifyAccessToken(authorization.slice("Bearer ".length));
    req.auth = { userId: principal.id, roles: principal.roles };
    next();
  } catch (error) {
    next(error);
  }
};

export const getAuthenticatedUserId = (req: Request): string => {
  if (!req.auth) {
    throw new AppError(401, "Authentication is required", "AUTHENTICATION_REQUIRED");
  }
  return req.auth.userId;
};
