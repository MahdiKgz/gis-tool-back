import { Request, Response, NextFunction } from "express";
import multer from "multer";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "AppError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const globalErrorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Operational client responses (including an anonymous session check) are
  // expected API outcomes. Keep stack traces for unexpected/server failures.
  if ((err instanceof AppError && err.statusCode >= 400 && err.statusCode < 500) ||
    err instanceof multer.MulterError) {
    console.warn("API request rejected", {
      method: req.method,
      path: req.path,
      status: err instanceof multer.MulterError ? 400 : err.statusCode,
      code: err.code ?? "REQUEST_REJECTED",
    });
  } else {
    console.error("Unhandled API error:", err);
  }

  const statusCode = err.statusCode || 500;
  let message = err.message || "خطای داخلی سرور رخ داده است.";
  let code = err.code || "INTERNAL_SERVER_ERROR";

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        code: "FILE_TOO_LARGE",
        message: "The uploaded file exceeds the 5 MB limit.",
      });
    }
    return res
      .status(400)
      .json({ success: false, code: err.code, message: err.message });
  }

  res.status(statusCode).json({
    success: false,
    code,
    message,
  });
};
