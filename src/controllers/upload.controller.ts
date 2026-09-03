import fs from "node:fs/promises";
import path from "node:path";
import { NextFunction, Request, Response } from "express";
import {
  deleteAnalysis,
  saveAnalysis,
} from "../services/analysis-store.service";
import { analyzeGisFile } from "../services/dry-run.service";
import { AppError } from "../middlewares/errorHandler";
import { getAuthenticatedUserId } from "../middlewares/auth.middleware";
import {
  CreateUploadRecordInput,
  createUploadRecord,
  deleteUploadRecord,
} from "../services/upload-record.service";
import { parseUploadName } from "../services/upload-name.service";

const DEFAULT_TOLERANCE_MILLIMETERS = 25;
const MAX_TOLERANCE_MILLIMETERS = 100_000;

const parseTolerance = (value: unknown): number => {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_TOLERANCE_MILLIMETERS;
  }
  const tolerance = Number(value);
  if (
    !Number.isFinite(tolerance) ||
    tolerance <= 0 ||
    tolerance > MAX_TOLERANCE_MILLIMETERS
  ) {
    throw new AppError(
      400,
      `tolerance must be greater than 0 and at most ` +
        `${MAX_TOLERANCE_MILLIMETERS} millimeters`,
      "INVALID_TOLERANCE",
    );
  }
  return tolerance;
};

interface UploadHandlerDependencies {
  createRecord: (input: CreateUploadRecordInput) => Promise<unknown>;
  deleteRecord: (id: string) => Promise<void>;
}

export const createUploadHandler = (
  dependencies: UploadHandlerDependencies = {
    createRecord: createUploadRecord,
    deleteRecord: deleteUploadRecord,
  },
) =>
  async (req: Request, res: Response, next: NextFunction) => {
    let analysisId: string | null = null;
    let persistenceComplete = false;
    try {
      if (!req.file) {
        throw new AppError(400, "No file was uploaded", "FILE_REQUIRED");
      }

      const name = parseUploadName(req.body?.name);
      const userId = getAuthenticatedUserId(req);
      if (req.file.originalname.length > 255) {
        throw new AppError(
          400,
          "The original file name must not exceed 255 characters",
          "INVALID_FILE_NAME",
        );
      }

      const tolerance = parseTolerance(req.body?.tolerance);
      const filePath = path.resolve(req.file.path);

      console.log(
        `[API] 📥 GIS file stored for dry run: ${req.file.filename} ` +
          `| tolerance: ${tolerance}mm`,
      );

      const jobData = {
        fileName: req.file.filename,
        originalName: req.file.originalname,
        filePath,
        size: req.file.size,
        tolerance,
      };
      const report = await analyzeGisFile(
        filePath,
        req.file.originalname,
        { toleranceMillimeters: tolerance },
      );
      const analysis = await saveAnalysis(jobData, report, undefined, userId);
      analysisId = analysis.id;
      await dependencies.createRecord({
        id: analysis.id,
        userId,
        name,
        originalName: req.file.originalname,
        storedFileName: req.file.filename,
        storagePath: filePath,
        mimeType: req.file.mimetype || "application/octet-stream",
        sizeInBytes: req.file.size,
      });
      persistenceComplete = true;

      console.log(
        `🔎 [SnapGIS] Dry run ${analysis.id} completed | ` +
          `issues: ${report.summary.issuesFound}`,
      );

      res.status(201).json({
        success: true,
        message: "File uploaded and analyzed. No repair has been queued.",
        data: {
          jobId: analysis.id,
          userId,
          name,
          status: "dry-run-complete",
          originalName: req.file.originalname,
          sizeInBytes: req.file.size,
          appliedTolerance: tolerance,
          report,
          heal: {
            method: "POST",
            path: `/api/heal/${analysis.id}`,
          },
        },
      });
    } catch (err) {
      if (!persistenceComplete) {
        if (analysisId) {
          await Promise.allSettled([
            deleteAnalysis(analysisId),
            dependencies.deleteRecord(analysisId),
          ]);
        }
        if (req.file) {
          await fs.rm(path.resolve(req.file.path), { force: true }).catch(() => {
            // The cleanup cron remains a fallback if immediate cleanup fails.
          });
        }
      }
      if (
        err instanceof SyntaxError ||
        (err instanceof Error &&
          /KML not found|no layers found|invalid shapefile/i.test(err.message))
      ) {
        next(
          new AppError(
            422,
            `The uploaded GIS file could not be parsed: ${err.message}`,
            "INVALID_GIS_FILE",
          ),
        );
        return;
      }
      next(err);
    }
  };

export const uploadGeoJson = createUploadHandler();
