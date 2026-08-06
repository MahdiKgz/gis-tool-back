import {
  DEFAULT_TINY_POLYGON_AREA_M2,
  detectTinyPolygons,
} from "./detector";
import { buildTinyPolygonReport } from "./report";
import {
  FeatureCollectionLike,
  TinyPolygonOptions,
  TinyPolygonProcessResult,
} from "./types";

export * from "./detector";
export * from "./report";
export * from "./types";

export const processTinyPolygons = <T extends FeatureCollectionLike>(
  geojson: T,
  options: TinyPolygonOptions = {
    tinyPolygonAreaM2: DEFAULT_TINY_POLYGON_AREA_M2,
  },
): TinyPolygonProcessResult<T> => {
  const detection = detectTinyPolygons(geojson, options);
  return {
    geojson,
    report: buildTinyPolygonReport(
      detection,
      options.tinyPolygonAreaM2,
    ),
  };
};
