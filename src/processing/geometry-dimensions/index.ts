import { detectGeometryDimensions } from "./detector";
import { buildGeometryDimensionReport } from "./report";
import {
  FeatureCollectionLike,
  GeometryDimensionProcessResult,
} from "./types";

export * from "./detector";
export * from "./report";
export * from "./types";

export const processGeometryDimensions = <T extends FeatureCollectionLike>(
  geojson: T,
): GeometryDimensionProcessResult<T> => {
  const detection = detectGeometryDimensions(geojson);
  return {
    geojson,
    report: buildGeometryDimensionReport(detection),
  };
};
