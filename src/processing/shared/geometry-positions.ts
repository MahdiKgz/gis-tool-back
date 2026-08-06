import { GeometryLike } from "./geojson";

export interface GeometryPositionCandidate {
  geometryType: string;
  geometryCollectionPath: number[];
  coordinatePath: number[];
  value: unknown;
}

const coordinateDepthByType: Record<string, number> = {
  Point: 0,
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
};

const visitAtDepth = (
  value: unknown,
  depth: number,
  coordinatePath: number[],
  visit: (value: unknown, coordinatePath: number[]) => void,
): void => {
  if (depth === 0) {
    visit(value, coordinatePath);
    return;
  }
  if (!Array.isArray(value)) return;
  value.forEach((child, index) =>
    visitAtDepth(child, depth - 1, [...coordinatePath, index], visit),
  );
};

export const visitGeometryPositions = (
  geometry: GeometryLike | null | undefined,
  visitor: (candidate: GeometryPositionCandidate) => void,
  geometryCollectionPath: number[] = [],
): void => {
  if (!geometry?.type) return;
  if (geometry.type === "GeometryCollection") {
    if (!Array.isArray(geometry.geometries)) return;
    geometry.geometries.forEach((child, index) =>
      visitGeometryPositions(child, visitor, [
        ...geometryCollectionPath,
        index,
      ]),
    );
    return;
  }

  const depth = coordinateDepthByType[geometry.type];
  if (depth === undefined) return;
  visitAtDepth(geometry.coordinates, depth, [], (value, coordinatePath) =>
    visitor({
      geometryType: geometry.type!,
      geometryCollectionPath,
      coordinatePath,
      value,
    }),
  );
};
