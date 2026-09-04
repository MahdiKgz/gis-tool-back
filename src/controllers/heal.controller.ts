import fs from "node:fs/promises";
import { NextFunction, Request, Response } from "express";
import {
  getAnalysis,
  markAnalysisCancelled,
  markAnalysisQueued,
  resetAnalysisQueueRequest,
} from "../services/analysis-store.service";
import { gisQueue } from "../services/queue.service";
import { AppError } from "../middlewares/errorHandler";
import { buildHealStatusData } from "./heal-status.controller";
import { getAuthenticatedUserId } from "../middlewares/auth.middleware";
import { updateUploadHealingMetrics } from "../services/upload-record.service";
import {
  clearHealingCancellation,
  requestHealingCancellation,
} from "../services/heal-cancellation.service";
import { publishHealingEvent } from "../services/heal-event.service";

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

    if (
      analysis.queueJobId &&
      (analysis.healStatus === "failed" || analysis.healStatus === "cancelled")
    ) {
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
      await clearHealingCancellation(analysis.id);
      await updateUploadHealingMetrics(analysis.id, "queued", 0);
      const job = await gisQueue.add("heal-gis-file", analysis.jobData, {
        jobId: analysis.id,
      });
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

export const cancelHealing = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const analysisId = req.params.jobId;
    if (typeof analysisId !== "string" || analysisId.length === 0) {
      throw new AppError(400, "A job ID is required", "JOB_ID_REQUIRED");
    }
    const analysis = await getAnalysis(analysisId);
    if (!analysis || analysis.ownerId !== getAuthenticatedUserId(req)) {
      throw new AppError(404, "Dry-run job not found", "JOB_NOT_FOUND");
    }
    if (analysis.healStatus === "cancelled") {
      res.status(200).json({
        success: true,
        message: "Healing was already cancelled.",
        data: buildHealStatusData(analysis),
      });
      return;
    }
    if (
      analysis.healStatus !== "queued" &&
      analysis.healStatus !== "processing"
    ) {
      throw new AppError(
        409,
        "Only queued or processing healing jobs can be cancelled",
        "HEALING_NOT_CANCELLABLE",
      );
    }

    await requestHealingCancellation(analysis.id);
    const job = await gisQueue.getJob(analysis.queueJobId ?? analysis.id);
    if (job) {
      const state = await job.getState();
      if (
        ["waiting", "delayed", "prioritized", "waiting-children"].includes(
          state,
        )
      ) {
        try {
          await job.remove();
        } catch {
          // The worker may have claimed the job between getState and remove.
          // Its cooperative cancellation checks will stop it safely.
        }
      }
    }

    const cancelled = await markAnalysisCancelled(analysis.id);
    if (!cancelled) {
      throw new AppError(404, "Dry-run job not found", "JOB_NOT_FOUND");
    }
    await updateUploadHealingMetrics(analysis.id, "cancelled", 0);
    await publishHealingEvent(analysis.id, {
      type: "cancelled",
      reason: "Healing was cancelled by the user",
    });

    res.status(200).json({
      success: true,
      message: "Healing cancellation was accepted.",
      data: buildHealStatusData(cancelled),
    });
  } catch (error) {
    next(error);
  }
};
