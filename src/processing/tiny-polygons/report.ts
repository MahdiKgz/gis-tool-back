import {
  TinyPolygonDetectionResult,
  TinyPolygonValidationReport,
} from "./types";

export const buildTinyPolygonReport = (
  detection: TinyPolygonDetectionResult,
  appliedTinyPolygonAreaM2: number,
): TinyPolygonValidationReport => ({
  valid: detection.findings.length === 0,
  polygonsScanned: detection.polygonsScanned,
  tinyPolygonsFound: detection.findings.length,
  unresolvedIssues: detection.findings.length,
  unresolvedFeatureIndexes: [
    ...new Set(detection.findings.map((finding) => finding.featureIndex)),
  ].sort((first, second) => first - second),
  appliedTinyPolygonAreaM2,
  issues: detection.findings.map((finding) => ({
    ...finding,
    status: "Unresolved",
    recommendedAction: "ManualReview",
  })),
});
