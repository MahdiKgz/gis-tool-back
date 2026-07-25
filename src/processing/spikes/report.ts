import { SpikeDetectionResult, SpikeValidationReport } from "./types";
import { spikePathKey } from "./repair";

export const buildSpikeReport = (
  detection: SpikeDetectionResult,
  removedKeys: Set<string>,
  appliedBaseToleranceMeters: number,
  appliedMaxTipAngleDegrees: number,
): SpikeValidationReport => {
  const issues = detection.findings.map((finding) => {
    const removed = removedKeys.has(
      spikePathKey(
        finding.featureIndex,
        finding.geometryCollectionPath,
        finding.coordinatePath,
      ),
    );
    return {
      ...finding,
      status: removed ? ("Removed" as const) : ("Unresolved" as const),
      recommendedAction: removed
        ? ("None" as const)
        : ("ManualReview" as const),
    };
  });
  const unresolved = issues.filter((issue) => issue.status === "Unresolved");
  return {
    valid: unresolved.length === 0,
    sequencesScanned: detection.sequencesScanned,
    spikesFound: detection.findings.length,
    spikesRemoved: removedKeys.size,
    unresolvedSpikes: unresolved.length,
    unresolvedFeatureIndexes: [
      ...new Set(unresolved.map((issue) => issue.featureIndex)),
    ].sort((first, second) => first - second),
    appliedBaseToleranceMeters,
    appliedMaxTipAngleDegrees,
    issues,
  };
};
