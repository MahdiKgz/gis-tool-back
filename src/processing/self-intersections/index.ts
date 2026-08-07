import { detectSelfIntersections } from "./detector";
import { buildSelfIntersectionReport } from "./report";
import {
  FeatureCollectionLike,
  SelfIntersectionProcessResult,
} from "./types";

export * from "./detector";
export * from "./report";
export * from "./types";

export const processSelfIntersections = <T extends FeatureCollectionLike>(
  geojson: T,
): SelfIntersectionProcessResult<T> => {
  const detection = detectSelfIntersections(geojson);
  return {
    geojson,
    report: buildSelfIntersectionReport(detection),
  };
};
