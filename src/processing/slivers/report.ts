import { SliverDetectionResult, SliverValidationReport } from "./types";

export const buildSliverReport = (
  detection: SliverDetectionResult,
  appliedSliverAreaThresholdM2: number,
): SliverValidationReport => ({
  valid: detection.findings.length === 0,
  polygonFeaturesScanned: detection.polygonFeaturesScanned,
  sliversFound: detection.findings.length,
  unresolvedIssues: detection.findings.length,
  unresolvedFeatureIndexes: [
    ...new Set(detection.findings.map((finding) => finding.featureIndex)),
  ].sort((first, second) => first - second),
  appliedSliverAreaThresholdM2,
  issues: detection.findings.map((finding) => ({
    ...finding,
    status: "Unresolved",
    recommendedAction: "ManualReview",
  })),
});
