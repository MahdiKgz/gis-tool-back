import area from "@turf/area";
import { featureCollection, polygon } from "@turf/helpers";
import intersect from "@turf/intersect";
import kinks from "@turf/kinks";
import RBush from "rbush";
import { detectInvalidHoles } from "../invalid-holes";
import { detectMultipartIntegrity } from "../multipart-integrity";
import { calculateRingOrientation } from "../ring-orientation";
import { isFinitePosition, Position } from "../shared/coordinates";
import {
  CoordinatePathUpdate,
  updateGeometryAtCoordinatePaths,
} from "../shared/geometry-path";
import { visitPolygonComponents } from "../shared/polygon-components";
import { distanceMetersBetweenPositions } from "../shared/spatial-segments";
import { SpatialBounds } from "../shared/spatial-segments";
import {
  DEFAULT_MAX_GAP_WIDTH_TO_SHARED_BOUNDARY_RATIO,
  DEFAULT_MAX_INFERRED_GAP_WIDTH_M,
} from "./detector";
import {
  FeatureCollectionLike,
  GapFinding,
  GapOptions,
  GapRepairFailureReason,
} from "./types";

const FLOAT_EDGE_EPSILON_M2 = 1e-8;

export interface GapRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  repairedKeys: Set<string>;
  failedReasons: Map<string, GapRepairFailureReason>;
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

interface IndexedPolygonFeature extends SpatialBounds {
  featureIndex: number;
}

const inferredRepairDistanceLimit = (
  finding: GapFinding,
  options: GapOptions,
): number => {
  if (finding.distanceMeters <= options.gapToleranceMeters) {
    return options.gapToleranceMeters;
  }
  if (
    finding.sharedBoundaryLengthMeters === null ||
    finding.gapWidthToSharedBoundaryRatio === null
  ) {
    return options.gapToleranceMeters;
  }
  return Math.min(
    options.maxInferredGapWidthMeters ?? DEFAULT_MAX_INFERRED_GAP_WIDTH_M,
    finding.sharedBoundaryLengthMeters *
      (options.maxGapWidthToSharedBoundaryRatio ??
        DEFAULT_MAX_GAP_WIDTH_TO_SHARED_BOUNDARY_RATIO),
  );
};

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

const ringOrientations = (feature: unknown): string[] | null => {
  const candidate = feature as {
    geometry?: Parameters<typeof visitPolygonComponents>[0];
  };
  const orientations: string[] = [];
  let valid = true;
  visitPolygonComponents(candidate.geometry, (component) => {
    for (const ring of component.coordinates) {
      try {
        const orientation = calculateRingOrientation(ring);
        if (orientation === "indeterminate") {
          valid = false;
          return;
        }
        orientations.push(orientation);
      } catch {
        valid = false;
      }
    }
  });
  return valid && orientations.length > 0 ? orientations : null;
};

