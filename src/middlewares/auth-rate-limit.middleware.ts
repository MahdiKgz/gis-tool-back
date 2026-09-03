import { NextFunction, Request, Response } from "express";
import { authRedis } from "../services/auth-redis.service";
import { AppError } from "./errorHandler";

export const authRateLimit = (limit: number, windowSeconds = 60) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const identifier = req.ip || req.socket.remoteAddress || "unknown";
    const window = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `auth:rate:${req.path}:${identifier}:${window}`;
    try {
      const count = await authRedis.incr(key);
      if (count === 1) await authRedis.expire(key, windowSeconds + 1);
      res.setHeader("X-RateLimit-Limit", String(limit));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - count)));
      if (count > limit) {
        throw new AppError(429, "Too many authentication attempts; try again later", "RATE_LIMITED");
      }
      next();
    } catch (error) {
      if (error instanceof AppError) return next(error);
      console.error("Authentication rate limiter unavailable:", error);
      next();
    }
  };
