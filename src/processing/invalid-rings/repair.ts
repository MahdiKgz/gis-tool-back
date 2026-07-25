import { isFinitePosition } from "../shared/coordinates";
import {
  CoordinatePathUpdate,
  updateGeometryAtCoordinatePaths,
} from "../shared/geometry-path";
import {
  FeatureCollectionLike,
  InvalidRingFinding,
} from "./types";
import { ringPathKey } from "./ring-path";

export interface InvalidRingRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  repairedRingKeys: Set<string>;
}

export const repairInvalidRings = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: InvalidRingFinding[],
): InvalidRingRepairResult<T> => {
  const repairable = findings.filter(
    (finding) => finding.type === "unclosed" && finding.repairable,
  );
  if (repairable.length === 0 || !Array.isArray(geojson.features)) {
    return { geojson, repairedRingKeys: new Set() };
  }

  const updatesByFeature = new Map<number, CoordinatePathUpdate[]>();
  const repairedRingKeys = new Set<string>();

  for (const finding of repairable) {
    const key = ringPathKey(
      finding.featureIndex,
      finding.geometryCollectionPath,
      finding.coordinatePath,
    );
    if (repairedRingKeys.has(key)) continue;

    const updates = updatesByFeature.get(finding.featureIndex) ?? [];
    updates.push({
      geometryCollectionPath: finding.geometryCollectionPath,
      coordinatePath: finding.coordinatePath,
      transform: (ring) => {
        if (!Array.isArray(ring) || !isFinitePosition(ring[0])) return ring;
        return [...ring, [...ring[0]]];
      },
    });
    updatesByFeature.set(finding.featureIndex, updates);
    repairedRingKeys.add(key);
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
    repairedRingKeys,
  };
};
