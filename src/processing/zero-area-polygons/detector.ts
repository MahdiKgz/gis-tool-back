import area from "@turf/area";
import { polygon } from "@turf/helpers";
import { getFeatureId } from "../shared/feature-id";
import { visitPolygonComponents } from "../shared/polygon-components";
import {
  FeatureCollectionLike,
  ZeroAreaPolygonDetectionResult,
} from "./types";

export const detectZeroAreaPolygons = (
  geojson: FeatureCollectionLike,
): ZeroAreaPolygonDetectionResult => {
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { polygonsScanned: 0, findings: [] };
  }

  let polygonsScanned = 0;
  const findings: ZeroAreaPolygonDetectionResult["findings"] = [];
  geojson.features.forEach((feature, featureIndex) => {
    visitPolygonComponents(feature.geometry, (component) => {
      polygonsScanned++;
      let areaM2: number;
      try {
        areaM2 = area(polygon(component.coordinates as any));
      } catch {
        return;
      }
      if (areaM2 !== 0) return;
      findings.push({
        code: "ZERO_AREA_POLYGON",
        featureIndex,
        featureId: getFeatureId(feature),
        geometryType: component.geometryType,
        geometryCollectionPath: [...component.geometryCollectionPath],
        polygonPath: [...component.polygonPath],
        areaM2: 0,
        repairable: false,
      });
    });
  });
  return { polygonsScanned, findings };
};
