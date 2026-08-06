import {
  MultipartIntegrityDetectionResult,
  MultipartIntegrityFindingCode,
  MultipartIntegrityValidationReport,
} from "./types";

const countCode = (
  detection: MultipartIntegrityDetectionResult,
  code: MultipartIntegrityFindingCode,
): number =>
  detection.findings.filter((finding) => finding.code === code).length;

export const buildMultipartIntegrityReport = (
  detection: MultipartIntegrityDetectionResult,
): MultipartIntegrityValidationReport => ({
  valid: detection.findings.length === 0,
  multiPolygonsScanned: detection.multiPolygonsScanned,
  polygonComponentsScanned: detection.polygonComponentsScanned,
  invalidMultiPolygonsFound: new Set(
    detection.findings.map(
      (finding) =>
        `${finding.featureIndex}|${finding.geometryCollectionPath.join(".")}`,
    ),
  ).size,
  emptyMultiPolygons: countCode(detection, "EMPTY_MULTIPOLYGON"),
  invalidPolygonComponents: countCode(
    detection,
    "INVALID_POLYGON_COMPONENT",
  ),
  duplicatePolygonComponents: countCode(
    detection,
    "DUPLICATE_POLYGON_COMPONENT",
  ),
  overlappingPolygonComponents: countCode(
    detection,
    "OVERLAPPING_POLYGON_COMPONENTS",
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