const validPolygonFeature = (
  originalFeature: unknown,
  feature: unknown,
): boolean => {
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
  if (!valid || componentsFound === 0) return false;

  const originalOrientations = ringOrientations(originalFeature);
  const candidateOrientations = ringOrientations(feature);
  if (
    originalOrientations === null ||
    candidateOrientations === null ||
    originalOrientations.length !== candidateOrientations.length ||
    originalOrientations.some(
      (orientation, index) => orientation !== candidateOrientations[index],
    )
  ) {
    return false;
  }

  const collection: FeatureCollectionLike = {
    type: "FeatureCollection",
    features: [feature as any],
  };
  return (
    detectInvalidHoles(collection, { tinyHoleAreaM2: 0 }).findings.length ===
      0 && detectMultipartIntegrity(collection).findings.length === 0
  );
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

const polygonFeatureBounds = (
  geojson: FeatureCollectionLike,
  featureIndex: number,
): IndexedPolygonFeature | null => {
  const feature = geojson.features?.[featureIndex];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let componentsFound = 0;
  visitPolygonComponents(feature?.geometry, (component) => {
    componentsFound++;
    for (const ring of component.coordinates) {
      for (const position of ring) {
        minX = Math.min(minX, position[0]!);
        minY = Math.min(minY, position[1]!);
        maxX = Math.max(maxX, position[0]!);
        maxY = Math.max(maxY, position[1]!);
      }
    }
  });
  return componentsFound > 0
    ? { minX, minY, maxX, maxY, featureIndex }
    : null;
};

const polygonOverlapAreaM2 = (
  geojson: FeatureCollectionLike,
  firstIndex: number,
  secondIndex: number,
): number => {
  const first = geojson.features?.[firstIndex];
  const second = geojson.features?.[secondIndex];
  if (!first || !second) return Number.POSITIVE_INFINITY;
  try {
    const overlap = intersect(featureCollection([first as any, second as any]));
    return overlap ? area(overlap) : 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const candidateIntroducesOverlap = (
  before: FeatureCollectionLike,
  candidate: FeatureCollectionLike,
  affectedFeatureIndexes: number[],
  spatialIndex: RBush<IndexedPolygonFeature>,
): boolean => {
  const checkedPairs = new Set<string>();
  for (const featureIndex of affectedFeatureIndexes) {
    const bounds = polygonFeatureBounds(candidate, featureIndex);
    if (!bounds) return true;
    for (const neighbor of spatialIndex.search(bounds)) {
      if (neighbor.featureIndex === featureIndex) continue;
      const first = Math.min(featureIndex, neighbor.featureIndex);
      const second = Math.max(featureIndex, neighbor.featureIndex);
      const key = `${first}:${second}`;
      if (checkedPairs.has(key)) continue;
      checkedPairs.add(key);
      const beforeArea = polygonOverlapAreaM2(before, first, second);
      const afterArea = polygonOverlapAreaM2(candidate, first, second);
      if (
        !Number.isFinite(beforeArea) ||
        !Number.isFinite(afterArea) ||
        afterArea > Math.max(FLOAT_EDGE_EPSILON_M2, beforeArea + FLOAT_EDGE_EPSILON_M2)
      ) {
        return true;
      }
    }
  }
  return false;
};

export const repairGaps = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: GapFinding[],
  options: GapOptions,
): GapRepairResult<T> => {
  if (!Array.isArray(geojson.features) || findings.length === 0) {
    return {
      geojson,
      repairedKeys: new Set(),
      failedReasons: new Map(),
    };
  }
  let repaired = geojson as FeatureCollectionLike;
  const repairedKeys = new Set<string>();
  const failedReasons = new Map<string, GapRepairFailureReason>();
  const spatialIndex = new RBush<IndexedPolygonFeature>();
  const indexedByFeature = new Map<number, IndexedPolygonFeature>();
  for (let featureIndex = 0; featureIndex < geojson.features.length; featureIndex++) {
    const bounds = polygonFeatureBounds(geojson, featureIndex);
    if (!bounds) continue;
    indexedByFeature.set(featureIndex, bounds);
    spatialIndex.insert(bounds);
  }

  for (const finding of findings) {
    if (!finding.repairable) continue;
    const key = gapFindingKey(finding);
    const endpoints = matchedEndpoints(
      repaired,
      finding,
      inferredRepairDistanceLimit(finding, options),
    );
    if (!endpoints) {
      failedReasons.set(key, "StaleTarget");
      continue;
    }
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
    if (!candidate) {
      failedReasons.set(key, "InvalidRepairOutput");
      continue;
    }
    candidate = updateSegment(
      candidate,
      finding.relatedFeatureIndex,
      finding.relatedGeometryCollectionPath,
      finding.relatedCoordinatePath,
      endpoints.secondTargetsReversed ? endTarget : startTarget,
      endpoints.secondTargetsReversed ? startTarget : endTarget,
    );
    if (!candidate) {
      failedReasons.set(key, "InvalidRepairOutput");
      continue;
    }
    if (
      !validPolygonFeature(
        repaired.features?.[finding.featureIndex],
        candidate.features?.[finding.featureIndex],
      ) ||
      !validPolygonFeature(
        repaired.features?.[finding.relatedFeatureIndex],
        candidate.features?.[finding.relatedFeatureIndex],
      ) ||
      !pairHasNoAreaOverlap(
        candidate,
        finding.featureIndex,
        finding.relatedFeatureIndex,
      )
    ) {
      failedReasons.set(key, "InvalidRepairOutput");
      continue;
    }
    if (
      candidateIntroducesOverlap(
        repaired,
        candidate,
        [finding.featureIndex, finding.relatedFeatureIndex],
        spatialIndex,
      )
    ) {
      failedReasons.set(key, "WouldCreateOverlap");
      continue;
    }
    repaired = candidate;
    repairedKeys.add(key);
    for (const featureIndex of [
      finding.featureIndex,
      finding.relatedFeatureIndex,
    ]) {
      const previousBounds = indexedByFeature.get(featureIndex);
      if (previousBounds) spatialIndex.remove(previousBounds);
      const nextBounds = polygonFeatureBounds(repaired, featureIndex);
      if (!nextBounds) continue;
      indexedByFeature.set(featureIndex, nextBounds);
      spatialIndex.insert(nextBounds);
    }
  }

  return { geojson: repaired as T, repairedKeys, failedReasons };
};
