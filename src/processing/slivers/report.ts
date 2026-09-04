import { SliverDetectionResult, SliverValidationReport } from "./types";
import { sliverFindingKey } from "./repair";

export const buildSliverReport = (
  detection: SliverDetectionResult,
  appliedSliverAreaThresholdM2: number,
  removedKeys: Set<string> = new Set(),
): SliverValidationReport => {
  const issues = detection.findings.map((finding) => {
    const removed = removedKeys.has(sliverFindingKey(finding));
    return {
      ...finding,
      status: removed ? ("Removed" as const) : ("Unresolved" as const),
      recommendedAction: removed
        ? ("None" as const)
        : finding.repairable
          ? ("AutoRepair" as const)
          : ("ManualReview" as const),
    };
  });
  const unresolved = issues.filter((issue) => issue.status === "Unresolved");
  return {
    valid: unresolved.length === 0,
    polygonFeaturesScanned: detection.polygonFeaturesScanned,
    sliversFound: detection.findings.length,
    sliversRemoved: removedKeys.size,
    unresolvedSlivers: unresolved.length,
    unresolvedIssues: unresolved.length,
    unresolvedFeatureIndexes: [
      ...new Set(unresolved.map((finding) => finding.featureIndex)),
    ].sort((first, second) => first - second),
    appliedSliverAreaThresholdM2,
    issues,
  };
};
