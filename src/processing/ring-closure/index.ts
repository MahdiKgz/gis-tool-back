import { detectOpenRings } from "./detector";
import { repairOpenRings } from "./repair";
import { buildRingClosureReport } from "./report";
import {
  FeatureCollectionLike,
  RingClosureProcessResult,
} from "./types";

export * from "./detector";
export * from "./repair";
export * from "./report";
export * from "./types";

export const processRingClosure = <T extends FeatureCollectionLike>(
  geojson: T,
  autoRepair = true,
): RingClosureProcessResult<T> => {
  const detection = detectOpenRings(geojson);
  const repair = autoRepair
    ? repairOpenRings(geojson, detection.findings)
    : { geojson, closedRingKeys: new Set<string>() };

  return {
    geojson: repair.geojson,
    report: buildRingClosureReport(detection, repair.closedRingKeys),
  };
};
