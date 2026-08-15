import fs from "node:fs/promises";
import { NextFunction, Request, Response } from "express";
import { AppError } from "../middlewares/errorHandler";
import {
  getAnalysis,
  StoredAnalysis,
} from "../services/analysis-store.service";
import {
  buildPublicHealResult,
  resolveHealedOutput,
} from "../services/heal-result.service";

const getStoredAnalysis = async (jobId: unknown): Promise<StoredAnalysis> => {
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new AppError(400, "A job ID is required", "JOB_ID_REQUIRED");
  }
  let analysis: StoredAnalysis | null;
  try {
    analysis = await getAnalysis(jobId);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new AppError(400, "Invalid job ID", "INVALID_JOB_ID");
    }
    throw error;
  }
  if (!analysis) {
    throw new AppError(404, "Dry-run job not found", "JOB_NOT_FOUND");
  }
  return analysis;
};

export const buildHealStatusData = (analysis: StoredAnalysis) => ({
  jobId: analysis.queueJobId ?? analysis.id,
  dryRunJobId: analysis.id,
  status: analysis.healStatus,
  progress: analysis.healProgress,
  queuedAt: analysis.queuedAt,
  startedAt: analysis.healStartedAt,
  completedAt: analysis.healCompletedAt,
  failedAt: analysis.healFailedAt,
  error: analysis.healError,
  result:
    analysis.healStatus === "completed"
      ? buildPublicHealResult(analysis)
      : null,
  links: {
    status: `/heal/${analysis.id}`,
    output: `/heal/${analysis.id}/output`,
    download: `/heal/${analysis.id}/download`,
  },
});

export const getHealStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const analysis = await getStoredAnalysis(req.params.jobId);
    res.status(200).json({
      success: true,
      data: buildHealStatusData(analysis),
    });
  } catch (error) {
    next(error);
  }
};

const getCompletedOutput = async (
  jobId: unknown,
): Promise<{ filePath: string; fileName: string }> => {
  const analysis = await getStoredAnalysis(jobId);
  if (analysis.healStatus !== "completed") {
    throw new AppError(
      409,
      "Healing has not completed",
      "HEALING_NOT_COMPLETE",
    );
  }
  const output = resolveHealedOutput(analysis);
  if (!output) {
    throw new AppError(
      500,
      "The completed job has no valid output file",
      "OUTPUT_NOT_AVAILABLE",
    );
  }
  try {
    await fs.access(output.filePath);
  } catch {
    throw new AppError(
      410,
      "The healed output file is no longer available",
      "OUTPUT_FILE_EXPIRED",
    );
  }
  return output;
};

export const previewHealedOutput = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const output = await getCompletedOutput(req.params.jobId);
    res.type("application/geo+json");
    res.sendFile(output.filePath);
  } catch (error) {
    next(error);
  }
};

export const downloadHealedOutput = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const output = await getCompletedOutput(req.params.jobId);
    res.download(output.filePath, output.fileName, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    next(error);
  }
};
