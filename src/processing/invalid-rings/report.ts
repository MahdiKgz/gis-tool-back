import {
  InvalidRingDetectionResult,
  InvalidRingValidationReport,
} from "./types";
import { ringPathKey } from "./ring-path";

export const buildInvalidRingReport = (
  detection: InvalidRingDetectionResult,
  repairedRingKeys: Set<string>,
): InvalidRingValidationReport => {
  const issues = detection.findings.map((finding) => {
    const repaired =
      finding.type === "unclosed" &&
      repairedRingKeys.has(
        ringPathKey(
          finding.featureIndex,
          finding.geometryCollectionPath,
          finding.coordinatePath,
        ),
      );
    return {
      ...finding,
      status: repaired ? ("Repaired" as const) : ("Unresolved" as const),
      recommendedAction: repaired
        ? ("None" as const)
        : ("ManualReview" as const),
    };
  });

  const unresolvedIssues = issues.filter(
    (issue) => issue.status === "Unresolved",
  );
  const invalidRingKeys = new Set(
    detection.findings.map((finding) =>
      ringPathKey(
        finding.featureIndex,
        finding.geometryCollectionPath,
        finding.coordinatePath,
      ),
    ),
  );

  return {
    valid: unresolvedIssues.length === 0,
    ringsScanned: detection.ringsScanned,
    invalidRingsFound: invalidRingKeys.size,
    ringsRepaired: repairedRingKeys.size,
    unclosedRings: detection.findings.filter(
      (finding) => finding.type === "unclosed",
    ).length,
    corruptedRings: detection.findings.filter(
      (finding) => finding.type === "corrupted",
    ).length,
    insufficientRings: detection.findings.filter(
      (finding) => finding.type === "insufficient-vertices",
    ).length,
    unresolvedIssues: unresolvedIssues.length,
    unresolvedFeatureIndexes: [
      ...new Set(unresolvedIssues.map((issue) => issue.featureIndex)),
    ].sort((first, second) => first - second),
    issues,
  };
};
