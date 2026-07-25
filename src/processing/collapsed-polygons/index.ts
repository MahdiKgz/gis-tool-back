import { detectCollapsedPolygons } from "./detector";
import { buildCollapsedPolygonReport } from "./report";
import {
  CollapsedPolygonProcessResult,
  FeatureCollectionLike,
  PolygonAreaBaseline,
} from "./types";

export * from "./detector";
export * from "./report";
export * from "./types";

export const processCollapsedPolygons = <T extends FeatureCollectionLike>(
  baseline: PolygonAreaBaseline,
  geojson: T,
): CollapsedPolygonProcessResult<T> => {
  const detection = detectCollapsedPolygons(baseline, geojson);
  return {
    geojson,
    report: buildCollapsedPolygonReport(detection),
  };
};
