import { objectStorageEnabled, isObjectReference, storedStat, copyStoredFile, materializeStoredFile, putStoredFile } from "../services/object-storage.service";
import { conversionObjectKey, conversionStoredOutput } from "../services/conversion.service";
import { getStoredAnalysis } from "./heal-status.controller";
import { resolveHealedOutput } from "../services/heal-result.service";
import fs from "node:fs/promises";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { getAuthenticatedUserId } from "../middlewares/auth.middleware";
import { AppError } from "../middlewares/errorHandler";
import {
  createConversionDirectory,
  MAX_CONVERSION_MB,
  ConversionResult,
  ConversionTask,
  CONVERSION_RETENTION_SECONDS,
  conversionOutput,
  parseConversionOptions,
  removeConversion,
  runConversion,
  SYNC_CONVERSION_BYTES,
} from "../services/conversion.service";

export interface ConversionJobView {
  data: ConversionTask;
  state: string;
  expiresAt?: number;
  result?: ConversionResult;
  error?: { code: string; message: string };
}
interface Dependencies {
  getOwnedAnalysis?: typeof getStoredAnalysis;
  convert: typeof runConversion;
  enqueue: (task: ConversionTask) => Promise<void>;
  getJob: (id: string) => Promise<ConversionJobView | null>;
}
const dependencies: Dependencies = {
  convert: runConversion,
  enqueue: async (task) => {
    const { conversionQueue } =
      await import("../services/conversion-queue.service");
    const { redisConnection } = await import("../services/queue.service");
    if (redisConnection.status !== "ready") {
      throw new AppError(
        503,
        "The conversion queue is unavailable. Try again shortly.",
        "CONVERSION_QUEUE_UNAVAILABLE",
      );
    }
    await conversionQueue.add("convert", task, { jobId: task.id });
  },
  getJob: async (id) => {
    const { conversionQueue } =
      await import("../services/conversion-queue.service");
    const job = await conversionQueue.getJob(id);
    if (!job) return null;
    return {
      data: job.data,
      state: await job.getState(),
      expiresAt:
        (job.finishedOn ?? job.timestamp) + CONVERSION_RETENTION_SECONDS * 1000,
      ...job.returnvalue,
    };
  },
};
const sendOutput = async (
  res: Response,
  task: ConversionTask,
  result: ConversionResult,
) => {
  const reference = isObjectReference(task.source) ? conversionStoredOutput(task) : conversionOutput(task);
  await storedStat(reference).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new AppError(
      410,
      "The converted file has expired.",
      "CONVERSION_EXPIRED",
    );
  });
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "X-Conversion-Result",
    encodeURIComponent(JSON.stringify(result)),
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Disposition, X-Conversion-Result",
  );
  const local = await materializeStoredFile(reference, path.basename(conversionOutput(task)));
  try {
    await new Promise<void>((resolve, reject) =>
      res.download(local.filePath, path.basename(local.filePath), error => error ? reject(error) : resolve()));
  } finally { await local.cleanup(); }
};

