import area from "@turf/area";
import { featureCollection, polygon } from "@turf/helpers";
import intersect from "@turf/intersect";
import kinks from "@turf/kinks";
import { isFinitePosition, Position } from "../shared/coordinates";
import {
  CoordinatePathUpdate,
  updateGeometryAtCoordinatePaths,
} from "../shared/geometry-path";
import { visitPolygonComponents } from "../shared/polygon-components";
import { distanceMetersBetweenPositions } from "../shared/spatial-segments";
import {
  FeatureCollectionLike,
  GapFinding,
  GapOptions,
} from "./types";

const FLOAT_EDGE_EPSILON_M2 = 1e-8;

export interface GapRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  repairedKeys: Set<string>;
}

export const gapFindingKey = (finding: GapFinding): string =>
  `${finding.featureIndex}|${finding.coordinatePath.join(".")}|` +
  `${finding.relatedFeatureIndex}|${finding.relatedCoordinatePath.join(".")}`;

const midpoint = (first: Position, second: Position): Position => [
  (first[0]! + second[0]!) / 2,
  (first[1]! + second[1]!) / 2,
];

const replace2d = (position: Position, replacement: Position): Position => [
  replacement[0]!,
  replacement[1]!,
  ...position.slice(2),
];

const ringAtPath = (
  geojson: FeatureCollectionLike,
  featureIndex: number,
  geometryCollectionPath: number[],
  coordinatePath: number[],
): Position[] | null => {
  let geometry = geojson.features?.[featureIndex]?.geometry;
  for (const childIndex of geometryCollectionPath) {
    geometry = geometry?.geometries?.[childIndex];
  }
  let value: unknown = geometry?.coordinates;
  for (const pathPart of coordinatePath.slice(0, -1)) {
    if (!Array.isArray(value)) return null;
    value = value[pathPart];
  }
  return Array.isArray(value) && value.every(isFinitePosition)
    ? (value as Position[])
    : null;
};

interface MatchedEndpoints {
  firstStart: Position;
  firstEnd: Position;
  secondStart: Position;
  secondEnd: Position;
  secondTargetsReversed: boolean;
}

const matchedEndpoints = (
  geojson: FeatureCollectionLike,
  finding: GapFinding,
  toleranceMeters: number,
): MatchedEndpoints | null => {
  const firstRing = ringAtPath(
    geojson,
    finding.featureIndex,
    finding.geometryCollectionPath,
    finding.coordinatePath,
  );
  const secondRing = ringAtPath(
    geojson,
    finding.relatedFeatureIndex,
    finding.relatedGeometryCollectionPath,
    finding.relatedCoordinatePath,
  );
  const firstIndex = finding.coordinatePath.at(-1);
  const secondIndex = finding.relatedCoordinatePath.at(-1);
  if (
    !firstRing ||
    !secondRing ||
    firstIndex === undefined ||
    secondIndex === undefined ||
    firstIndex < 0 ||
    secondIndex < 0 ||
    firstIndex + 1 >= firstRing.length ||
    secondIndex + 1 >= secondRing.length
  ) {
    return null;
  }
  const firstStart = firstRing[firstIndex]!;
  const firstEnd = firstRing[firstIndex + 1]!;
  const secondStart = secondRing[secondIndex]!;
  const secondEnd = secondRing[secondIndex + 1]!;
  const direct = Math.max(
    distanceMetersBetweenPositions(firstStart, secondStart),
    distanceMetersBetweenPositions(firstEnd, secondEnd),
  );
  const reversed = Math.max(
    distanceMetersBetweenPositions(firstStart, secondEnd),
    distanceMetersBetweenPositions(firstEnd, secondStart),
  );
  if (Math.min(direct, reversed) > toleranceMeters) return null;
  return {
    firstStart,
    firstEnd,
    secondStart,
    secondEnd,
    secondTargetsReversed: reversed < direct,
  };
};

