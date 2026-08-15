import { detectSlivers } from "./detector";
import { buildSliverReport } from "./report";
import {
  FeatureCollectionLike,
  SliverOptions,
  SliverProcessResult,
} from "./types";

export * from "./detector";
export * from "./report";
export * from "./types";

export const processSlivers = <T extends FeatureCollectionLike>(
  geojson: T,
  options: SliverOptions,
): SliverProcessResult<T> => {
  const detection = detectSlivers(geojson, options);
  return {
    geojson,
    report: buildSliverReport(
      detection,
      options.sliverAreaThresholdM2,
    ),
  };
};