export const createConversionHandlers = (deps: Dependencies = dependencies) => {
  const execute = async (
    task: ConversionTask,
    size: number,
    res: Response,
    signal: AbortSignal,
    markQueued: () => void,
  ) => {
    if (signal.aborted) throw new Error("Export request cancelled");
    if (size > SYNC_CONVERSION_BYTES) {
      if (objectStorageEnabled()) {
        task.source = await putStoredFile(conversionObjectKey(task, path.basename(task.source)), task.source);
        task.directory = ''; // Queue payloads contain object references, never a machine-local workspace.
      }
      await deps.enqueue(task);
      markQueued();
      res
        .status(202)
        .json({ success: true, data: { jobId: task.id, status: "queued" } });
      return true;
    }
    const result = await deps.convert(task, signal);
    await sendOutput(res, task, result);
    return false;
  };
  const exportHealed = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    let directory: string | undefined;
    let queued = false;
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) abort.abort();
    };
    res.once("close", onClose);
    try {
      const userId = getAuthenticatedUserId(req);
      const analysis = await (deps.getOwnedAnalysis ?? getStoredAnalysis)(
        req.params.jobId,
        userId,
      );
      if (analysis.healStatus !== "completed")
        throw new AppError(
          409,
          "The healed output is not ready.",
          "CONVERSION_NOT_READY",
        );
      const output = resolveHealedOutput(analysis);
      if (!output)
        throw new AppError(
          410,
          "The healed output is unavailable.",
          "CONVERSION_EXPIRED",
        );
      // Healing outputs are normalized WGS84; never relabel their coordinates using a user-supplied CRS.
      if (
        req.body?.sourceCRS &&
        String(req.body.sourceCRS).trim().toUpperCase() !== "EPSG:4326"
      )
        throw new AppError(
          400,
          "Healed output source CRS is EPSG:4326.",
          "INVALID_SOURCE_CRS",
        );
      const options = parseConversionOptions("output.geojson", {
        ...req.body,
        sourceCRS: "EPSG:4326",
      });
      const info = await storedStat(output.filePath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw new AppError(
          410,
          "The healed output has expired.",
          "CONVERSION_EXPIRED",
        );
      });
      if (!info.isFile() || info.size > MAX_CONVERSION_MB * 1024 * 1024)
        throw new AppError(
          413,
          "The output exceeds conversion capacity.",
          "CONVERSION_LIMIT_EXCEEDED",
        );
      const created = await createConversionDirectory();
      directory = created.directory;
      const source = path.join(directory, "input.geojson");
      await copyStoredFile(output.filePath, source, MAX_CONVERSION_MB * 1024 * 1024);
      const task: ConversionTask = { ...options, ...created, source, userId };
      await execute(task, info.size, res, abort.signal, () => {
        queued = true;
      });
    } catch (error) {
      if (!res.headersSent) next(error);
    } finally {
      res.off("close", onClose);
      if ((!queued || objectStorageEnabled()) && directory)
        await removeConversion(directory).catch(() => {});
    }
  };
  const upload = async (req: Request, res: Response, next: NextFunction) => {
    let queued = false;
    const directory = req.file ? path.dirname(req.file.path) : undefined;
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) abort.abort();
    };
    res.once("close", onClose);
    try {
      if (!req.file) throw new AppError(400, "Upload a file.", "FILE_REQUIRED");
      const userId = getAuthenticatedUserId(req);
      const options = parseConversionOptions(
        req.file.originalname,
        req.body ?? {},
      );
      const task: ConversionTask = {
        ...options,
        id: path.basename(directory!),
        directory: directory!,
        userId,
        source: path.resolve(req.file.path),
      };
      await execute(task, req.file.size, res, abort.signal, () => {
        queued = true;
      });
    } catch (error) {
      if (!res.headersSent) next(error);
    } finally {
      res.off("close", onClose);
      if ((!queued || objectStorageEnabled()) && directory)
        await removeConversion(directory).catch(() => {});
    }
  };
  const ownedJob = async (req: Request) => {
    const id = req.params.id;
    if (
      typeof id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        id,
      )
    )
      throw new AppError(404, "Conversion not found.", "CONVERSION_NOT_FOUND");
    const userId = getAuthenticatedUserId(req);
    const job = await deps.getJob(id);
    if (!job || job.data.userId !== userId)
      throw new AppError(404, "Conversion not found.", "CONVERSION_NOT_FOUND");
    if (job.expiresAt && Date.now() >= job.expiresAt)
      throw new AppError(
        410,
        "The conversion has expired.",
        "CONVERSION_EXPIRED",
      );
    return job;
  };
  const status = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await ownedJob(req);
      res.setHeader("Cache-Control", "no-store");
      const failed = job.error || job.state === "failed";
      res.json({
        success: true,
        data: {
          jobId: job.data.id,
          status: failed
            ? "failed"
            : job.state === "completed"
              ? "completed"
              : "processing",
          ...(failed
            ? {
                error: job.error ?? {
                  code: "CONVERSION_FAILED",
                  message: "Conversion failed.",
                },
              }
            : {}),
          ...(job.result && !failed ? { result: job.result } : {}),
        },
      });
    } catch (error) {
      next(error);
    }
  };
  const download = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await ownedJob(req);
      if (job.state !== "completed" || !job.result || job.error)
        throw new AppError(
          409,
          "The converted file is not ready.",
          "CONVERSION_NOT_READY",
        );
      await sendOutput(res, job.data, job.result);
    } catch (error) {
      if (!res.headersSent) next(error);
    }
  };
  return { upload, status, download, exportHealed };
};
