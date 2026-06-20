import multer from "multer";
import path from "path";
import fs from "fs";

interface MulterOptions {
  destination: string;
  allowedExtensions: string[];
  maxSizeInMB: number;
}

export const createUploader = (options: MulterOptions) => {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = path.resolve(options.destination);

      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    },
  });

  const fileFilter = (
    req: any,
    file: Express.Multer.File,
    cb: multer.FileFilterCallback,
  ) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (options.allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `فرمت فایل پشتیبانی نمی‌شود. فرمت‌های مجاز: ${options.allowedExtensions.join(", ")}`,
        ),
      );
    }
  };

  return multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: options.maxSizeInMB * 1024 * 1024 },
  });
};
