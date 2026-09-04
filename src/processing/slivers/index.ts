import { detectSlivers } from "./detector";
import { repairSlivers } from "./repair";
import { buildSliverReport } from "./report";
import {
  FeatureCollectionLike,
  SliverOptions,
  SliverProcessResult,
} from "./types";

export * from "./detector";
export * from "./report";
export * from "./repair";
export * from "./types";

export const processSlivers = <T extends FeatureCollectionLike>(
  geojson: T,
  options: SliverOptions,
  autoRepair = false,
): SliverProcessResult<T> => {
  const detection = detectSlivers(geojson, options);
  const repair = autoRepair
    ? repairSlivers(geojson, detection.findings)
    : { geojson, removedKeys: new Set<string>() };
  return {
    geojson: repair.geojson,
    report: buildSliverReport(
      detection,
      options.sliverAreaThresholdM2,
      repair.removedKeys,
    ),
  };
};
