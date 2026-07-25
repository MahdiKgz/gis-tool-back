import { ringPathKey } from "../shared/ring-path";
import {
  RingClosureDetectionResult,
  RingClosureValidationReport,
} from "./types";

export const buildRingClosureReport = (
  detection: RingClosureDetectionResult,
  closedRingKeys: Set<string>,
): RingClosureValidationReport => {
  const issues = detection.findings.map((finding) => {
    const closed = closedRingKeys.has(
      ringPathKey(
        finding.featureIndex,
        finding.geometryCollectionPath,
        finding.coordinatePath,
      ),
    );
    return {
      ...finding,
      status: closed ? ("Closed" as const) : ("Unresolved" as const),
      recommendedAction: closed
        ? ("None" as const)
        : ("ManualReview" as const),
    };
  });
  const unresolved = issues.filter((issue) => issue.status === "Unresolved");

  return {
    valid: unresolved.length === 0,
    ringsScanned: detection.ringsScanned,
    openRingsFound: detection.findings.length,
    ringsClosed: issues.length - unresolved.length,
    unresolvedOpenRings: unresolved.length,
    unresolvedFeatureIndexes: [
      ...new Set(unresolved.map((issue) => issue.featureIndex)),
    ].sort((first, second) => first - second),
    issues,
  };
};
