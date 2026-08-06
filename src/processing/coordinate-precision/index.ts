import {
  DEFAULT_MAX_DECIMAL_PLACES,
  detectCoordinatePrecision,
} from "./detector";
import { buildCoordinatePrecisionReport } from "./report";
import {
  CoordinatePrecisionOptions,
  CoordinatePrecisionProcessResult,
  FeatureCollectionLike,
} from "./types";

export * from "./detector";
export * from "./output";
export * from "./report";
export * from "./types";

export const processCoordinatePrecision = <T extends FeatureCollectionLike>(
  geojson: T,
  options: CoordinatePrecisionOptions = {
    maxDecimalPlaces: DEFAULT_MAX_DECIMAL_PLACES,
  },
): CoordinatePrecisionProcessResult<T> => {
  const detection = detectCoordinatePrecision(geojson, options);
  return {
    geojson,
    report: buildCoordinatePrecisionReport(
      detection,
      options.maxDecimalPlaces,
    ),
  };
};
