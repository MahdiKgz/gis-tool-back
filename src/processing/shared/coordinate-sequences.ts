import { isFinitePosition, Position } from "./coordinates";
import { GeometryLike } from "./geojson";

export type SequenceKind = "line" | "ring";

export interface CoordinateSequence {
  geometryType: string;
  geometryCollectionPath: number[];
  coordinateRootPath: number[];
  kind: SequenceKind;
  coordinates: Position[];
}

const isSequence = (value: unknown): value is Position[] =>
  Array.isArray(value) && value.every(isFinitePosition);

export const visitCoordinateSequences = (
  geometry: GeometryLike | null | undefined,
  visitor: (sequence: CoordinateSequence) => void,
  geometryCollectionPath: number[] = [],
): void => {
  if (!geometry?.type) return;

  if (geometry.type === "GeometryCollection") {
    if (!Array.isArray(geometry.geometries)) return;
    geometry.geometries.forEach((child, index) =>
      visitCoordinateSequences(child, visitor, [
        ...geometryCollectionPath,
        index,
      ]),
    );
    return;
  }

  const coordinates = geometry.coordinates;
  if (geometry.type === "LineString" && isSequence(coordinates)) {
    visitor({
      geometryType: geometry.type,
      geometryCollectionPath,
      coordinateRootPath: [],
      kind: "line",
      coordinates,
    });
    return;
  }

  if (geometry.type === "MultiLineString" && Array.isArray(coordinates)) {
    coordinates.forEach((line, lineIndex) => {
      if (!isSequence(line)) return;
      visitor({
        geometryType: geometry.type!,
        geometryCollectionPath,
        coordinateRootPath: [lineIndex],
        kind: "line",
        coordinates: line,
      });
    });
    return;
  }

  if (geometry.type === "Polygon" && Array.isArray(coordinates)) {
    coordinates.forEach((ring, ringIndex) => {
      if (!isSequence(ring)) return;
      visitor({
        geometryType: geometry.type!,
        geometryCollectionPath,
        coordinateRootPath: [ringIndex],
        kind: "ring",
        coordinates: ring,
      });
    });
    return;
  }

  if (geometry.type !== "MultiPolygon" || !Array.isArray(coordinates)) return;
  coordinates.forEach((polygonCoordinates, polygonIndex) => {
    if (!Array.isArray(polygonCoordinates)) return;
    polygonCoordinates.forEach((ring, ringIndex) => {
      if (!isSequence(ring)) return;
      visitor({
        geometryType: geometry.type!,
        geometryCollectionPath,
        coordinateRootPath: [polygonIndex, ringIndex],
        kind: "ring",
        coordinates: ring,
      });
    });
  });
};
