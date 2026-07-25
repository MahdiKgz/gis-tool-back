import {
  DuplicateVertexFinding,
  FeatureCollectionLike,
} from "./types";

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

const updateSequence = (
  coordinates: unknown,
  path: number[],
  removeIndices: Set<number>,
): unknown => {
  if (!Array.isArray(coordinates)) return coordinates;

  if (path.length === 0) {
    return coordinates.filter((_, index) => !removeIndices.has(index));
  }

  const [head, ...tail] = path;
  if (head === undefined || head < 0 || head >= coordinates.length) {
    return coordinates;
  }

  const updated = coordinates.slice();
  updated[head] = updateSequence(updated[head], tail, removeIndices);
  return updated;
};

const repairGeometry = (
  geometry: any,
  groups: RepairGroup[],
  geometryCollectionPath: number[] = [],
): any => {
  if (!geometry || groups.length === 0) return geometry;

  if (geometry.type === "GeometryCollection") {
    const geometries = Array.isArray(geometry.geometries)
      ? geometry.geometries
      : [];
    let changed = false;
    const repairedGeometries = geometries.map((child: any, index: number) => {
      const childPath = [...geometryCollectionPath, index];
      const childGroups = groups.filter((group) =>
        group.geometryCollectionPath.length >= childPath.length &&
        childPath.every(
          (pathPart, pathIndex) =>
            group.geometryCollectionPath[pathIndex] === pathPart,
        ),
      );
      if (childGroups.length === 0) return child;
      changed = true;
      return repairGeometry(child, childGroups, childPath);
    });

    return changed ? { ...geometry, geometries: repairedGeometries } : geometry;
  }

  const localGroups = groups.filter(
    (group) =>
      pathKey(group.geometryCollectionPath) ===
      pathKey(geometryCollectionPath),
  );
  if (localGroups.length === 0) return geometry;

  let coordinates = geometry.coordinates;
  for (const group of localGroups) {
    coordinates = updateSequence(
      coordinates,
      group.coordinateRootPath,
      group.coordinateIndices,
    );
  }

  return { ...geometry, coordinates };
};

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
    return {
      ...feature,
      geometry: repairGeometry(
        feature.geometry,
        [...featureGroups.values()],
      ),
    };
  });

  return {
    geojson: { ...geojson, features } as T,
    removedCount: repairable.length,
  };
};
