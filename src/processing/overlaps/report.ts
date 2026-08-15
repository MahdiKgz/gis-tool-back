import {
  PolygonOverlapDetectionResult,
  PolygonOverlapValidationReport,
} from "./types";

export const buildPolygonOverlapReport = (
  detection: PolygonOverlapDetectionResult,
): PolygonOverlapValidationReport => {
  const affectedFeatureIndexes = detection.findings.flatMap((finding) => [
    finding.featureIndex,
    finding.relatedFeatureIndex,
  ]);
  return {
    valid: detection.findings.length === 0,
    polygonComponentsScanned: detection.polygonComponentsScanned,
    candidatePairsChecked: detection.candidatePairsChecked,
    overlapsFound: detection.findings.length,
    unresolvedIssues: detection.findings.length,
    unresolvedFeatureIndexes: [...new Set(affectedFeatureIndexes)].sort(
      (first, second) => first - second,
    ),
    issues: detection.findings.map((finding) => ({
      ...finding,
      status: "Unresolved",
      recommendedAction: "ManualReview",
    })),
  };
};
