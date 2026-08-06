import {
  GeometryDimensionDetectionResult,
  GeometryDimensionFindingCode,
  GeometryDimensionValidationReport,
} from "./types";

const countCode = (
  detection: GeometryDimensionDetectionResult,
  code: GeometryDimensionFindingCode,
): number =>
  detection.findings.filter((finding) => finding.code === code).length;

export const buildGeometryDimensionReport = (
  detection: GeometryDimensionDetectionResult,
): GeometryDimensionValidationReport => ({
  valid: detection.findings.length === 0,
  positionsScanned: detection.positionsScanned,
  invalidDimensionsFound: countCode(
    detection,
    "INVALID_POSITION_DIMENSION",
  ),
  inconsistentDimensionsFound: countCode(
    detection,
    "INCONSISTENT_POSITION_DIMENSION",
  ),
  invalidCoordinateValuesFound: countCode(
    detection,
    "INVALID_COORDINATE_VALUE",
  ),
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
