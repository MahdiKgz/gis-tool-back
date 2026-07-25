import {
  isFinitePosition,
  positionKey,
  positionsEqual,
} from "../shared/coordinates";
import {
  CoordinatePathUpdate,
  updateGeometryAtCoordinatePaths,
} from "../shared/geometry-path";
import { ringPathKey } from "../shared/ring-path";
import {
  FeatureCollectionLike,
  OpenRingFinding,
} from "./types";

export interface RingClosureTarget {
  featureIndex: number;
  geometryCollectionPath: number[];
  coordinatePath: number[];
}

export interface RingClosureRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  closedRingKeys: Set<string>;
}

export const closeRingTargets = <T extends FeatureCollectionLike>(
  geojson: T,
  targets: RingClosureTarget[],
): RingClosureRepairResult<T> => {
  if (targets.length === 0 || !Array.isArray(geojson.features)) {
    return { geojson, closedRingKeys: new Set() };
  }

  const updatesByFeature = new Map<number, CoordinatePathUpdate[]>();
  const closedRingKeys = new Set<string>();
  const scheduledRingKeys = new Set<string>();

  for (const target of targets) {
    const key = ringPathKey(
      target.featureIndex,
      target.geometryCollectionPath,
      target.coordinatePath,
    );
    if (scheduledRingKeys.has(key)) continue;
    scheduledRingKeys.add(key);

    const updates = updatesByFeature.get(target.featureIndex) ?? [];
    updates.push({
      geometryCollectionPath: target.geometryCollectionPath,
      coordinatePath: target.coordinatePath,
      transform: (ring) => {
        if (
          !Array.isArray(ring) ||
          ring.length === 0 ||
          !ring.every(isFinitePosition)
        ) {
          return ring;
        }
        const first = ring[0]!;
        const distinctVertexCount = new Set(ring.map(positionKey)).size;
        if (distinctVertexCount < 3) return ring;

        const last = ring[ring.length - 1];
        if (positionsEqual(first, last!)) return ring;

        closedRingKeys.add(key);
        return [...ring, [...first]];
      },
    });
    updatesByFeature.set(target.featureIndex, updates);
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
    closedRingKeys,
  };
};

export const repairOpenRings = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: OpenRingFinding[],
): RingClosureRepairResult<T> =>
  closeRingTargets(
    geojson,
    findings.filter((finding) => finding.repairable),
  );
