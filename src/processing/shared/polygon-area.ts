import area from "@turf/area";
import { polygon } from "@turf/helpers";
import { Position } from "./coordinates";

export const measurePolygonAreaM2 = (
  coordinates: Position[][],
): number | null => {
  try {
    const measured = area(polygon(coordinates as any));
    return Number.isFinite(measured) ? measured : null;
  } catch {
    return null;
  }
};

export const polygonComponentPathKey = (
  featureIndex: number,
  geometryCollectionPath: number[],
  polygonPath: number[],
): string =>
  `${featureIndex}|${geometryCollectionPath.join(".")}|${polygonPath.join(
    ".",
  )}`;
