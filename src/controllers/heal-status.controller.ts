import fs from "node:fs/promises";
import { NextFunction, Request, Response } from "express";
import { AppError } from "../middlewares/errorHandler";
import {
  getAnalysis,
  StoredAnalysis,
  type StoredHealResult,
} from "../services/analysis-store.service";
import {
  buildPublicHealResult,
  resolveHealedOutput,
} from "../services/heal-result.service";
import { getAuthenticatedUserId } from "../middlewares/auth.middleware";
import {
  subscribeToHealingEvents,
  type HealingQueueEvent,
} from "../services/heal-event.service";
import {
  parseHealingProgress,
  type HealingProgress,
} from "../services/heal-progress.service";

export const getStoredAnalysis = async (
  jobId: unknown,
  ownerId: string,
): Promise<StoredAnalysis> => {
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
  if (analysis.ownerId !== ownerId) {
    throw new AppError(404, "Dry-run job not found", "JOB_NOT_FOUND");
  }
  return analysis;
};

export const buildHealStatusData = (
  analysis: StoredAnalysis,
  progressDetail: HealingProgress | null = null,
) => ({
  jobId: analysis.queueJobId ?? analysis.id,
  dryRunJobId: analysis.id,
  status: analysis.healStatus,
  progress: analysis.healProgress,
  queuedAt: analysis.queuedAt,
  startedAt: analysis.healStartedAt,
  completedAt: analysis.healCompletedAt,
  failedAt: analysis.healFailedAt,
  error: analysis.healError,
  progressDetail,
  result:
    analysis.healStatus === "completed"
      ? buildPublicHealResult(analysis)
      : null,
  links: {
    status: `/api/heal/${analysis.id}`,
    output: `/api/heal/${analysis.id}/output`,
    download: `/api/heal/${analysis.id}/download`,
  },
});

interface HealEventStreamDependencies {
  getOwnedAnalysis: typeof getStoredAnalysis;
  subscribe: (
    jobId: string,
    listener: (event: HealingQueueEvent) => void,
  ) => () => void;
  heartbeatMilliseconds: number;
}

const parseStoredHealResult = (value: unknown): StoredHealResult | null => {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object"
      ? (parsed as StoredHealResult)
      : null;
  } catch {
    return null;
  }
};

export const createHealEventStream = (
  dependencies: HealEventStreamDependencies = {
    getOwnedAnalysis: getStoredAnalysis,
    subscribe: subscribeToHealingEvents,
    heartbeatMilliseconds: 20_000,
  },
) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let analysis: StoredAnalysis;
    const ownerId = getAuthenticatedUserId(req);
    try {
      analysis = await dependencies.getOwnedAnalysis(
        req.params.jobId,
        ownerId,
      );
    } catch (error) {
      next(error);
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write("retry: 2000\n\n");

    let eventId = 0;
    let closed = false;
    let unsubscribe: () => void = () => undefined;
    let eventChain = Promise.resolve();

    const writeEvent = (event: string, data: unknown): void => {
      if (closed) return;
      eventId += 1;
      res.write(`id: ${eventId}\n`);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };

    const heartbeat = setInterval(() => {
      if (!closed) res.write(": heartbeat\n\n");
    }, dependencies.heartbeatMilliseconds);
    heartbeat.unref();

    const currentAnalysis = async (): Promise<StoredAnalysis> => {
      const latest = await dependencies.getOwnedAnalysis(
        analysis.id,
        ownerId,
      );
      analysis = latest;
      return latest;
    };

    const forwardEvent = async (event: HealingQueueEvent): Promise<void> => {
      if (closed) return;
      if (event.type === "active") {
        const latest = await currentAnalysis();
        analysis = {
          ...latest,
          healStatus: "processing",
          healProgress: Math.max(1, latest.healProgress),
        };
        writeEvent("progress", buildHealStatusData(analysis));
        return;
      }

      if (event.type === "progress") {
        const detail = parseHealingProgress(event.data);
        const numericProgress =
          detail?.value ??
          (typeof event.data === "number" && Number.isFinite(event.data)
            ? Math.max(0, Math.min(100, event.data))
            : analysis.healProgress);
        analysis = {
          ...(await currentAnalysis()),
          healStatus: "processing",
          healProgress: numericProgress,
        };
        writeEvent("progress", buildHealStatusData(analysis, detail));
        return;
      }

      if (event.type === "completed") {
        const latest = await currentAnalysis();
        const result = parseStoredHealResult(event.result) ?? latest.healResult;
        if (!result) throw new Error("Completed healing result is unavailable");
        analysis = {
          ...latest,
          healStatus: "completed",
          healProgress: 100,
          healCompletedAt: latest.healCompletedAt ?? new Date().toISOString(),
          healResult: result,
          healError: null,
        };
        writeEvent("completed", buildHealStatusData(analysis));
        close();
        return;
      }

      const latest = await currentAnalysis();
      analysis = {
        ...latest,
        healStatus: "failed",
        healFailedAt: latest.healFailedAt ?? new Date().toISOString(),
        healError: event.reason || "Healing failed",
      };
      writeEvent("failed", buildHealStatusData(analysis));
      close();
    };

    req.once("close", close);
    writeEvent("snapshot", buildHealStatusData(analysis));
    if (analysis.healStatus === "completed" || analysis.healStatus === "failed") {
      close();
      return;
    }

    unsubscribe = dependencies.subscribe(analysis.id, (event) => {
      eventChain = eventChain
        .then(() => forwardEvent(event))
        .catch((error) => {
          console.error(
            `Could not forward healing event for ${analysis.id}:`,
            error,
          );
          writeEvent("stream-error", {
            message: "Healing status is temporarily unavailable",
          });
          close();
        });
    });

    // Close the read/subscribe race: the job may have reached a terminal
    // state after the initial snapshot but just before the QueueEvents
    // listener was attached.
    eventChain = eventChain
      .then(async () => {
        const latest = await currentAnalysis();
        if (closed || latest.healStatus === "queued") return;
        if (latest.healStatus === "completed") {
          writeEvent("completed", buildHealStatusData(latest));
          close();
          return;
        }
        if (latest.healStatus === "failed") {
          writeEvent("failed", buildHealStatusData(latest));
          close();
        }
      })
      .catch((error) => {
        console.error(`Could not reconcile healing stream ${analysis.id}:`, error);
        writeEvent("stream-error", {
          message: "Healing status is temporarily unavailable",
        });
        close();
      });
  };

export const streamHealEvents = createHealEventStream();

export const getHealStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const analysis = await getStoredAnalysis(
      req.params.jobId,
      getAuthenticatedUserId(req),
    );
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
  ownerId: string,
): Promise<{ filePath: string; fileName: string }> => {
  const analysis = await getStoredAnalysis(jobId, ownerId);
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
    const output = await getCompletedOutput(
      req.params.jobId,
      getAuthenticatedUserId(req),
    );
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
    const output = await getCompletedOutput(
      req.params.jobId,
      getAuthenticatedUserId(req),
    );
    res.download(output.filePath, output.fileName, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    next(error);
  }
};
