import {
  ZeroAreaPolygonDetectionResult,
  ZeroAreaPolygonValidationReport,
} from "./types";

export const buildZeroAreaPolygonReport = (
  detection: ZeroAreaPolygonDetectionResult,
): ZeroAreaPolygonValidationReport => ({
  valid: detection.findings.length === 0,
  polygonsScanned: detection.polygonsScanned,
  zeroAreaPolygonsFound: detection.findings.length,
  unresolvedIssues: detection.findings.length,
  unresolvedFeatureIndexes: [
    ...new Set(detection.findings.map((finding) => finding.featureIndex)),
  ].sort((first, second) => first - second),
  issues: detection.findings.map((finding) => ({
    ...finding,
    status: "Unresolved",
    recommendedAction: "ManualReview",
  })),
});
