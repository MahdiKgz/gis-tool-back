import { storedStat, isObjectReference, materializeStoredFile } from "../services/object-storage.service";
import { issuePage } from "../services/public-report.service";
import { randomUUID } from "node:crypto";
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
import { buildLinework } from "../services/linework.service";
import { readGisFile } from "../services/gis-file.service";
import {
  saveConfirmedParcelEdit,
  saveConfirmedParcelEdits,
  saveManualReviewDecision,
  type ManualReviewAction,
} from "../services/analysis-store.service";

import {
  assertParcelReviewAvailable,
  buildReviewedOutput,
  createParcelReviewReader,
  getParcelForReview,
  hasManualParcelEdits,
  isParcelType,
  manualParcelFileName,
  parcelRevision,
  validateParcelGeometry,
} from "../services/manual-parcel.service";

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
      await storedStat(analysis.jobData.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

const getReviewIssue = async (req: Request) => {
  const analysis = await getStoredAnalysis(req.params.jobId, getAuthenticatedUserId(req));
  const rawIndex = req.params.issueIndex;
  const issueIndex = Number(rawIndex);
  if (typeof rawIndex !== "string" || !/^\d+$/.test(rawIndex) || !Number.isSafeInteger(issueIndex)) {
    throw new AppError(400, "A valid issue index is required", "INVALID_ISSUE_INDEX");
  }
  const issue = analysis.report.issues[issueIndex];
  if (!issue) throw new AppError(404, "Review issue not found", "REVIEW_ISSUE_NOT_FOUND");
  if (issue.disposition !== "ManualReview") {
    throw new AppError(409, "This issue does not require manual review", "ISSUE_NOT_MANUAL_REVIEW");
  }
  return { analysis, issueIndex, issue };
};

export const getManualReviewParcel = async (req: Request, res: Response) => {
  const { analysis, issue } = await getReviewIssue(req);
  const { geometry, revision, confirmed } = await getParcelForReview(analysis, issue.featureIndex);
  res.setHeader("Cache-Control", "no-store");
  res.json({ success: true, data: { geometry, revision, confirmed } });
};

export const updateManualReview = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { analysis, issueIndex, issue } = await getReviewIssue(req);
    const action = req.body?.action as ManualReviewAction;
    if (!REVIEW_ACTIONS.has(action)) {
      throw new AppError(400, "A valid review action is required", "INVALID_REVIEW_ACTION");
    }

    let updated: StoredAnalysis | null;
    if (action === "manual-edit") {
      const assertCurrent = (current: StoredAnalysis) => {
        assertParcelReviewAvailable(current);
        if (req.body?.revision !== parcelRevision(current, issue.featureIndex)) {
          throw new AppError(409, "Reload the parcel before confirming your changes", "STALE_PARCEL_EDIT");
        }
      };
      assertCurrent(analysis);
      const currentParcel = await getParcelForReview(analysis, issue.featureIndex);
      const type = currentParcel.geometry?.type;
      if (!isParcelType(type)) {
        throw new AppError(409, "The review issue does not identify a polygon parcel", "ISSUE_NOT_PARCEL");
      }
      const geometry = validateParcelGeometry(req.body?.geometry, type);
      updated = await saveConfirmedParcelEdit(analysis.id, issueIndex, issue.featureIndex, {
        geometry,
        revision: randomUUID(),
        ...(currentParcel.legacyOutputIndex !== undefined
          ? { legacyOutputIndex: currentParcel.legacyOutputIndex }
          : {}),
      }, assertCurrent);
    } else {
      updated = await saveManualReviewDecision(analysis.id, issueIndex, action);
    }
    if (!updated) throw new AppError(404, "Dry-run job not found", "JOB_NOT_FOUND");

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

const getReviewGroup = async (req: Request) => {
  const analysis = await getStoredAnalysis(req.params.jobId, getAuthenticatedUserId(req));
  const group = analysis.report.issueGroups.find((item) => item.groupId === req.params.groupId);
  const issueIndex = group ? analysis.report.issues.findIndex((issue) =>
    issue.check === group.check && issue.code === group.code &&
    (issue.disposition === "ManualReview" || issue.code === "POLYGON_OVERLAP")) : -1;
  if (!group || issueIndex < 0) throw new AppError(404, "Manual review group not found", "REVIEW_GROUP_NOT_FOUND");
  const affected = new Set(group.affectedFeatureIndexes);
  const parcels = analysis.report.affectedFeatureCollection.features.filter((feature) =>
    affected.has(feature.snapgisFeatureIndex) && isParcelType(feature.geometry?.type));
  return { analysis, issueIndex, parcels };
};

export const getManualReviewGroup = async (req: Request, res: Response) => {
  const { analysis, parcels } = await getReviewGroup(req);
  const readParcel = createParcelReviewReader(analysis);
  const data = await Promise.all(parcels.map(async (feature) => {
    try {
      const { legacyOutputIndex: _index, ...parcel } = await readParcel(feature.snapgisFeatureIndex);
      return parcel;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "PARCEL_NOT_IN_OUTPUT") throw error;
      return { featureIndex: feature.snapgisFeatureIndex, geometry: feature.geometry,
        revision: null, confirmed: false, unavailable: true };
    }
  }));
  res.setHeader("Cache-Control", "no-store");
  res.json({ success: true, data });
};

