import {
  CoordinatePathUpdate,
  updateGeometryAtCoordinatePaths,
} from "../shared/geometry-path";
import {
  isFinitePosition,
  positionsEqual,
} from "../shared/coordinates";
import { ringPathKey } from "../shared/ring-path";
import { calculateRingOrientation } from "./orientation";
import {
  FeatureCollectionLike,
  RingOrientationFinding,
} from "./types";

export interface RingOrientationRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  normalizedRingKeys: Set<string>;
}

export const normalizeRingOrientations = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: RingOrientationFinding[],
): RingOrientationRepairResult<T> => {
  const repairable = findings.filter((finding) => finding.repairable);
  if (repairable.length === 0 || !Array.isArray(geojson.features)) {
    return { geojson, normalizedRingKeys: new Set() };
  }

  const updatesByFeature = new Map<number, CoordinatePathUpdate[]>();
  const scheduledRingKeys = new Set<string>();
  const normalizedRingKeys = new Set<string>();

  for (const finding of repairable) {
    const key = ringPathKey(
      finding.featureIndex,
      finding.geometryCollectionPath,
      finding.coordinatePath,
    );
    if (scheduledRingKeys.has(key)) continue;
    scheduledRingKeys.add(key);

    const updates = updatesByFeature.get(finding.featureIndex) ?? [];
    updates.push({
      geometryCollectionPath: finding.geometryCollectionPath,
      coordinatePath: finding.coordinatePath,
      transform: (ring) => {
        if (
          !Array.isArray(ring) ||
          ring.length < 4 ||
          !ring.every(isFinitePosition) ||
          !positionsEqual(ring[0]!, ring[ring.length - 1]!)
        ) {
          return ring;
        }
        const orientation = calculateRingOrientation(ring);
        if (
          orientation === "indeterminate" ||
          orientation === finding.expectedOrientation
        ) {
          return ring;
        }
        normalizedRingKeys.add(key);
        return [...ring].reverse();
      },
    });
    updatesByFeature.set(finding.featureIndex, updates);
  }

  const features = geojson.features.map((feature, featureIndex) => {
    const updates = updatesByFeature.get(featureIndex);
    if (!updates) return feature;
    return {
      ...feature,
      geometry: updateGeometryAtCoordinatePaths(feature.geometry, updates),
    };
  });

  return {
    geojson: { ...geojson, features } as T,
    normalizedRingKeys,
  };
};
