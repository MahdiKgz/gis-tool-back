import {
  GeometryTypeDetectionResult,
  GeometryTypeValidationReport,
} from "./types";

export const buildGeometryTypeReport = (
  detection: GeometryTypeDetectionResult,
): GeometryTypeValidationReport => ({
  valid: detection.rootValid && detection.findings.length === 0,
  rootValid: detection.rootValid,
  rootError: detection.rootError,
  geometriesScanned: detection.geometriesScanned,
  invalidGeometryTypesFound: detection.findings.length,
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
