import {
  DEFAULT_MAX_DECIMAL_PLACES,
  detectCoordinatePrecision,
} from "./detector";
import { buildCoordinatePrecisionReport } from "./report";
import {
  CoordinatePrecisionValidationReport,
  CoordinatePrecisionOptions,
  CoordinatePrecisionProcessResult,
  FeatureCollectionLike,
} from "./types";

export * from "./detector";
export * from "./output";
export * from "./report";
export * from "./types";

export const coordinatePrecisionQuarantineFeatureIndexes = (
  report: CoordinatePrecisionValidationReport,
): number[] => [
  ...new Set(
    report.issues
      .filter(
        (issue) =>
          issue.code === "ROUNDING_COLLISION" ||
          issue.code === "UNSAFE_COORDINATE_MAGNITUDE",
      )
      .map((issue) => issue.featureIndex),
  ),
].sort((first, second) => first - second);

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
