import { detectGeometryTypes } from "./detector";
import { buildGeometryTypeReport } from "./report";
import {
  FeatureCollectionLike,
  GeometryTypeProcessResult,
} from "./types";

export * from "./detector";
export * from "./report";
export * from "./types";

export const processGeometryTypes = <T extends FeatureCollectionLike>(
  geojson: T,
): GeometryTypeProcessResult<T> => {
  const detection = detectGeometryTypes(geojson);
  return {
    geojson,
    report: buildGeometryTypeReport(detection),
  };
};
