import { randomUUID } from "node:crypto";
import { objectStorageEnabled, objectKey, putStoredFile, removeStoredFile } from "../services/object-storage.service";
import { readGisFile } from "../services/gis-file.service";
import { compactReport } from "../services/public-report.service";
import { isCadFile, normalizedCadPath, parseCadSourceCrs } from "../services/cad-file.service";
import fs from "node:fs/promises";
import path from "node:path";
import { NextFunction, Request, Response } from "express";
import {
  deleteAnalysis,
  saveAnalysis,
} from "../services/analysis-store.service";
import { analyzeGeoJson } from "../services/dry-run.service";
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
    const storedObjects: string[] = [];
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

      const sourceCrs = isCadFile(req.file.originalname) ? parseCadSourceCrs(req.body?.sourceCrs) : undefined;
      const id = randomUUID();
      const jobData: import("../types/gis-job").GisJobData = {
        ownerId: userId,
        ...(sourceCrs ? { sourceCrs } : {}),
        fileName: req.file.filename,
        originalName: req.file.originalname,
        filePath,
        size: req.file.size,
        tolerance,
      };
      const geojson = await readGisFile(filePath, req.file.originalname, sourceCrs ? { sourceCrs } : undefined);
      const report = analyzeGeoJson(geojson, { toleranceMillimeters: tolerance });
      if (objectStorageEnabled()) {
        jobData.originalObject = await putStoredFile(objectKey(userId, id, 'original', req.file.originalname), filePath, req.file.mimetype);
        storedObjects.push(jobData.originalObject);
        const normalized = normalizedCadPath(filePath);
        await fs.writeFile(normalized, JSON.stringify(geojson));
        jobData.filePath = await putStoredFile(objectKey(userId, id, 'normalized', 'input.geojson'), normalized, 'application/geo+json');
        storedObjects.push(jobData.filePath);
      }
      const analysis = await saveAnalysis(jobData, report, undefined, userId, id);
      analysisId = analysis.id;
      await dependencies.createRecord({
        id: analysis.id,
        userId,
        name,
        originalName: req.file.originalname,
        storedFileName: req.file.filename,
        storagePath: jobData.originalObject ?? filePath,
        mimeType: req.file.mimetype || "application/octet-stream",
        sizeInBytes: req.file.size,
        identifiedIssues: report.summary.issuesFound,
      });
      persistenceComplete = true;
      if (objectStorageEnabled()) {
        await fs.rm(filePath, { force: true }).catch(() => {});
        await fs.rm(normalizedCadPath(filePath), { force: true }).catch(() => {});
      }

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
          ...(sourceCrs ? { sourceCrs, outputCrs: "EPSG:4326" } : {}),
          report: req.query?.report === "compact" ? compactReport(report) : report,
          heal: {
            method: "POST",
            path: `/api/heal/${analysis.id}`,
          },
        },
      });
    } catch (err) {
      if (!persistenceComplete) {
        await Promise.allSettled(storedObjects.map(removeStoredFile));
        if (analysisId) {
          await Promise.allSettled([
            deleteAnalysis(analysisId),
            dependencies.deleteRecord(analysisId),
          ]);
        }
        if (req.file) {
          if (isCadFile(req.file.originalname) || objectStorageEnabled()) {
            await fs.rm(normalizedCadPath(path.resolve(req.file.path)), { force: true }).catch(() => {});
          }
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
