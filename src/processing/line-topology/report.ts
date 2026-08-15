import { lineTopologyFindingKey } from "./repair";
import {
  LineTopologyDetectionResult,
  LineTopologyFinding,
  LineTopologyIssueBase,
  OvershootValidationReport,
  UndershootValidationReport,
} from "./types";

const reportIssues = <T extends LineTopologyFinding>(
  findings: T[],
  repairedKeys: Set<string>,
): Array<T & LineTopologyIssueBase> =>
  findings.map((finding) => {
    const repaired = repairedKeys.has(lineTopologyFindingKey(finding));
    return {
      ...finding,
      status: repaired ? "Repaired" : "Unresolved",
      recommendedAction: repaired
        ? "None"
        : finding.repairable
          ? "AutoRepair"
          : "ManualReview",
    };
  });

const unresolvedFeatureIndexes = (
  issues: Array<LineTopologyFinding & LineTopologyIssueBase>,
): number[] =>
  [
    ...new Set(
      issues
        .filter((issue) => issue.status === "Unresolved")
        .flatMap((issue) => [issue.featureIndex, issue.relatedFeatureIndex]),
    ),
  ].sort((first, second) => first - second);

export const buildLineTopologyReports = (
  detection: LineTopologyDetectionResult,
  repairedKeys: Set<string>,
  appliedToleranceMeters: number,
): {
  undershoots: UndershootValidationReport;
  overshoots: OvershootValidationReport;
} => {
  const undershootIssues = reportIssues(
    detection.undershoots,
    repairedKeys,
  );
  const overshootIssues = reportIssues(detection.overshoots, repairedKeys);
  const unresolvedUndershoots = undershootIssues.filter(
    (issue) => issue.status === "Unresolved",
  );
  const unresolvedOvershoots = overshootIssues.filter(
    (issue) => issue.status === "Unresolved",
  );

  return {
    undershoots: {
      valid: unresolvedUndershoots.length === 0,
      linePartsScanned: detection.linePartsScanned,
      undershootsFound: detection.undershoots.length,
      undershootsRepaired:
        detection.undershoots.length - unresolvedUndershoots.length,
      unresolvedIssues: unresolvedUndershoots.length,
      unresolvedFeatureIndexes: unresolvedFeatureIndexes(undershootIssues),
      appliedToleranceMeters,
      issues: undershootIssues,
    },
    overshoots: {
      valid: unresolvedOvershoots.length === 0,
      linePartsScanned: detection.linePartsScanned,
      overshootsFound: detection.overshoots.length,
      overshootsRepaired:
        detection.overshoots.length - unresolvedOvershoots.length,
      unresolvedIssues: unresolvedOvershoots.length,
      unresolvedFeatureIndexes: unresolvedFeatureIndexes(overshootIssues),
      appliedToleranceMeters,
      issues: overshootIssues,
    },
  };
};
