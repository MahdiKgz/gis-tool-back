import {
  isFinitePosition,
  Position,
  positionsEqual,
} from "../shared/coordinates";
import { GeometryLike } from "../shared/geojson";
import { HoleCandidate } from "./types";

const isValidRing = (value: unknown): value is Position[] =>
  Array.isArray(value) &&
  value.length >= 4 &&
  value.every(isFinitePosition) &&
  positionsEqual(value[0]!, value[value.length - 1]!);

const visitPolygonCoordinates = (
  coordinates: unknown,
  geometryType: "Polygon" | "MultiPolygon",
  geometryCollectionPath: number[],
  polygonPath: number[],
  visitor: (candidate: HoleCandidate) => void,
): void => {
  if (
    !Array.isArray(coordinates) ||
    coordinates.length < 2 ||
    !isValidRing(coordinates[0])
  ) {
    return;
  }

  const exteriorRing = coordinates[0];
  for (let holeIndex = 1; holeIndex < coordinates.length; holeIndex++) {
    const ring = coordinates[holeIndex];
    if (!isValidRing(ring)) continue;
    visitor({
      geometryType,
      geometryCollectionPath,
      polygonPath,
      coordinatePath: [...polygonPath, holeIndex],
      exteriorRing,
      ring,
    });
  }
};

export const visitHoleCandidates = (
  geometry: GeometryLike | null | undefined,
  visitor: (candidate: HoleCandidate) => void,
  geometryCollectionPath: number[] = [],
): void => {
  if (!geometry?.type) return;

  if (geometry.type === "GeometryCollection") {
    if (!Array.isArray(geometry.geometries)) return;
    geometry.geometries.forEach((child, index) =>
      visitHoleCandidates(child, visitor, [
        ...geometryCollectionPath,
        index,
      ]),
    );
    return;
  }

  if (geometry.type === "Polygon") {
    visitPolygonCoordinates(
      geometry.coordinates,
      "Polygon",
      geometryCollectionPath,
      [],
      visitor,
    );
    return;
  }

  if (geometry.type !== "MultiPolygon" || !Array.isArray(geometry.coordinates)) {
    return;
  }

  geometry.coordinates.forEach((polygonCoordinates, polygonIndex) =>
    visitPolygonCoordinates(
      polygonCoordinates,
      "MultiPolygon",
      geometryCollectionPath,
      [polygonIndex],
      visitor,
    ),
  );
};
