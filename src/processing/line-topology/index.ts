import { detectLineTopology } from "./detector";
import { repairLineTopology } from "./repair";
import { buildLineTopologyReports } from "./report";
import {
  FeatureCollectionLike,
  LineTopologyOptions,
  LineTopologyProcessResult,
} from "./types";

export * from "./detector";
export * from "./repair";
export * from "./report";
export * from "./types";

export const processLineTopology = <T extends FeatureCollectionLike>(
  geojson: T,
  options: LineTopologyOptions,
  autoRepair = true,
): LineTopologyProcessResult<T> => {
  const detection = detectLineTopology(geojson, options);
  const repair = autoRepair
    ? repairLineTopology(geojson, [
        ...detection.overshoots,
        ...detection.undershoots,
      ])
    : { geojson, repairedKeys: new Set<string>() };
  return {
    geojson: repair.geojson,
    reports: buildLineTopologyReports(
      detection,
      repair.repairedKeys,
      options.toleranceMeters,
    ),
  };
};
