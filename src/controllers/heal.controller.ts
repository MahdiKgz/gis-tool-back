import fs from "node:fs/promises";
import { NextFunction, Request, Response } from "express";
import {
  getAnalysis,
  markAnalysisQueued,
  resetAnalysisQueueRequest,
} from "../services/analysis-store.service";
import { gisQueue } from "../services/queue.service";
import { AppError } from "../middlewares/errorHandler";
import { buildHealStatusData } from "./heal-status.controller";
import { getAuthenticatedUserId } from "../middlewares/auth.middleware";
import { updateUploadHealingMetrics } from "../services/upload-record.service";

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
    if (analysis.ownerId !== getAuthenticatedUserId(req)) {
      throw new AppError(404, "Dry-run job not found", "JOB_NOT_FOUND");
    }

    if (analysis.queueJobId && analysis.healStatus === "failed") {
      analysis = (await resetAnalysisQueueRequest(analysis.id)) ?? analysis;
      await updateUploadHealingMetrics(analysis.id, "dry-run-complete", 0);
    }

    if (analysis.queueJobId) {
      res.status(analysis.healStatus === "completed" ? 200 : 202).json({
        success: true,
        message:
          analysis.healStatus === "completed"
            ? "Healing has already completed."
            : "Healing was already requested for this dry run.",
        data: buildHealStatusData(analysis),
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

    const updated = await markAnalysisQueued(analysis, analysis.id);
    let queueJobId = analysis.id;
    try {
      await updateUploadHealingMetrics(analysis.id, "queued", 0);
      const job = await gisQueue.add(
        "heal-gis-file",
        analysis.jobData,
        { jobId: analysis.id },
      );
      queueJobId = String(job.id ?? analysis.id);
    } catch (error) {
      await Promise.allSettled([
        resetAnalysisQueueRequest(analysis.id),
        updateUploadHealingMetrics(analysis.id, "dry-run-complete", 0),
      ]);
      throw error;
    }

    console.log(
      `🚀 [Queue] Heal job ${queueJobId} added from dry run ${analysis.id}`,
    );

    res.status(202).json({
      success: true,
      message: "Healing has been queued.",
      data: {
        ...buildHealStatusData(updated),
      },
    });
  } catch (error) {
    next(error);
  }
};
