import {
  SliverDetectionResult,
  SliverRepairFailureReason,
  SliverValidationReport,
} from "./types";
import { sliverFindingKey } from "./repair";

export const buildSliverReport = (
  detection: SliverDetectionResult,
  appliedSliverAreaThresholdM2: number,
  removedKeys: Set<string> = new Set(),
  absorbedIntoFeatureIndexes: ReadonlyMap<string, number> = new Map(),
  failedReasons: ReadonlyMap<string, SliverRepairFailureReason> = new Map(),
): SliverValidationReport => {
  const issues = detection.findings.map((finding) => {
    const key = sliverFindingKey(finding);
    const removed = removedKeys.has(key);
    const absorbed = absorbedIntoFeatureIndexes.has(key);
    const repairFailureReason = failedReasons.get(key) ?? null;
    return {
      ...finding,
      status: absorbed
        ? ("Absorbed" as const)
        : removed
          ? ("Removed" as const)
          : ("Unresolved" as const),
      recommendedAction: removed
        ? ("None" as const)
        : finding.repairable && repairFailureReason === null
          ? ("AutoRepair" as const)
          : ("ManualReview" as const),
      repairFailureReason,
    };
  });
  const unresolved = issues.filter((issue) => issue.status === "Unresolved");
  return {
    valid: unresolved.length === 0,
    polygonFeaturesScanned: detection.polygonFeaturesScanned,
    sliversFound: detection.findings.length,
    sliversRemoved: removedKeys.size,
    sliversAbsorbed: absorbedIntoFeatureIndexes.size,
    sliversDeleted: removedKeys.size - absorbedIntoFeatureIndexes.size,
    unresolvedSlivers: unresolved.length,
    unresolvedIssues: unresolved.length,
    unresolvedFeatureIndexes: [
      ...new Set(unresolved.map((finding) => finding.featureIndex)),
    ].sort((first, second) => first - second),
    appliedSliverAreaThresholdM2,
    issues,
  };
};
