import { detectRingOrientationIssues } from "./detector";
import { normalizeRingOrientations } from "./repair";
import { buildRingOrientationReport } from "./report";
import {
  FeatureCollectionLike,
  RingOrientationProcessResult,
} from "./types";

export * from "./detector";
export * from "./orientation";
export * from "./repair";
export * from "./report";
export * from "./types";

export const processRingOrientation = <T extends FeatureCollectionLike>(
  geojson: T,
  autoRepair = true,
): RingOrientationProcessResult<T> => {
  const detection = detectRingOrientationIssues(geojson);
  const repair = autoRepair
    ? normalizeRingOrientations(geojson, detection.findings)
    : { geojson, normalizedRingKeys: new Set<string>() };

  return {
    geojson: repair.geojson,
    report: buildRingOrientationReport(
      detection,
      repair.normalizedRingKeys,
    ),
  };
};
