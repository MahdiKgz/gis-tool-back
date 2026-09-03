import fs from "node:fs/promises";
import path from "node:path";
import { NextFunction, Request, Response } from "express";
import { saveAnalysis } from "../services/analysis-store.service";
import { analyzeGisFile } from "../services/dry-run.service";
import { AppError } from "../middlewares/errorHandler";
import { getAuthenticatedUserId } from "../middlewares/auth.middleware";

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

export const uploadGeoJson = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  let analysisPersisted = false;
  try {
    if (!req.file) {
      throw new AppError(400, "No file was uploaded", "FILE_REQUIRED");
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
    const analysis = await saveAnalysis(jobData, report, undefined, getAuthenticatedUserId(req));
    analysisPersisted = true;

    console.log(
      `🔎 [SnapGIS] Dry run ${analysis.id} completed | ` +
        `issues: ${report.summary.issuesFound}`,
    );

    res.status(201).json({
      success: true,
      message:
        "File uploaded and analyzed. No repair has been queued.",
      data: {
        jobId: analysis.id,
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
    if (req.file && !analysisPersisted) {
      await fs.rm(path.resolve(req.file.path), { force: true }).catch(() => {
        // The cleanup cron remains a fallback if immediate cleanup fails.
      });
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
