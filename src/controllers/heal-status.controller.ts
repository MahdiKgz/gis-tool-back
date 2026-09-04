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
  getHealingEventsAfter,
  storeHealingEvent,
  subscribeToHealingEvents,
  type HealingQueueEvent,
  type HealingQueueEventPayload,
} from "../services/heal-event.service";
import {
  parseHealingProgress,
  type HealingProgress,
} from "../services/heal-progress.service";
import { readGisFile } from "../services/gis-file.service";
import {
  saveManualReviewDecision,
  type ManualReviewAction,
} from "../services/analysis-store.service";

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
    original: `/api/heal/${analysis.id}/original`,
    output: `/api/heal/${analysis.id}/output`,
    download: `/api/heal/${analysis.id}/download`,
    cancel: `/api/heal/${analysis.id}/cancel`,
  },
});

interface HealEventStreamDependencies {
  getOwnedAnalysis: typeof getStoredAnalysis;
  subscribe: (
    jobId: string,
    listener: (event: HealingQueueEvent) => void,
  ) => () => void;
  replay?: (jobId: string, lastEventId: string) => Promise<HealingQueueEvent[]>;
  store?: (
    jobId: string,
    event: HealingQueueEventPayload,
  ) => Promise<HealingQueueEvent>;
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

export const createHealEventStream =
  (
    dependencies: HealEventStreamDependencies = {
      getOwnedAnalysis: getStoredAnalysis,
      subscribe: subscribeToHealingEvents,
      replay: getHealingEventsAfter,
      store: storeHealingEvent,
      heartbeatMilliseconds: 20_000,
    },
  ) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let analysis: StoredAnalysis;
    const ownerId = getAuthenticatedUserId(req);
    try {
      analysis = await dependencies.getOwnedAnalysis(req.params.jobId, ownerId);
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

    let localEventId = 0;
    let closed = false;
    let unsubscribe: () => void = () => undefined;
    let eventChain = Promise.resolve();

    const writeEvent = (id: string, event: string, data: unknown): void => {
      if (closed) return;
      res.write(`id: ${id}\n`);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const storeEvent = async (
      event: HealingQueueEventPayload,
    ): Promise<HealingQueueEvent> => {
      if (dependencies.store) return dependencies.store(analysis.id, event);
      localEventId += 1;
      return { ...event, id: String(localEventId) } as HealingQueueEvent;
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
      const latest = await dependencies.getOwnedAnalysis(analysis.id, ownerId);
      analysis = latest;
      return latest;
    };

    const forwardEvent = async (event: HealingQueueEvent): Promise<void> => {
      if (closed) return;
      if (event.type === "snapshot") {
        writeEvent(event.id, "snapshot", event.data);
        return;
      }
      if (event.type === "active") {
        const latest = await currentAnalysis();
        analysis = {
          ...latest,
          healStatus: "processing",
          healProgress: Math.max(1, latest.healProgress),
        };
        writeEvent(event.id, "progress", buildHealStatusData(analysis));
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
        writeEvent(event.id, "progress", buildHealStatusData(analysis, detail));
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
        writeEvent(event.id, "completed", buildHealStatusData(analysis));
        close();
        return;
      }

      if (event.type === "stream-error") {
        writeEvent(event.id, "stream-error", event.data);
        close();
        return;
      }

      const latest = await currentAnalysis();
      const wasCancelled =
        event.type === "cancelled" || latest.healStatus === "cancelled";
      analysis = {
        ...latest,
        healStatus: wasCancelled ? "cancelled" : "failed",
        healFailedAt: wasCancelled
          ? null
          : (latest.healFailedAt ?? new Date().toISOString()),
        healError: wasCancelled ? null : event.reason || "Healing failed",
      };
      writeEvent(
        event.id,
        wasCancelled ? "cancelled" : "failed",
        buildHealStatusData(analysis),
      );
      close();
    };

    req.once("close", close);
    unsubscribe = dependencies.subscribe(analysis.id, (event) => {
      eventChain = eventChain
        .then(() => forwardEvent(event))
        .catch((error) => {
          console.error(
            `Could not forward healing event for ${analysis.id}:`,
            error,
          );
          void storeEvent({
            type: "stream-error",
            data: { message: "Healing status is temporarily unavailable" },
          }).then(forwardEvent);
        });
    });

    const lastEventHeader =
      typeof req.get === "function"
        ? req.get("Last-Event-ID")
        : (req.headers?.["last-event-id"] as string | undefined);
    const lastEventId =
      typeof lastEventHeader === "string" && /^\d+$/.test(lastEventHeader)
        ? lastEventHeader
        : null;

    if (lastEventId && dependencies.replay) {
      const replayedEvents = await dependencies.replay(
        analysis.id,
        lastEventId,
      );
      for (const event of replayedEvents) {
        await forwardEvent(event);
        if (closed) return;
      }
    } else {
      const snapshot = await storeEvent({
        type: "snapshot",
        data: buildHealStatusData(analysis),
      });
      await forwardEvent(snapshot);
    }

    if (
      analysis.healStatus === "completed" ||
      analysis.healStatus === "failed" ||
      analysis.healStatus === "cancelled"
    ) {
      close();
      return;
    }

    // Close the read/subscribe race: the job may have reached a terminal
    // state after the initial snapshot but just before the QueueEvents
    // listener was attached.
    eventChain = eventChain
      .then(async () => {
        const latest = await currentAnalysis();
        if (closed || latest.healStatus === "queued") return;
        if (latest.healStatus === "completed") {
          await forwardEvent(
            await storeEvent({ type: "completed", result: latest.healResult }),
          );
          return;
        }
        if (latest.healStatus === "failed") {
          await forwardEvent(
            await storeEvent({
              type: "failed",
              reason: latest.healError ?? "Healing failed",
            }),
          );
          return;
        }
        if (latest.healStatus === "cancelled") {
          await forwardEvent(
            await storeEvent({
              type: "cancelled",
              reason: "Healing was cancelled by the user",
            }),
          );
        }
      })
      .catch((error) => {
        console.error(
          `Could not reconcile healing stream ${analysis.id}:`,
          error,
        );
        void storeEvent({
          type: "stream-error",
          data: { message: "Healing status is temporarily unavailable" },
        }).then(forwardEvent);
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

export const previewOriginalInput = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const analysis = await getStoredAnalysis(
      req.params.jobId,
      getAuthenticatedUserId(req),
    );
    try {
      await fs.access(analysis.jobData.filePath);
    } catch {
      throw new AppError(
        410,
        "The original input file is no longer available",
        "SOURCE_FILE_EXPIRED",
      );
    }
    const geoJson = await readGisFile(
      analysis.jobData.filePath,
      analysis.jobData.originalName,
    );
    res.type("application/geo+json").status(200).json(geoJson);
  } catch (error) {
    next(error);
  }
};

const REVIEW_ACTIONS = new Set<ManualReviewAction>([
  "approved",
  "rejected",
  "manual-edit",
]);

export const updateManualReview = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const analysis = await getStoredAnalysis(
      req.params.jobId,
      getAuthenticatedUserId(req),
    );
    const issueIndex = Number(req.params.issueIndex);
    const action = req.body?.action as ManualReviewAction;
    if (!Number.isSafeInteger(issueIndex) || issueIndex < 0) {
      throw new AppError(
        400,
        "A valid issue index is required",
        "INVALID_ISSUE_INDEX",
      );
    }
    const issue = analysis.report.issues[issueIndex];
    if (!issue) {
      throw new AppError(
        404,
        "Review issue not found",
        "REVIEW_ISSUE_NOT_FOUND",
      );
    }
    if (issue.disposition !== "ManualReview") {
      throw new AppError(
        409,
        "This issue does not require manual review",
        "ISSUE_NOT_MANUAL_REVIEW",
      );
    }
    if (!REVIEW_ACTIONS.has(action)) {
      throw new AppError(
        400,
        "A valid review action is required",
        "INVALID_REVIEW_ACTION",
      );
    }
    const updated = await saveManualReviewDecision(
      analysis.id,
      issueIndex,
      action,
    );
    if (!updated)
      throw new AppError(404, "Dry-run job not found", "JOB_NOT_FOUND");
    res.status(200).json({
      success: true,
      data: {
        issueIndex,
        decision: updated.reviewDecisions?.[String(issueIndex)] ?? null,
      },
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
