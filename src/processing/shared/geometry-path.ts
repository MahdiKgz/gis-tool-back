import { GeometryLike } from "./geojson";

export interface CoordinatePathUpdate {
  geometryCollectionPath: number[];
  coordinatePath: number[];
  transform: (value: unknown) => unknown;
}

const pathsEqual = (first: number[], second: number[]): boolean =>
  first.length === second.length &&
  first.every((part, index) => part === second[index]);

interface UpdateTree {
  transforms: Array<(value: unknown) => unknown>;
  children: Map<number, UpdateTree>;
}

const buildUpdateTree = (
  updates: CoordinatePathUpdate[],
): UpdateTree => {
  const root: UpdateTree = { transforms: [], children: new Map() };

  for (const update of updates) {
    let node = root;
    for (const pathPart of update.coordinatePath) {
      const child = node.children.get(pathPart) ?? {
        transforms: [],
        children: new Map<number, UpdateTree>(),
      };
      node.children.set(pathPart, child);
      node = child;
    }
    node.transforms.push(update.transform);
  }

  return root;
};

const applyUpdateTree = (
  value: unknown,
  tree: UpdateTree,
): unknown => {
  let updatedValue = value;
  for (const transform of tree.transforms) {
    updatedValue = transform(updatedValue);
  }

  if (tree.children.size === 0 || !Array.isArray(updatedValue)) {
    return updatedValue;
  }

  const updated = updatedValue.slice();
  for (const [index, childTree] of tree.children) {
    if (index < 0 || index >= updated.length) continue;
    updated[index] = applyUpdateTree(updated[index], childTree);
  }
  return updated;
};

export const updateGeometryAtCoordinatePaths = (
  geometry: GeometryLike | null | undefined,
  updates: CoordinatePathUpdate[],
  geometryCollectionPath: number[] = [],
): GeometryLike | null | undefined => {
  if (!geometry || updates.length === 0) return geometry;

  if (geometry.type === "GeometryCollection") {
    if (!Array.isArray(geometry.geometries)) return geometry;

    const updatesByChild = new Map<number, CoordinatePathUpdate[]>();
    for (const update of updates) {
      if (
        update.geometryCollectionPath.length <=
        geometryCollectionPath.length
      ) {
        continue;
      }
      const childIndex =
        update.geometryCollectionPath[geometryCollectionPath.length];
      if (childIndex === undefined) continue;
      const childUpdates = updatesByChild.get(childIndex) ?? [];
      childUpdates.push(update);
      updatesByChild.set(childIndex, childUpdates);
    }

    let changed = false;
    const geometries = geometry.geometries.map((child, index) => {
      const childPath = [...geometryCollectionPath, index];
      const childUpdates = updatesByChild.get(index);
      if (!childUpdates) return child;
      changed = true;
      return updateGeometryAtCoordinatePaths(
        child,
        childUpdates,
        childPath,
      )!;
    });

    return changed ? { ...geometry, geometries } : geometry;
  }

  const localUpdates = updates.filter((update) =>
    pathsEqual(update.geometryCollectionPath, geometryCollectionPath),
  );
  if (localUpdates.length === 0) return geometry;

  const coordinates = applyUpdateTree(
    geometry.coordinates,
    buildUpdateTree(localUpdates),
  );
  return { ...geometry, coordinates };
};
