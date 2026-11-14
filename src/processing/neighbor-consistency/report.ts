import { DEFAULT_NEIGHBOR_COINCIDENCE_TOLERANCE_METERS } from "./detector";
import { neighborConsistencyFindingKey } from "./repair";
import {
  NeighborConsistencyDetectionResult,
  NeighborConsistencyRepairFailureReason,
  NeighborConsistencyValidationReport,
} from "./types";

export const buildNeighborConsistencyReport = (
  detection: NeighborConsistencyDetectionResult,
  appliedCoincidenceToleranceMeters =
    DEFAULT_NEIGHBOR_COINCIDENCE_TOLERANCE_METERS,
  repairedKeys: ReadonlySet<string> = new Set(),
  failedReasons: ReadonlyMap<
    string,
    NeighborConsistencyRepairFailureReason
  > = new Map(),
): NeighborConsistencyValidationReport => {
  const issues = detection.findings.map((finding) => {
    const key = neighborConsistencyFindingKey(finding);
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
    polygonComponentsScanned: detection.polygonComponentsScanned,
    verticesScanned: detection.verticesScanned,
    candidateSegmentsChecked: detection.candidateSegmentsChecked,
    mismatchesFound: issues.length,
    verticesInserted: repairedKeys.size,
    unresolvedIssues: unresolved.length,
    unresolvedFeatureIndexes: [
      ...new Set(
        unresolved.flatMap((issue) => [
          issue.featureIndex,
          issue.relatedFeatureIndex,
        ]),
      ),
    ].sort((first, second) => first - second),
    appliedCoincidenceToleranceMeters,
    issues,
  };
};
