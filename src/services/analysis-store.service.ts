import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DryRunReport } from "./dry-run.service";
import { GisJobData } from "../types/gis-job";

export interface StoredAnalysis {
  id: string;
  createdAt: string;
  queuedAt: string | null;
  queueJobId: string | null;
  jobData: GisJobData;
  report: DryRunReport;
}

const DEFAULT_STORE_DIRECTORY = path.resolve("uploads/gis_analyses");
const ANALYSIS_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const analysisPath = (id: string, storeDirectory: string): string => {
  if (!ANALYSIS_ID_PATTERN.test(id)) {
    throw new TypeError("Invalid analysis ID");
  }
  return path.join(storeDirectory, `${id}.json`);
};

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
  return JSON.parse(contents) as StoredAnalysis;
};

export const markAnalysisQueued = async (
  record: StoredAnalysis,
  queueJobId: string,
  storeDirectory = DEFAULT_STORE_DIRECTORY,
): Promise<StoredAnalysis> => {
  const updated: StoredAnalysis = {
    ...record,
    queuedAt: new Date().toISOString(),
    queueJobId,
  };
  const targetPath = analysisPath(record.id, storeDirectory);
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(updated), "utf8");
  await fs.rename(temporaryPath, targetPath);
  return updated;
};
