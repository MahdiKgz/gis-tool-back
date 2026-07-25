import { getFeatureId } from "../shared/feature-id";
import { measurePolygonAreaM2 } from "../shared/polygon-area";
import { visitPolygonComponents } from "../shared/polygon-components";
import {
  FeatureCollectionLike,
  TinyPolygonDetectionResult,
  TinyPolygonOptions,
} from "./types";

export const DEFAULT_TINY_POLYGON_AREA_M2 = 0.01;

export const detectTinyPolygons = (
  geojson: FeatureCollectionLike,
  options: TinyPolygonOptions = {
    tinyPolygonAreaM2: DEFAULT_TINY_POLYGON_AREA_M2,
  },
): TinyPolygonDetectionResult => {
  if (
    !Number.isFinite(options.tinyPolygonAreaM2) ||
    options.tinyPolygonAreaM2 < 0
  ) {
    throw new RangeError(
      "tinyPolygonAreaM2 must be a finite non-negative number",
    );
  }
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { polygonsScanned: 0, findings: [] };
  }

  let polygonsScanned = 0;
  const findings: TinyPolygonDetectionResult["findings"] = [];
  geojson.features.forEach((feature, featureIndex) => {
    visitPolygonComponents(feature.geometry, (component) => {
      polygonsScanned++;
      const areaM2 = measurePolygonAreaM2(component.coordinates);
      if (areaM2 === null) return;
      if (
        areaM2 <= 0 ||
        areaM2 >= options.tinyPolygonAreaM2
      ) {
        return;
      }
      findings.push({
        code: "TINY_POLYGON",
        featureIndex,
        featureId: getFeatureId(feature),
        geometryType: component.geometryType,
        geometryCollectionPath: [...component.geometryCollectionPath],
        polygonPath: [...component.polygonPath],
        areaM2,
        thresholdM2: options.tinyPolygonAreaM2,
        repairable: false,
      });
    });
  });
  return { polygonsScanned, findings };
};