const updateSegment = (
  geojson: FeatureCollectionLike,
  featureIndex: number,
  geometryCollectionPath: number[],
  coordinatePath: number[],
  startTarget: Position,
  endTarget: Position,
): FeatureCollectionLike | null => {
  const segmentIndex = coordinatePath.at(-1);
  const feature = geojson.features?.[featureIndex];
  if (segmentIndex === undefined || !feature) return null;
  const update: CoordinatePathUpdate = {
    geometryCollectionPath,
    coordinatePath: coordinatePath.slice(0, -1),
    transform: (value) => {
      if (!Array.isArray(value) || !value.every(isFinitePosition)) return value;
      const ring = value as Position[];
      if (segmentIndex < 0 || segmentIndex + 1 >= ring.length) return value;
      const candidate = ring.map((position) => [...position]);
      candidate[segmentIndex] = replace2d(candidate[segmentIndex]!, startTarget);
      candidate[segmentIndex + 1] = replace2d(
        candidate[segmentIndex + 1]!,
        endTarget,
      );
      if (segmentIndex === 0) {
        candidate[candidate.length - 1] = [...candidate[0]!];
      }
      if (segmentIndex + 1 === candidate.length - 1) {
        candidate[0] = [...candidate[candidate.length - 1]!];
      }
      return candidate;
    },
  };
  const features = geojson.features!.slice();
  features[featureIndex] = {
    ...feature,
    geometry:
      updateGeometryAtCoordinatePaths(feature.geometry, [update]) ?? null,
  };
  return { ...geojson, features };
};

const validPolygonFeature = (feature: unknown): boolean => {
  const candidate = feature as {
    geometry?: Parameters<typeof visitPolygonComponents>[0];
  };
  let componentsFound = 0;
  let valid = true;
  visitPolygonComponents(candidate.geometry, (component) => {
    componentsFound++;
    try {
      const polygonFeature = polygon(component.coordinates as any);
      if (
        area(polygonFeature) <= 0 ||
        kinks(polygonFeature).features.length > 0
      ) {
        valid = false;
      }
    } catch {
      valid = false;
    }
  });
  return componentsFound > 0 && valid;
};

const pairHasNoAreaOverlap = (
  geojson: FeatureCollectionLike,
  firstIndex: number,
  secondIndex: number,
): boolean => {
  const first = geojson.features?.[firstIndex];
  const second = geojson.features?.[secondIndex];
  if (!first || !second) return false;
  try {
    const overlap = intersect(featureCollection([first as any, second as any]));
    return !overlap || area(overlap) <= FLOAT_EDGE_EPSILON_M2;
  } catch {
    return false;
  }
};

export const repairGaps = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: GapFinding[],
  options: GapOptions,
): GapRepairResult<T> => {
  if (!Array.isArray(geojson.features) || findings.length === 0) {
    return { geojson, repairedKeys: new Set() };
  }
  let repaired = geojson as FeatureCollectionLike;
  const repairedKeys = new Set<string>();

  for (const finding of findings) {
    if (!finding.repairable) continue;
    const endpoints = matchedEndpoints(
      repaired,
      finding,
      options.gapToleranceMeters,
    );
    if (!endpoints) continue;
    const secondForFirstStart = endpoints.secondTargetsReversed
      ? endpoints.secondEnd
      : endpoints.secondStart;
    const secondForFirstEnd = endpoints.secondTargetsReversed
      ? endpoints.secondStart
      : endpoints.secondEnd;
    const startTarget = midpoint(endpoints.firstStart, secondForFirstStart);
    const endTarget = midpoint(endpoints.firstEnd, secondForFirstEnd);
    let candidate = updateSegment(
      repaired,
      finding.featureIndex,
      finding.geometryCollectionPath,
      finding.coordinatePath,
      startTarget,
      endTarget,
    );
    if (!candidate) continue;
    candidate = updateSegment(
      candidate,
      finding.relatedFeatureIndex,
      finding.relatedGeometryCollectionPath,
      finding.relatedCoordinatePath,
      endpoints.secondTargetsReversed ? endTarget : startTarget,
      endpoints.secondTargetsReversed ? startTarget : endTarget,
    );
    if (
      !candidate ||
      !validPolygonFeature(candidate.features?.[finding.featureIndex]) ||
      !validPolygonFeature(candidate.features?.[finding.relatedFeatureIndex]) ||
      !pairHasNoAreaOverlap(
        candidate,
        finding.featureIndex,
        finding.relatedFeatureIndex,
      )
    ) {
      continue;
    }
    repaired = candidate;
    repairedKeys.add(gapFindingKey(finding));
  }

  return { geojson: repaired as T, repairedKeys };
};
