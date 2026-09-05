import path from "node:path";
import { StoredAnalysis, StoredHealResult } from "./analysis-store.service";

const CLEANED_OUTPUT_DIRECTORY = path.resolve("uploads/cleaned_files");

const REPAIR_COUNT_KEYS = [
  "duplicateVerticesRemoved",
  "invalidRingsRepaired",
  "ringsAutoClosed",
  "holesRemoved",
  "spikesRemoved",
  "selfIntersectionsRepaired",
  "undershootsRepaired",
  "overshootsRepaired",
  "gapsClosed",
  "overlapsHealed",
  "exactDuplicates",
  "sliversRemovedCount",
] as const;

const numericResultValue = (
  result: StoredHealResult,
  key: string,
): number => {
  const value = result[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

export const countAppliedRepairs = (result: StoredHealResult): number =>
  REPAIR_COUNT_KEYS.reduce(
    (total, key) => total + numericResultValue(result, key),
    0,
  );

export const buildPublicHealResult = (
  analysis: StoredAnalysis,
): Record<string, unknown> | null => {
  const result = analysis.healResult;
  if (!result) return null;
  const repairs = Object.fromEntries(
    REPAIR_COUNT_KEYS.map((key) => [key, numericResultValue(result, key)]),
  );
  const outputFileName =
    typeof result.outputFileName === "string"
      ? path.basename(result.outputFileName)
      : null;

  return {
    repairsApplied: countAppliedRepairs(result),
    repairs,
    originalSizeInBytes: numericResultValue(result, "originalSizeInBytes"),
    optimizedSizeInBytes: numericResultValue(result, "optimizedSizeInBytes"),
    output: outputFileName
      ? {
          fileName: outputFileName,
          previewPath: `/api/heal/${analysis.id}/output`,
          downloadPath: `/api/heal/${analysis.id}/download`,
        }
      : null,
  };
};

export const resolveHealedOutput = (
  analysis: StoredAnalysis,
): { filePath: string; fileName: string } | null => {
  const result = analysis.healResult;
  if (!result || typeof result.outputFilePath !== "string") return null;
  const filePath = path.resolve(result.outputFilePath);
  const relativePath = path.relative(CLEANED_OUTPUT_DIRECTORY, filePath);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  return {
    filePath,
    fileName:
      typeof result.outputFileName === "string"
        ? path.basename(result.outputFileName)
        : path.basename(filePath),
  };
};
