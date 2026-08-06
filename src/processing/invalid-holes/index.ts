import {
  DEFAULT_TINY_HOLE_AREA_M2,
  detectInvalidHoles,
} from "./detector";
import { repairInvalidHoles } from "./repair";
import { buildInvalidHoleReport } from "./report";
import {
  FeatureCollectionLike,
  InvalidHoleOptions,
  InvalidHoleProcessResult,
} from "./types";

export * from "./detector";
export * from "./repair";
export * from "./report";
export * from "./spatial";
export * from "./types";

export const processInvalidHoles = <T extends FeatureCollectionLike>(
  geojson: T,
  options: InvalidHoleOptions = {
    tinyHoleAreaM2: DEFAULT_TINY_HOLE_AREA_M2,
  },
  autoRepair = true,
): InvalidHoleProcessResult<T> => {
  const detection = detectInvalidHoles(geojson, options);
  const repair = autoRepair
    ? repairInvalidHoles(geojson, detection.findings)
    : {
        geojson,
        removedHoleKeys: new Set<string>(),
        normalizedHoleKeys: new Set<string>(),
      };

  return {
    geojson: repair.geojson,
    report: buildInvalidHoleReport(
      detection,
      repair.removedHoleKeys,
      repair.normalizedHoleKeys,
    ),
  };
};
