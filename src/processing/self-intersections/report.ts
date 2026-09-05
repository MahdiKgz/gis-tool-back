import {
  SelfIntersectionDetectionResult,
  SelfIntersectionKind,
  SelfIntersectionRepairFailureReason,
  SelfIntersectionValidationReport,
} from "./types";
import { selfIntersectionFindingKey } from "./repair";

const countKind = (
  detection: SelfIntersectionDetectionResult,
  kind: SelfIntersectionKind,
): number =>
  detection.findings.filter((finding) => finding.intersectionKind === kind)
    .length;

export const buildSelfIntersectionReport = (
  detection: SelfIntersectionDetectionResult,
  repairedKeys: Set<string> = new Set(),
  failedReasons: Map<
    string,
    SelfIntersectionRepairFailureReason
  > = new Map(),
): SelfIntersectionValidationReport => {
  const issues = detection.findings.map((finding) => {
    const key = selfIntersectionFindingKey(finding);
    const repaired = repairedKeys.has(key);
    const repairFailureReason = failedReasons.get(key) ?? null;
    return {
      ...finding,
      status: repaired ? ("Repaired" as const) : ("Unresolved" as const),
      recommendedAction: repaired
        ? ("None" as const)
        : finding.repairable && repairFailureReason === null
          ? ("AutoRepair" as const)
          : ("ManualReview" as const),
      repairFailureReason,
    };
  });
  const unresolved = issues.filter((issue) => issue.status === "Unresolved");
  return {
    valid: unresolved.length === 0,
    ringsScanned: detection.ringsScanned,
    segmentsScanned: detection.segmentsScanned,
    selfIntersectionsFound: detection.findings.length,
    crossingsFound: countKind(detection, "Crossing"),
    touchesFound: countKind(detection, "Touching"),
    overlapsFound: countKind(detection, "Overlapping"),
    selfIntersectionsRepaired: repairedKeys.size,
    unresolvedIssues: unresolved.length,
    unresolvedFeatureIndexes: [
      ...new Set(unresolved.map((finding) => finding.featureIndex)),
    ].sort((first, second) => first - second),
    issues,
  };
};