export const updateManualReviewGroup = async (req: Request, res: Response) => {
  const { analysis, issueIndex, parcels } = await getReviewGroup(req);
  const allowed = new Set(parcels.map((feature) => feature.snapgisFeatureIndex));
  const items: unknown = req.body?.edits;
  if (!Array.isArray(items) || !items.length || items.length > allowed.size ||
      items.some((item) => !allowed.has(item?.featureIndex) || typeof item?.revision !== "string") ||
      new Set(items.map((item) => item.featureIndex)).size !== items.length) {
    throw new AppError(400, "Invalid parcel edits", "INVALID_PARCEL_EDITS");
  }
  const assertCurrent = (current: StoredAnalysis) => {
    assertParcelReviewAvailable(current);
    if (items.some((item) => item.revision !== parcelRevision(current, item.featureIndex))) {
      throw new AppError(409, "Reload the group before confirming your changes", "STALE_PARCEL_EDIT");
    }
  };
  assertCurrent(analysis);
  const readParcel = createParcelReviewReader(analysis);
  const edits = Object.fromEntries(await Promise.all(items.map(async (item) => {
    const current = await readParcel(item.featureIndex);
    const type = current.geometry?.type;
    if (!isParcelType(type)) throw new AppError(409, "The review issue does not identify a polygon parcel", "ISSUE_NOT_PARCEL");
    return [item.featureIndex, {
      geometry: validateParcelGeometry(item.geometry, type),
      revision: randomUUID(),
      ...(current.legacyOutputIndex === undefined ? {} : { legacyOutputIndex: current.legacyOutputIndex }),
    }];
  })));
  const updated = await saveConfirmedParcelEdits(analysis.id, issueIndex, edits, assertCurrent);
  if (!updated) throw new AppError(404, "Dry-run job not found", "JOB_NOT_FOUND");
  res.json({ success: true, data: { featureIndexes: Object.keys(edits).map(Number) } });
};

const getCompletedOutput = async (
  analysis: StoredAnalysis,
): Promise<{ filePath: string; fileName: string }> => {
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
    await storedStat(output.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    const analysis = await getStoredAnalysis(req.params.jobId, getAuthenticatedUserId(req));
    res.setHeader("Cache-Control", "no-store");
    if (hasManualParcelEdits(analysis)) {
      const data = await buildReviewedOutput(analysis);
      res.type("application/geo+json").json(data);
      return;
    }
    const output = await getCompletedOutput(analysis);
    res.type("application/geo+json");
    if (isObjectReference(output.filePath)) {
      // Map fetches must stay on the authenticated API origin. Redirecting to
      // storage makes rendering depend on its public endpoint and CORS policy.
      const local = await materializeStoredFile(output.filePath, output.fileName);
      try {
        await new Promise<void>((resolve, reject) => {
          res.sendFile(local.filePath, (error) => error ? reject(error) : resolve());
        });
      } finally {
        await local.cleanup();
      }
      return;
    }
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
    const analysis = await getStoredAnalysis(req.params.jobId, getAuthenticatedUserId(req));
    res.setHeader("Cache-Control", "no-store");
    if (!hasManualParcelEdits(analysis)) await getCompletedOutput(analysis);
    const data = buildLinework(await buildReviewedOutput(analysis));
    res.attachment(manualParcelFileName(analysis)).type("application/geo+json").json(data);
  } catch (error) {
    next(error);
  }
};

export const getAnalysisIssues = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const analysis = await getStoredAnalysis(req.params.jobId, getAuthenticatedUserId(req));
    res.json({ success: true, data: issuePage(analysis.report, req.query) });
  } catch (error) { next(error); }
};
