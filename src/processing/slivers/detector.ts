import area from "@turf/area";
import { getFeatureId } from "../shared/feature-id";
import {
  FeatureCollectionLike,
  SliverDetectionResult,
  SliverOptions,
} from "./types";

export const MIN_SLIVER_MULTIPLIER = 10;

export const computeSliverAreaThresholdM2 = (
  toleranceMeters: number,
): number => (toleranceMeters * MIN_SLIVER_MULTIPLIER) ** 2;

export const detectSlivers = (
  geojson: FeatureCollectionLike,
  options: SliverOptions,
): SliverDetectionResult => {
  if (
    !Number.isFinite(options.sliverAreaThresholdM2) ||
    options.sliverAreaThresholdM2 < 0
  ) {
    throw new RangeError(
      "sliverAreaThresholdM2 must be a finite non-negative number",
    );
  }
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { polygonFeaturesScanned: 0, findings: [] };
  }

  let polygonFeaturesScanned = 0;
  const findings: SliverDetectionResult["findings"] = [];
  geojson.features.forEach((feature, featureIndex) => {
    const geometryType = feature.geometry?.type;
    if (geometryType !== "Polygon" && geometryType !== "MultiPolygon") return;
    polygonFeaturesScanned++;

    let areaM2: number;
    try {
      areaM2 = area(feature as any);
    } catch {
      return;
    }
    if (
      !Number.isFinite(areaM2) ||
      areaM2 <= 0 ||
      areaM2 >= options.sliverAreaThresholdM2
    ) {
      return;
    }
    findings.push({
      code: "SLIVER_POLYGON",
      featureIndex,
      featureId: getFeatureId(feature),
      geometryType,
      geometryCollectionPath: [],
      areaM2,
      thresholdM2: options.sliverAreaThresholdM2,
      repairable: false,
    });
  });

  return { polygonFeaturesScanned, findings };
};
