import { detectZeroAreaPolygons } from "./detector";
import { buildZeroAreaPolygonReport } from "./report";
import {
  FeatureCollectionLike,
  ZeroAreaPolygonProcessResult,
} from "./types";

export * from "./detector";
export * from "./report";
export * from "./types";

export const processZeroAreaPolygons = <T extends FeatureCollectionLike>(
  geojson: T,
): ZeroAreaPolygonProcessResult<T> => {
  const detection = detectZeroAreaPolygons(geojson);
  return {
    geojson,
    report: buildZeroAreaPolygonReport(detection),
  };
};
