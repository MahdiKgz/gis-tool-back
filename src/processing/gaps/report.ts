import { GapDetectionResult, GapValidationReport } from "./types";
import { gapFindingKey } from "./repair";

export const buildGapReport = (
  detection: GapDetectionResult,
  appliedGapToleranceMeters: number,
  appliedMinimumGapWidthMeters = 0,
  repairedKeys: Set<string> = new Set(),
): GapValidationReport => {
  const issues = detection.findings.map((finding) => {
    const repaired = repairedKeys.has(gapFindingKey(finding));
    return {
      ...finding,
      status: repaired ? ("Repaired" as const) : ("Unresolved" as const),
      recommendedAction: repaired
        ? ("None" as const)
        : finding.repairable
          ? ("AutoRepair" as const)
          : ("ManualReview" as const),
    };
  });
  const unresolved = issues.filter((issue) => issue.status === "Unresolved");
  const affectedFeatureIndexes = unresolved.flatMap((finding) => [
    finding.featureIndex,
    finding.relatedFeatureIndex,
  ]);
  return {
    valid: unresolved.length === 0,
    polygonComponentsScanned: detection.polygonComponentsScanned,
    candidatePairsChecked: detection.candidatePairsChecked,
    gapsFound: detection.findings.length,
    gapsRepaired: repairedKeys.size,
    unresolvedIssues: unresolved.length,
    unresolvedFeatureIndexes: [...new Set(affectedFeatureIndexes)].sort(
      (first, second) => first - second,
    ),
    appliedGapToleranceMeters,
    appliedMinimumGapWidthMeters,
    issues,
  };
};
