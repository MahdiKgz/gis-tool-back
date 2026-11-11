import area from "@turf/area";
import difference from "@turf/difference";
import { featureCollection } from "@turf/helpers";
import { polygonPlane } from "./plane";
import { detectPolygonOverlaps } from "./detector";
import type { GeoJsonFeatureLike } from "../shared/geojson";

type PolygonFeature = Parameters<typeof difference>[0]["features"][number];
type PolygonGeometry = PolygonFeature["geometry"];

function restorePlane(geometry: PolygonGeometry, ordinates: number[]) {
  if (!ordinates.length) return geometry;
  const add = (rings: number[][][]) =>
    rings.map((ring) => ring.map((point) => [...point.slice(0, 2), ...ordinates]));
  return geometry.type === "Polygon"
    ? { ...geometry, coordinates: add(geometry.coordinates) }
    : { ...geometry, coordinates: geometry.coordinates.map(add) };
}

export function subtractSharedPolygonAreas<T extends GeoJsonFeatureLike>(features: T[]) {
  const { findings } = detectPolygonOverlaps({ type: "FeatureCollection", features });
  const neighbors = new Map<number, Set<number>>();
  for (const finding of findings) {
    if (!finding.repairable) continue;
    const first = neighbors.get(finding.featureIndex) ?? new Set<number>();
    const second = neighbors.get(finding.relatedFeatureIndex) ?? new Set<number>();
    first.add(finding.relatedFeatureIndex);
    second.add(finding.featureIndex);
    neighbors.set(finding.featureIndex, first);
    neighbors.set(finding.relatedFeatureIndex, second);
  }

  const polygon = (index: number): PolygonFeature => ({
    type: "Feature",
    properties: {},
    geometry: features[index]!.geometry as PolygonGeometry,
  });
  const replacements = new Map<number, PolygonGeometry | null>();
  const visited = new Set<number>();
  for (const start of neighbors.keys()) {
    if (visited.has(start)) continue;
    visited.add(start);
    const connected = [start];
    for (const index of connected) {
      for (const neighbor of neighbors.get(index)!) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        connected.push(neighbor);
      }
    }

    // Use the original polygons for every difference. A failed cut rolls back
    // its connected component so a shared area cannot survive on just one side.
    const clipped = new Map<number, PolygonGeometry | null>();
    try {
      for (const index of connected) {
        const result = difference(
          featureCollection([polygon(index), ...[...neighbors.get(index)!].map(polygon)]),
        );
        if (result && area(result) <= 1e-8) break;
        clipped.set(
          index,
          result ? restorePlane(result.geometry, polygonPlane(features[index]!.geometry) ?? []) : null,
        );
      }
    } catch {
      continue;
    }
    if (clipped.size === connected.length) {
      for (const [index, geometry] of clipped) replacements.set(index, geometry);
    }
  }

  const issues = findings.map((finding) => ({
    ...finding,
    status:
      finding.repairable &&
      replacements.has(finding.featureIndex) &&
      replacements.has(finding.relatedFeatureIndex)
        ? ("Trimmed" as const)
        : ("CriticalError" as const),
  }));
  const overlapsHealed = issues.filter((finding) => finding.status === "Trimmed").length;
  return {
    features: features.map((feature, index) => {
      const geometry = replacements.get(index);
      if (geometry === undefined) return feature;
      const { bbox: _bbox, ...rest } = feature;
      return { ...rest, geometry } as T;
    }),
    removedFeatureIndexes: new Set(
      [...replacements].filter(([, geometry]) => geometry === null).map(([index]) => index),
    ),
    overlapsHealed,
    overlapsCritical: issues.length - overlapsHealed,
    overlapErrorLog: issues,
  };
}
