import {
  isFinitePosition,
  Position,
  positionsEqual,
} from "./coordinates";
import { GeometryLike } from "./geojson";

export interface PolygonComponent {
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  polygonPath: number[];
  coordinates: Position[][];
}

const isClosedRing = (value: unknown): value is Position[] =>
  Array.isArray(value) &&
  value.length >= 4 &&
  value.every(isFinitePosition) &&
  positionsEqual(value[0]!, value[value.length - 1]!);

export const isValidPolygonCoordinates = (
  value: unknown,
): value is Position[][] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(isClosedRing);

export const visitPolygonComponents = (
  geometry: GeometryLike | null | undefined,
  visitor: (component: PolygonComponent) => void,
  geometryCollectionPath: number[] = [],
): void => {
  if (!geometry?.type) return;
  if (geometry.type === "GeometryCollection") {
    if (!Array.isArray(geometry.geometries)) return;
    geometry.geometries.forEach((child, index) =>
      visitPolygonComponents(child, visitor, [
        ...geometryCollectionPath,
        index,
      ]),
    );
    return;
  }

  if (
    geometry.type === "Polygon" &&
    isValidPolygonCoordinates(geometry.coordinates)
  ) {
    visitor({
      geometryType: "Polygon",
      geometryCollectionPath,
      polygonPath: [],
      coordinates: geometry.coordinates,
    });
    return;
  }

  if (
    geometry.type !== "MultiPolygon" ||
    !Array.isArray(geometry.coordinates)
  ) {
    return;
  }
  geometry.coordinates.forEach((coordinates, polygonIndex) => {
    if (!isValidPolygonCoordinates(coordinates)) return;
    visitor({
      geometryType: "MultiPolygon",
      geometryCollectionPath,
      polygonPath: [polygonIndex],
      coordinates,
    });
  });
};
