import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DryRunReport } from "./dry-run.service";
import { GisJobData } from "../types/gis-job";

export type HealStatus =
  | "dry-run-complete"
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export interface StoredHealResult extends Record<string, unknown> {
  outputFileName?: string;
  outputFilePath?: string;
}

export interface StoredAnalysis {
  id: string;
  createdAt: string;
  queuedAt: string | null;
  queueJobId: string | null;
  healStatus: HealStatus;
  healProgress: number;
  healStartedAt: string | null;
  healCompletedAt: string | null;
  healFailedAt: string | null;
  healResult: StoredHealResult | null;
  healError: string | null;
  jobData: GisJobData;
  report: DryRunReport;
}

const DEFAULT_STORE_DIRECTORY = path.resolve("uploads/gis_analyses");
const ANALYSIS_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const updateLocks = new Map<string, Promise<void>>();

const analysisPath = (id: string, storeDirectory: string): string => {
  if (!ANALYSIS_ID_PATTERN.test(id)) {
    throw new TypeError("Invalid analysis ID");
  }
  return path.join(storeDirectory, `${id}.json`);
};

const normalizeRecord = (record: StoredAnalysis): StoredAnalysis => ({
  ...record,
  healStatus:
    record.healStatus ??
    (record.queueJobId === null ? "dry-run-complete" : "queued"),
  healProgress: Number.isFinite(record.healProgress)
    ? Math.max(0, Math.min(100, record.healProgress))
    : 0,
  healStartedAt: record.healStartedAt ?? null,
  healCompletedAt: record.healCompletedAt ?? null,
  healFailedAt: record.healFailedAt ?? null,
  healResult: record.healResult ?? null,
  healError: record.healError ?? null,
});

const writeAnalysis = async (
  record: StoredAnalysis,
  storeDirectory: string,
): Promise<void> => {
  const targetPath = analysisPath(record.id, storeDirectory);
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(record), "utf8");
  await fs.rename(temporaryPath, targetPath);
};

const withAnalysisLock = async <T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const previous = updateLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  updateLocks.set(id, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (updateLocks.get(id) === tail) updateLocks.delete(id);
  }
};

const updateAnalysis = async (
  id: string,
  update: (current: StoredAnalysis) => StoredAnalysis,
  storeDirectory: string,
): Promise<StoredAnalysis | null> =>
  withAnalysisLock(id, async () => {
    const current = await getAnalysis(id, storeDirectory);
    if (!current) return null;
    const updated = normalizeRecord(update(current));
    await writeAnalysis(updated, storeDirectory);
    return updated;
  });

export const saveAnalysis = async (
  jobData: GisJobData,
  report: DryRunReport,
  storeDirectory = DEFAULT_STORE_DIRECTORY,
): Promise<StoredAnalysis> => {
  const record: StoredAnalysis = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    queuedAt: null,
    queueJobId: null,
    healStatus: "dry-run-complete",
    healProgress: 0,
    healStartedAt: null,
    healCompletedAt: null,
    healFailedAt: null,
    healResult: null,
    healError: null,
    jobData,
    report,
  };
  await fs.mkdir(storeDirectory, { recursive: true });
  await fs.writeFile(
    analysisPath(record.id, storeDirectory),
    JSON.stringify(record),
    { encoding: "utf8", flag: "wx" },
  );
  return record;
};

export const getAnalysis = async (
  id: string,
  storeDirectory = DEFAULT_STORE_DIRECTORY,
): Promise<StoredAnalysis | null> => {
  let contents: string;
  try {
    contents = await fs.readFile(analysisPath(id, storeDirectory), "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
  return normalizeRecord(JSON.parse(contents) as StoredAnalysis);
};

export const markAnalysisQueued = async (
  record: StoredAnalysis,
  queueJobId: string,
  storeDirectory = DEFAULT_STORE_DIRECTORY,
): Promise<StoredAnalysis> => {
  const updated = await updateAnalysis(
    record.id,
    (current) => ({
      ...current,
      queuedAt: current.queuedAt ?? new Date().toISOString(),
      queueJobId,
      healStatus:
        current.healStatus === "dry-run-complete"
          ? "queued"
          : current.healStatus,
      healError: null,
      healFailedAt: null,
    }),
    storeDirectory,
  );
  if (!updated) throw new Error(`Analysis ${record.id} no longer exists`);
  return updated;
};

export const resetAnalysisQueueRequest = async (
  id: string,
  storeDirectory = DEFAULT_STORE_DIRECTORY,
): Promise<StoredAnalysis | null> =>
  updateAnalysis(
    id,
    (current) =>
      current.healStatus !== "queued" && current.healStatus !== "failed"
        ? current
        : {
            ...current,
            queuedAt: null,
            queueJobId: null,
            healStatus: "dry-run-complete",
            healProgress: 0,
            healStartedAt: null,
            healCompletedAt: null,
            healFailedAt: null,
            healResult: null,
            healError: null,
          },
    storeDirectory,
  );

export const markAnalysisProcessing = async (
  id: string,
  storeDirectory = DEFAULT_STORE_DIRECTORY,
): Promise<StoredAnalysis | null> =>
  updateAnalysis(
    id,
    (current) =>
      current.healStatus === "completed"
        ? current
        : {
            ...current,
            healStatus: "processing",
            healStartedAt: current.healStartedAt ?? new Date().toISOString(),
            healProgress: Math.max(current.healProgress, 1),
            healError: null,
            healFailedAt: null,
          },
    storeDirectory,
  );

export const markAnalysisProgress = async (
  id: string,
  progress: number,
  storeDirectory = DEFAULT_STORE_DIRECTORY,
): Promise<StoredAnalysis | null> => {
  const normalizedProgress = Number.isFinite(progress)
    ? Math.max(0, Math.min(100, progress))
    : 0;
  return updateAnalysis(
    id,
    (current) =>
      current.healStatus === "completed" || current.healStatus === "failed"
        ? current
        : {
            ...current,
            healStatus: "processing",
            healStartedAt: current.healStartedAt ?? new Date().toISOString(),
            healProgress: Math.max(current.healProgress, normalizedProgress),
          },
    storeDirectory,
  );
};

export const markAnalysisCompleted = async (
  id: string,
  result: StoredHealResult,
  storeDirectory = DEFAULT_STORE_DIRECTORY,
): Promise<StoredAnalysis | null> =>
  updateAnalysis(
    id,
    (current) => ({
      ...current,
      healStatus: "completed",
      healProgress: 100,
      healStartedAt: current.healStartedAt ?? new Date().toISOString(),
      healCompletedAt: new Date().toISOString(),
      healFailedAt: null,
      healResult: result,
      healError: null,
    }),
    storeDirectory,
  );

export const markAnalysisFailed = async (
  id: string,
  message: string,
  storeDirectory = DEFAULT_STORE_DIRECTORY,
): Promise<StoredAnalysis | null> =>
  updateAnalysis(
    id,
    (current) =>
      current.healStatus === "completed"
        ? current
        : {
            ...current,
            healStatus: "failed",
            healFailedAt: new Date().toISOString(),
            healError: message,
          },
    storeDirectory,
  );
