import {
  CoordinatePrecisionDetectionResult,
  CoordinatePrecisionFindingCode,
  CoordinatePrecisionValidationReport,
} from "./types";

const countCode = (
  detection: CoordinatePrecisionDetectionResult,
  code: CoordinatePrecisionFindingCode,
): number =>
  detection.findings.filter((finding) => finding.code === code).length;

export const buildCoordinatePrecisionReport = (
  detection: CoordinatePrecisionDetectionResult,
  appliedMaxDecimalPlaces: number,
): CoordinatePrecisionValidationReport => ({
  valid: detection.findings.length === 0,
  positionsScanned: detection.positionsScanned,
  precisionIssuesFound: detection.findings.length,
  excessiveCoordinateValues: countCode(
    detection,
    "EXCESSIVE_COORDINATE_PRECISION",
  ),
  roundingCollisions: countCode(detection, "ROUNDING_COLLISION"),
  unsafeMagnitudeValues: countCode(
    detection,
    "UNSAFE_COORDINATE_MAGNITUDE",
  ),
  unresolvedIssues: detection.findings.length,
  unresolvedFeatureIndexes: [
    ...new Set(detection.findings.map((finding) => finding.featureIndex)),
  ].sort((first, second) => first - second),
  appliedMaxDecimalPlaces,
  issues: detection.findings.map((finding) => ({
    ...finding,
    status: "Unresolved",
    recommendedAction: "ManualReview",
  })),
});
