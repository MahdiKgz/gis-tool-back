import { ringPathKey } from "../shared/ring-path";
import {
  InvalidHoleDetectionResult,
  InvalidHoleType,
  InvalidHoleValidationReport,
} from "./types";

const findingKey = (
  finding: InvalidHoleDetectionResult["findings"][number],
): string =>
  ringPathKey(
    finding.featureIndex,
    finding.geometryCollectionPath,
    finding.coordinatePath,
  );

const countType = (
  detection: InvalidHoleDetectionResult,
  type: InvalidHoleType,
): number =>
  detection.findings.filter((finding) => finding.type === type).length;

export const buildInvalidHoleReport = (
  detection: InvalidHoleDetectionResult,
  removedHoleKeys: Set<string>,
  normalizedHoleKeys: Set<string>,
): InvalidHoleValidationReport => {
  const issues = detection.findings.map((finding) => {
    const currentRemoved = removedHoleKeys.has(findingKey(finding));
    const relatedRemoved =
      finding.relatedHoleCoordinatePath !== null &&
      removedHoleKeys.has(
        ringPathKey(
          finding.featureIndex,
          finding.geometryCollectionPath,
          finding.relatedHoleCoordinatePath,
        ),
      );
    const removed = currentRemoved || relatedRemoved;

    return {
      ...finding,
      status: removed ? ("Removed" as const) : ("Unresolved" as const),
      recommendedAction: removed
        ? ("None" as const)
        : ("ManualReview" as const),
    };
  });
  const unresolved = issues.filter((issue) => issue.status === "Unresolved");
  const tinyRemovedKeys = new Set(
    detection.findings
      .filter(
        (finding) =>
          finding.type === "tiny" && removedHoleKeys.has(findingKey(finding)),
      )
      .map(findingKey),
  );
  const outsideRemovedKeys = new Set(
    detection.findings
      .filter(
        (finding) =>
          finding.type === "outside" &&
          removedHoleKeys.has(findingKey(finding)),
      )
      .map(findingKey),
  );

  return {
    valid: unresolved.length === 0,
    holesScanned: detection.holesScanned,
    invalidHolesFound: new Set(detection.findings.map(findingKey)).size,
    holesRemoved: removedHoleKeys.size,
    tinyHolesRemoved: tinyRemovedKeys.size,
    outsideHolesRemoved: outsideRemovedKeys.size,
    holeOrientationsNormalized: normalizedHoleKeys.size,
    outsideHoles: countType(detection, "outside"),
    nestedHoles: countType(detection, "nested"),
    duplicateHoles: countType(detection, "duplicate"),
    selfIntersectingHoles: countType(detection, "self-intersecting"),
    touchingBoundaryHoles: countType(detection, "touching-boundary"),
    tinyHoles: countType(detection, "tiny"),
    holesLargerThanPolygon: countType(detection, "larger-than-polygon"),
    unresolvedIssues: unresolved.length,
    unresolvedFeatureIndexes: [
      ...new Set(unresolved.map((issue) => issue.featureIndex)),
    ].sort((first, second) => first - second),
    issues,
  };
};
