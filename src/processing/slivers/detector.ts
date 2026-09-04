import area from "@turf/area";
import { polygon } from "@turf/helpers";
import { getFeatureId } from "../shared/feature-id";
import { visitPolygonComponents } from "../shared/polygon-components";
import { distanceMetersBetweenPositions } from "../shared/spatial-segments";
import {
  FeatureCollectionLike,
  SliverDetectionResult,
  SliverOptions,
} from "./types";

export const MIN_SLIVER_MULTIPLIER = 10;
export const DEFAULT_MIN_SLIVER_COMPACTNESS = 0.1;

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
  const minCompactness =
    options.minCompactness ?? DEFAULT_MIN_SLIVER_COMPACTNESS;
  if (
    !Number.isFinite(minCompactness) ||
    minCompactness < 0 ||
    minCompactness >= 1
  ) {
    throw new RangeError(
      "minCompactness must be finite, non-negative, and below 1",
    );
  }
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { polygonFeaturesScanned: 0, findings: [] };
  }

  let polygonFeaturesScanned = 0;
  const findings: SliverDetectionResult["findings"] = [];
  geojson.features.forEach((feature, featureIndex) => {
    let featureHasPolygon = false;
    visitPolygonComponents(feature.geometry, (component) => {
      featureHasPolygon = true;
      try {
        const componentFeature = polygon(component.coordinates as any);
        const areaM2 = area(componentFeature);
        const perimeterMeters = component.coordinates.reduce(
          (total, ring) =>
            total +
            ring.slice(0, -1).reduce(
              (ringTotal, start, segmentIndex) =>
                ringTotal +
                distanceMetersBetweenPositions(
                  start,
                  ring[segmentIndex + 1]!,
                ),
              0,
            ),
          0,
        );
        if (
          !Number.isFinite(areaM2) ||
          areaM2 <= 0 ||
          !Number.isFinite(perimeterMeters) ||
          perimeterMeters <= 0
        ) {
          return;
        }
        const compactness =
          (4 * Math.PI * areaM2) / perimeterMeters ** 2;
        const detectionReasons: Array<"Area" | "Compactness"> = [];
        if (areaM2 < options.sliverAreaThresholdM2) {
          detectionReasons.push("Area");
        }
        if (compactness < minCompactness) {
          detectionReasons.push("Compactness");
        }
        if (detectionReasons.length === 0) return;
        findings.push({
          code: "SLIVER_POLYGON",
          featureIndex,
          featureId: getFeatureId(feature),
          geometryType: component.geometryType,
          geometryCollectionPath: [...component.geometryCollectionPath],
          polygonPath: [...component.polygonPath],
          areaM2,
          perimeterMeters,
          compactness,
          detectionReasons,
          thresholdM2: options.sliverAreaThresholdM2,
          minCompactness,
          // Removing a component is deterministic only when it is below the
          // configured minimum mapping area. Compactness-only findings can be
          // legitimate narrow parcels and remain report-only.
          repairable:
            component.geometryCollectionPath.length === 0 &&
            detectionReasons.includes("Area"),
        });
      } catch {
        // Earlier validation stages own malformed polygon reporting.
      }
    });
    if (featureHasPolygon) polygonFeaturesScanned++;
  });

  return { polygonFeaturesScanned, findings };
};
