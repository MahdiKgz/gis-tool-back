import fs from "node:fs/promises";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { getAuthenticatedUserId } from "../middlewares/auth.middleware";
import { AppError } from "../middlewares/errorHandler";
import {
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
  const output = conversionOutput(task);
  await fs.access(output).catch(() => {
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
  await new Promise<void>((resolve, reject) =>
    res.download(output, path.basename(output), (error) =>
      error ? reject(error) : resolve(),
    ),
  );
};

export const createConversionHandlers = (deps: Dependencies = dependencies) => {
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
      if (req.file.size > SYNC_CONVERSION_BYTES) {
        await deps.enqueue(task);
        queued = true;
        res
          .status(202)
          .json({ success: true, data: { jobId: task.id, status: "queued" } });
      } else {
        const result = await deps.convert(task, abort.signal);
        await sendOutput(res, task, result);
      }
    } catch (error) {
      if (!res.headersSent) next(error);
    } finally {
      res.off("close", onClose);
      if (!queued && directory)
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
  return { upload, status, download };
};
