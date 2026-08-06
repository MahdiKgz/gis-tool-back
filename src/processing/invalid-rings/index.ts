import { detectInvalidRings } from "./detector";
import { repairInvalidRings } from "./repair";
import { buildInvalidRingReport } from "./report";
import {
  FeatureCollectionLike,
  InvalidRingProcessResult,
} from "./types";

export * from "./detector";
export * from "./repair";
export * from "./report";
export * from "./types";

export const processInvalidRings = <T extends FeatureCollectionLike>(
  geojson: T,
  autoRepair = true,
): InvalidRingProcessResult<T> => {
  const detection = detectInvalidRings(geojson);
  const repair = autoRepair
    ? repairInvalidRings(geojson, detection.findings)
    : { geojson, repairedRingKeys: new Set<string>() };

  return {
    geojson: repair.geojson,
    report: buildInvalidRingReport(detection, repair.repairedRingKeys),
    repairedRingKeys: repair.repairedRingKeys,
  };
};
