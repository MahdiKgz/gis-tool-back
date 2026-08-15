import { detectPolygonOverlaps } from "./detector";
import { buildPolygonOverlapReport } from "./report";
import {
  FeatureCollectionLike,
  PolygonOverlapProcessResult,
} from "./types";

export * from "./detector";
export * from "./report";
export * from "./types";

export const processPolygonOverlaps = <T extends FeatureCollectionLike>(
  geojson: T,
): PolygonOverlapProcessResult<T> => ({
  geojson,
  report: buildPolygonOverlapReport(detectPolygonOverlaps(geojson)),
});
