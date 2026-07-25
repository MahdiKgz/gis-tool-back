import { ringPathKey } from "../shared/ring-path";
import {
  RingOrientationDetectionResult,
  RingOrientationValidationReport,
} from "./types";

export const buildRingOrientationReport = (
  detection: RingOrientationDetectionResult,
  normalizedRingKeys: Set<string>,
): RingOrientationValidationReport => {
  const issues = detection.findings.map((finding) => {
    const normalized = normalizedRingKeys.has(
      ringPathKey(
        finding.featureIndex,
        finding.geometryCollectionPath,
        finding.coordinatePath,
      ),
    );
    return {
      ...finding,
      status: normalized
        ? ("Normalized" as const)
        : ("Unresolved" as const),
      recommendedAction: normalized
        ? ("None" as const)
        : ("ManualReview" as const),
    };
  });
  const unresolved = issues.filter((issue) => issue.status === "Unresolved");

  return {
    valid: unresolved.length === 0,
    ringsScanned: detection.ringsScanned,
    ringsEvaluated: detection.ringsEvaluated,
    orientationIssuesFound: detection.findings.length,
    exteriorOrientationIssues: detection.findings.filter(
      (finding) => finding.role === "exterior",
    ).length,
    interiorOrientationIssues: detection.findings.filter(
      (finding) => finding.role === "interior",
    ).length,
    indeterminateRings: detection.findings.filter(
      (finding) => finding.actualOrientation === "indeterminate",
    ).length,
    ringsNormalized: normalizedRingKeys.size,
    unresolvedIssues: unresolved.length,
    unresolvedFeatureIndexes: [
      ...new Set(unresolved.map((issue) => issue.featureIndex)),
    ].sort((first, second) => first - second),
    issues,
  };
};
