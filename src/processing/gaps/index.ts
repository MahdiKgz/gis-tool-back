import { detectGaps } from "./detector";
import { repairGaps } from "./repair";
import { buildGapReport } from "./report";
import {
  FeatureCollectionLike,
  GapOptions,
  GapProcessResult,
} from "./types";

export * from "./detector";
export * from "./report";
export * from "./repair";
export * from "./types";

export const processGaps = <T extends FeatureCollectionLike>(
  geojson: T,
  options: GapOptions,
  autoRepair = false,
): GapProcessResult<T> => {
  const detection = detectGaps(geojson, options);
  const repair = autoRepair
    ? repairGaps(geojson, detection.findings, options)
    : { geojson, repairedKeys: new Set<string>() };
  return {
    geojson: repair.geojson,
    report: buildGapReport(
      detection,
      options.gapToleranceMeters,
      options.minimumGapWidthMeters ?? 0,
      repair.repairedKeys,
    ),
  };
};
