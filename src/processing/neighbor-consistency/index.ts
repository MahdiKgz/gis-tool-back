import {
  DEFAULT_NEIGHBOR_COINCIDENCE_TOLERANCE_METERS,
  detectNeighborInconsistencies,
} from "./detector";
import { repairNeighborInconsistencies } from "./repair";
import { buildNeighborConsistencyReport } from "./report";
import {
  FeatureCollectionLike,
  NeighborConsistencyOptions,
  NeighborConsistencyProcessResult,
} from "./types";

export * from "./detector";
export * from "./repair";
export * from "./report";
export * from "./types";

export const processNeighborConsistency = <T extends FeatureCollectionLike>(
  geojson: T,
  options: NeighborConsistencyOptions = {},
  autoRepair = false,
): NeighborConsistencyProcessResult<T> => {
  const tolerance =
    options.coincidenceToleranceMeters ??
    DEFAULT_NEIGHBOR_COINCIDENCE_TOLERANCE_METERS;
  const detection = detectNeighborInconsistencies(geojson, options);
  const repair = autoRepair
    ? repairNeighborInconsistencies(geojson, detection.findings)
    : {
        geojson,
        repairedKeys: new Set<string>(),
        failedReasons: new Map(),
      };
  return {
    geojson: repair.geojson,
    report: buildNeighborConsistencyReport(
      detection,
      tolerance,
      repair.repairedKeys,
      repair.failedReasons,
    ),
  };
};
