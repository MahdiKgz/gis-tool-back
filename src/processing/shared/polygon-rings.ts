import { GeometryLike } from "./geojson";

export type RingRole = "exterior" | "interior";

export interface RingCandidate {
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  coordinatePath: number[];
  role: RingRole;
  ring: unknown;
}

const roleForIndex = (ringIndex: number): RingRole =>
  ringIndex === 0 ? "exterior" : "interior";

const visitPolygon = (
  coordinates: unknown,
  visitor: (candidate: RingCandidate) => void,
  geometryCollectionPath: number[],
): void => {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    visitor({
      geometryType: "Polygon",
      geometryCollectionPath,
      coordinatePath: [0],
      role: "exterior",
      ring: coordinates,
    });
    return;
  }

  coordinates.forEach((ring, ringIndex) =>
    visitor({
      geometryType: "Polygon",
      geometryCollectionPath,
      coordinatePath: [ringIndex],
      role: roleForIndex(ringIndex),
      ring,
    }),
  );
};

const visitMultiPolygon = (
  coordinates: unknown,
  visitor: (candidate: RingCandidate) => void,
  geometryCollectionPath: number[],
): void => {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    visitor({
      geometryType: "MultiPolygon",
      geometryCollectionPath,
      coordinatePath: [0, 0],
      role: "exterior",
      ring: coordinates,
    });
    return;
  }

  coordinates.forEach((polygon, polygonIndex) => {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      visitor({
        geometryType: "MultiPolygon",
        geometryCollectionPath,
        coordinatePath: [polygonIndex, 0],
        role: "exterior",
        ring: polygon,
      });
      return;
    }

    polygon.forEach((ring, ringIndex) =>
      visitor({
        geometryType: "MultiPolygon",
        geometryCollectionPath,
        coordinatePath: [polygonIndex, ringIndex],
        role: roleForIndex(ringIndex),
        ring,
      }),
    );
  });
};

export const visitRingCandidates = (
  geometry: GeometryLike | null | undefined,
  visitor: (candidate: RingCandidate) => void,
  geometryCollectionPath: number[] = [],
): void => {
  if (!geometry?.type) return;

  if (geometry.type === "GeometryCollection") {
    if (!Array.isArray(geometry.geometries)) return;
    geometry.geometries.forEach((child, index) =>
      visitRingCandidates(child, visitor, [
        ...geometryCollectionPath,
        index,
      ]),
    );
    return;
  }

  if (geometry.type === "Polygon") {
    visitPolygon(geometry.coordinates, visitor, geometryCollectionPath);
    return;
  }

  if (geometry.type === "MultiPolygon") {
    visitMultiPolygon(geometry.coordinates, visitor, geometryCollectionPath);
  }
};
