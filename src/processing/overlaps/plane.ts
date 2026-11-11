import { visitPolygonComponents } from "../shared/polygon-components";
import type { GeometryLike } from "../shared/geojson";

export function polygonPlane(geometry: GeometryLike | null | undefined): number[] | null {
  if (geometry?.type !== "Polygon" && geometry?.type !== "MultiPolygon") return null;
  let ordinates: number[] | undefined;
  let planar = true;
  visitPolygonComponents(geometry, ({ coordinates }) => {
    for (const ring of coordinates) {
      for (const point of ring) {
        ordinates ??= point.slice(2);
        if (
          point.length !== ordinates.length + 2 ||
          !ordinates.every((value, index) => value === point[index + 2])
        )
          planar = false;
      }
    }
  });
  return planar ? (ordinates ?? null) : null;
}
