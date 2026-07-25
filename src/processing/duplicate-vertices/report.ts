import {
  DuplicateVertexFinding,
  DuplicateVertexValidationReport,
} from "./types";

export const buildDuplicateVertexReport = (
  findings: DuplicateVertexFinding[],
  removedCount: number,
): DuplicateVertexValidationReport => {
  let repairedRemaining = removedCount;
  const issues = findings.map((finding) => {
    const repaired = finding.repairable && repairedRemaining > 0;
    if (repaired) repairedRemaining--;

    return {
      ...finding,
      status: repaired ? ("Repaired" as const) : ("Unresolved" as const),
      recommendedAction: repaired
        ? ("None" as const)
        : ("ManualReview" as const),
    };
  });

  const unresolvedDuplicates = findings.length - removedCount;

  return {
    valid: unresolvedDuplicates === 0,
    duplicatesFound: findings.length,
    duplicatesRemoved: removedCount,
    unresolvedDuplicates,
    consecutiveDuplicates: findings.filter(
      (finding) => finding.kind === "consecutive",
    ).length,
    nonConsecutiveDuplicates: findings.filter(
      (finding) => finding.kind === "non-consecutive",
    ).length,
    issues,
  };
};
