import {
  CollapsedPolygonDetectionResult,
  CollapsedPolygonValidationReport,
} from "./types";

export const buildCollapsedPolygonReport = (
  detection: CollapsedPolygonDetectionResult,
): CollapsedPolygonValidationReport => ({
  valid: detection.findings.length === 0,
  baselinePolygonsScanned: detection.baselinePolygonsScanned,
  collapsedPolygonsFound: detection.findings.length,
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
