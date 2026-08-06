import fs from "node:fs/promises";
import { NextFunction, Request, Response } from "express";
import {
  getAnalysis,
  markAnalysisQueued,
} from "../services/analysis-store.service";
import { gisQueue } from "../services/queue.service";
import { AppError } from "../middlewares/errorHandler";

export const healAnalyzedFile = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const analysisId = req.params.jobId;
    if (typeof analysisId !== "string" || analysisId.length === 0) {
      throw new AppError(400, "A job ID is required", "JOB_ID_REQUIRED");
    }

    let analysis;
    try {
      analysis = await getAnalysis(analysisId);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new AppError(400, "Invalid job ID", "INVALID_JOB_ID");
      }
      throw error;
    }

    if (!analysis) {
      throw new AppError(404, "Dry-run job not found", "JOB_NOT_FOUND");
    }

    if (analysis.queueJobId) {
      res.status(202).json({
        success: true,
        message: "Healing was already queued for this dry run.",
        data: {
          jobId: analysis.queueJobId,
          dryRunJobId: analysis.id,
          status: "queued",
          queuedAt: analysis.queuedAt,
        },
      });
      return;
    }

    try {
      await fs.access(analysis.jobData.filePath);
    } catch {
      throw new AppError(
        410,
        "The uploaded source file is no longer available",
        "SOURCE_FILE_EXPIRED",
      );
    }

    const job = await gisQueue.add(
      "heal-gis-file",
      analysis.jobData,
      { jobId: analysis.id },
    );
    const queueJobId = String(job.id ?? analysis.id);
    const updated = await markAnalysisQueued(analysis, queueJobId);

    console.log(
      `🚀 [Queue] Heal job ${queueJobId} added from dry run ${analysis.id}`,
    );

    res.status(202).json({
      success: true,
      message: "Healing has been queued.",
      data: {
        jobId: queueJobId,
        dryRunJobId: updated.id,
        status: "queued",
        queuedAt: updated.queuedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};
