import { detectGaps } from "./detector";
import { buildGapReport } from "./report";
import {
  FeatureCollectionLike,
  GapOptions,
  GapProcessResult,
} from "./types";

export * from "./detector";
export * from "./report";
export * from "./types";

export const processGaps = <T extends FeatureCollectionLike>(
  geojson: T,
  options: GapOptions,
): GapProcessResult<T> => {
  const detection = detectGaps(geojson, options);
  return {
    geojson,
    report: buildGapReport(detection, options.gapToleranceMeters),
  };
};
