import { GapDetectionResult, GapValidationReport } from "./types";

export const buildGapReport = (
  detection: GapDetectionResult,
  appliedGapToleranceMeters: number,
): GapValidationReport => {
  const affectedFeatureIndexes = detection.findings.flatMap((finding) => [
    finding.featureIndex,
    finding.relatedFeatureIndex,
  ]);
  return {
    valid: detection.findings.length === 0,
    polygonComponentsScanned: detection.polygonComponentsScanned,
    candidatePairsChecked: detection.candidatePairsChecked,
    gapsFound: detection.findings.length,
    unresolvedIssues: detection.findings.length,
    unresolvedFeatureIndexes: [...new Set(affectedFeatureIndexes)].sort(
      (first, second) => first - second,
    ),
    appliedGapToleranceMeters,
    issues: detection.findings.map((finding) => ({
      ...finding,
      status: "Unresolved",
      recommendedAction: "AutoRepair",
    })),
  };
};
