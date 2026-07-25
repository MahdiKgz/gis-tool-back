import { getFeatureId } from "../shared/feature-id";
import {
  measurePolygonAreaM2,
  polygonComponentPathKey,
} from "../shared/polygon-area";
import { visitPolygonComponents } from "../shared/polygon-components";
import {
  CollapsedPolygonDetectionResult,
  FeatureCollectionLike,
  PolygonAreaBaseline,
} from "./types";

export const capturePolygonAreaBaseline = (
  geojson: FeatureCollectionLike,
): PolygonAreaBaseline => {
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { entries: [] };
  }
  const entries: PolygonAreaBaseline["entries"] = [];
  geojson.features.forEach((feature, featureIndex) => {
    visitPolygonComponents(feature.geometry, (component) => {
      const areaM2 = measurePolygonAreaM2(component.coordinates);
      if (areaM2 === null || areaM2 <= 0) return;
      entries.push({
        key: polygonComponentPathKey(
          featureIndex,
          component.geometryCollectionPath,
          component.polygonPath,
        ),
        featureIndex,
        featureId: getFeatureId(feature),
        geometryType: component.geometryType,
        geometryCollectionPath: [...component.geometryCollectionPath],
        polygonPath: [...component.polygonPath],
        areaM2,
      });
    });
  });
  return { entries };
};

export const detectCollapsedPolygons = (
  baseline: PolygonAreaBaseline,
  geojson: FeatureCollectionLike,
): CollapsedPolygonDetectionResult => {
  const currentAreas = new Map<string, number>();
  if (geojson.type === "FeatureCollection" && Array.isArray(geojson.features)) {
    geojson.features.forEach((feature, featureIndex) => {
      visitPolygonComponents(feature.geometry, (component) => {
        const areaM2 = measurePolygonAreaM2(component.coordinates);
        if (areaM2 === null) return;
        currentAreas.set(
          polygonComponentPathKey(
            featureIndex,
            component.geometryCollectionPath,
            component.polygonPath,
          ),
          areaM2,
        );
      });
    });
  }

  const findings: CollapsedPolygonDetectionResult["findings"] = [];
  for (const entry of baseline.entries) {
    const afterAreaM2 = currentAreas.get(entry.key);
    if (afterAreaM2 !== undefined && afterAreaM2 > 0) continue;
    findings.push({
      code: "COLLAPSED_POLYGON",
      featureIndex: entry.featureIndex,
      featureId: entry.featureId,
      geometryType: entry.geometryType,
      geometryCollectionPath: [...entry.geometryCollectionPath],
      polygonPath: [...entry.polygonPath],
      beforeAreaM2: entry.areaM2,
      afterAreaM2: afterAreaM2 ?? null,
      collapseKind:
        afterAreaM2 === undefined ? "Missing" : "ZeroArea",
      repairable: false,
    });
  }
  return {
    baselinePolygonsScanned: baseline.entries.length,
    findings,
  };
};
