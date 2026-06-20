import { Request, Response, NextFunction } from "express";
import multer from "multer";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    // @ts-ignore
    Object.setPrototypeOf(this, new AppError());
  }
}

export const globalErrorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  console.error(`💥 Error Caught in Global Handler:`, err);

  const statusCode = err.statusCode || 500;
  let message = err.message || "خطای داخلی سرور رخ داده است.";
  let code = err.code || "INTERNAL_SERVER_ERROR";

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        code: "FILE_TOO_LARGE",
        message: "حجم فایل ارسالی بیشتر از حد مجاز (۵۰ مگابایت) است.",
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
