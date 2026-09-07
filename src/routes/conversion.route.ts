import express, { NextFunction, Request, Response } from "express";
import multer from "multer";
import path from "node:path";
import { requireAuthentication } from "../middlewares/auth.middleware";
import { AppError } from "../middlewares/errorHandler";
import { createConversionHandlers } from "../controllers/conversion.controller";
import {
  createConversionDirectory,
  MAX_CONVERSION_MB,
  removeConversion,
} from "../services/conversion.service";

const router = express.Router();
const handlers = createConversionHandlers();
export const conversionUpload = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  let directory: string | undefined;
  try {
    directory = (await createConversionDirectory()).directory;
    const receive = multer({
      storage: multer.diskStorage({
        destination: directory,
        filename: (_req, file, callback) =>
          callback(
            null,
            "input" + path.extname(file.originalname).toLowerCase(),
          ),
      }),
      fileFilter: (_req, file, callback) =>
        /\.(geojson|json|zip|dxf)$/i.test(file.originalname)
          ? callback(null, true)
          : callback(
              new AppError(
                400,
                "Use GeoJSON, Shapefile ZIP or DXF.",
                "UNSUPPORTED_CONVERSION_FORMAT",
              ),
            ),
      limits: {
        files: 1,
        fileSize: MAX_CONVERSION_MB * 1024 * 1024,
        fields: 3,
        fieldSize: 128,
        parts: 4,
      },
    }).single("file");
    receive(req, res, (error) => {
      if (error || !req.file) {
        void removeConversion(directory!)
          .catch(() => {})
          .finally(() =>
            next(
              error instanceof multer.MulterError &&
                error.code === "LIMIT_FILE_SIZE"
                ? new AppError(
                    413,
                    `The upload exceeds ${MAX_CONVERSION_MB} MiB.`,
                    "CONVERSION_LIMIT_EXCEEDED",
                  )
                : (error ??
                    new AppError(400, "Upload a file.", "FILE_REQUIRED")),
            ),
          );
      } else next();
    });
  } catch (error) {
    if (directory) await removeConversion(directory).catch(() => {});
    next(error);
  }
};
router.use(requireAuthentication);
router.post("/", conversionUpload, handlers.upload);
router.get("/:id", handlers.status);
router.get("/:id/download", handlers.download);
export { router };
