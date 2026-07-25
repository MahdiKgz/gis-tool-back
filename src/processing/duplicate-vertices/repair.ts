import {
  DuplicateVertexFinding,
  FeatureCollectionLike,
} from "./types";
import {
  CoordinatePathUpdate,
  updateGeometryAtCoordinatePaths,
} from "../shared/geometry-path";

type RepairGroup = {
  geometryCollectionPath: number[];
  coordinateRootPath: number[];
  coordinateIndices: Set<number>;
};

export interface DuplicateVertexRepairResult<T = any> {
  geojson: T;
  removedCount: number;
}

const pathKey = (path: number[]): string => path.join(".");

export const repairDuplicateVertices = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: DuplicateVertexFinding[],
): DuplicateVertexRepairResult<T> => {
  const repairable = findings.filter(
    (finding) =>
      finding.repairable && finding.kind === "consecutive",
  );
  if (repairable.length === 0 || !Array.isArray(geojson?.features)) {
    return { geojson, removedCount: 0 };
  }

  const groupsByFeature = new Map<number, Map<string, RepairGroup>>();
  for (const finding of repairable) {
    const coordinateIndex = finding.coordinatePath.at(-1);
    if (coordinateIndex === undefined) continue;

    const coordinateRootPath = finding.coordinatePath.slice(0, -1);
    const groupKey = `${pathKey(finding.geometryCollectionPath)}|${pathKey(
      coordinateRootPath,
    )}`;
    const featureGroups =
      groupsByFeature.get(finding.featureIndex) ?? new Map<string, RepairGroup>();
    const group = featureGroups.get(groupKey) ?? {
      geometryCollectionPath: finding.geometryCollectionPath,
      coordinateRootPath,
      coordinateIndices: new Set<number>(),
    };
    group.coordinateIndices.add(coordinateIndex);
    featureGroups.set(groupKey, group);
    groupsByFeature.set(finding.featureIndex, featureGroups);
  }

  const features = geojson.features.map((feature: any, featureIndex: number) => {
    const featureGroups = groupsByFeature.get(featureIndex);
    if (!featureGroups) return feature;
    const updates: CoordinatePathUpdate[] = [...featureGroups.values()].map(
      (group) => ({
        geometryCollectionPath: group.geometryCollectionPath,
        coordinatePath: group.coordinateRootPath,
        transform: (coordinates) =>
          Array.isArray(coordinates)
            ? coordinates.filter(
                (_, index) => !group.coordinateIndices.has(index),
              )
            : coordinates,
      }),
    );
    return {
      ...feature,
      geometry: updateGeometryAtCoordinatePaths(feature.geometry, updates),
    };
  });

  return {
    geojson: { ...geojson, features } as T,
    removedCount: repairable.length,
  };
};
