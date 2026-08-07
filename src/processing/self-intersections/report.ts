import {
  SelfIntersectionDetectionResult,
  SelfIntersectionKind,
  SelfIntersectionValidationReport,
} from "./types";

const countKind = (
  detection: SelfIntersectionDetectionResult,
  kind: SelfIntersectionKind,
): number =>
  detection.findings.filter((finding) => finding.intersectionKind === kind)
    .length;

export const buildSelfIntersectionReport = (
  detection: SelfIntersectionDetectionResult,
): SelfIntersectionValidationReport => ({
  valid: detection.findings.length === 0,
  ringsScanned: detection.ringsScanned,
  segmentsScanned: detection.segmentsScanned,
  selfIntersectionsFound: detection.findings.length,
  crossingsFound: countKind(detection, "Crossing"),
  touchesFound: countKind(detection, "Touching"),
  overlapsFound: countKind(detection, "Overlapping"),
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
