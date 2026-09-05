import { detectSelfIntersections } from "./detector";
import { repairSelfIntersections } from "./repair";
import { buildSelfIntersectionReport } from "./report";
import {
  FeatureCollectionLike,
  SelfIntersectionProcessResult,
} from "./types";

export * from "./detector";
export * from "./repair";
export * from "./report";
export * from "./types";

export const processSelfIntersections = <T extends FeatureCollectionLike>(
  geojson: T,
  autoRepair = true,
): SelfIntersectionProcessResult<T> => {
  const detection = detectSelfIntersections(geojson);
  const attempt = repairSelfIntersections(geojson, detection.findings);
  const repair = autoRepair
    ? attempt
    : { ...attempt, geojson, repairedKeys: new Set<string>() };
  return {
    geojson: repair.geojson,
    report: buildSelfIntersectionReport(
      detection,
      repair.repairedKeys,
      repair.failedReasons,
    ),
  };
};
