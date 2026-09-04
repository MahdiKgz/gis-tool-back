import booleanIntersects from "@turf/boolean-intersects";
import { polygon } from "@turf/helpers";
import RBush from "rbush";
import { getFeatureId } from "../shared/feature-id";
import { visitPolygonComponents } from "../shared/polygon-components";
import {
  closestPointsBetweenSegments,
  distanceMetersBetweenPositions,
  expandBoundsByMeters,
  segmentBounds,
  SpatialBounds,
} from "../shared/spatial-segments";
import { Position } from "../shared/coordinates";
import {
  FeatureCollectionLike,
  GapDetectionResult,
  GapFinding,
  GapOptions,
} from "./types";

const CONTACT_EPSILON_METERS = 1e-6;

export const GAP_TOLERANCE_MULTIPLIER = 3;
export const DEFAULT_MAX_INFERRED_GAP_WIDTH_M = 50;
export const DEFAULT_MAX_GAP_WIDTH_TO_SHARED_BOUNDARY_RATIO = 0.1;
export const DEFAULT_MIN_SHARED_BOUNDARY_RATIO = 0.5;
export const DEFAULT_MAX_PARALLEL_ANGLE_DEGREES = 5;

export const computeGapToleranceMeters = (
  toleranceMeters: number,
): number => toleranceMeters * GAP_TOLERANCE_MULTIPLIER;

interface PolygonBoundary {
  componentIndex: number;
  featureIndex: number;
  featureId: string | number | null;
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  polygonPath: number[];
  coordinates: Position[][];
}

interface IndexedBoundarySegment extends SpatialBounds {
  componentIndex: number;
  ringIndex: number;
  segmentIndex: number;
  start: Position;
  end: Position;
  lengthMeters: number;
}

interface PairCandidate {
  first: IndexedBoundarySegment;
  second: IndexedBoundarySegment;
  firstPosition: Position;
  secondPosition: Position;
  distanceMeters: number;
  detectionMode: "Tolerance" | "SharedBoundaryPattern";
  sharedBoundaryLengthMeters: number | null;
  sharedBoundaryRatio: number | null;
  gapWidthToSharedBoundaryRatio: number | null;
}

interface NormalizedGapOptions {
  gapToleranceMeters: number;
  minimumGapWidthMeters: number;
  maxInferredGapWidthMeters: number;
  maxGapWidthToSharedBoundaryRatio: number;
  minSharedBoundaryRatio: number;
  maxParallelAngleDegrees: number;
}

interface ParallelBoundaryEvidence {
  firstPosition: Position;
  secondPosition: Position;
  distanceMeters: number;
  sharedBoundaryLengthMeters: number;
  sharedBoundaryRatio: number;
  gapWidthToSharedBoundaryRatio: number;
}

const EARTH_RADIUS_METERS = 6_371_008.8;
const DEGREES_TO_RADIANS = Math.PI / 180;

const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));

const interpolate = (
  start: Position,
  end: Position,
  fraction: number,
): Position => [
  start[0]! + (end[0]! - start[0]!) * fraction,
  start[1]! + (end[1]! - start[1]!) * fraction,
];

const parallelBoundaryEvidence = (
  first: IndexedBoundarySegment,
  second: IndexedBoundarySegment,
  options: NormalizedGapOptions,
): ParallelBoundaryEvidence | null => {
  const originLongitude = first.start[0]!;
  const originLatitude =
    (first.start[1]! + first.end[1]! + second.start[1]! + second.end[1]!) /
    4;
  const longitudeScale =
    Math.cos(originLatitude * DEGREES_TO_RADIANS) * EARTH_RADIUS_METERS;
  const project = (position: Position) => ({
    x: (position[0]! - originLongitude) * DEGREES_TO_RADIANS * longitudeScale,
    y: (position[1]! - originLatitude) * DEGREES_TO_RADIANS * EARTH_RADIUS_METERS,
  });
  const firstStart = project(first.start);
  const firstEnd = project(first.end);
  const secondStart = project(second.start);
  const secondEnd = project(second.end);
  const firstVector = {
    x: firstEnd.x - firstStart.x,
    y: firstEnd.y - firstStart.y,
  };
  const secondVector = {
    x: secondEnd.x - secondStart.x,
    y: secondEnd.y - secondStart.y,
  };
  const firstLength = Math.hypot(firstVector.x, firstVector.y);
  const secondLength = Math.hypot(secondVector.x, secondVector.y);
  if (firstLength <= Number.EPSILON || secondLength <= Number.EPSILON) {
    return null;
  }
  const firstUnit = {
    x: firstVector.x / firstLength,
    y: firstVector.y / firstLength,
  };
  const secondUnit = {
    x: secondVector.x / secondLength,
    y: secondVector.y / secondLength,
  };
  const parallelCosine = Math.min(
    1,
    Math.abs(firstUnit.x * secondUnit.x + firstUnit.y * secondUnit.y),
  );
  const angleDegrees = (Math.acos(parallelCosine) * 180) / Math.PI;
  if (angleDegrees > options.maxParallelAngleDegrees) return null;

  const projection = (point: { x: number; y: number }): number =>
    (point.x - firstStart.x) * firstUnit.x +
    (point.y - firstStart.y) * firstUnit.y;
  const secondStartProjection = projection(secondStart);
  const secondEndProjection = projection(secondEnd);
  const sharedStart = Math.max(
    0,
    Math.min(secondStartProjection, secondEndProjection),
  );
  const sharedEnd = Math.min(
    firstLength,
    Math.max(secondStartProjection, secondEndProjection),
  );
  const sharedBoundaryLengthMeters = Math.max(0, sharedEnd - sharedStart);
  const sharedBoundaryRatio =
    sharedBoundaryLengthMeters / Math.min(firstLength, secondLength);
  if (
    sharedBoundaryLengthMeters <= Number.EPSILON ||
    sharedBoundaryRatio < options.minSharedBoundaryRatio
  ) {
    return null;
  }

  const midpointProjection = (sharedStart + sharedEnd) / 2;
  const firstFraction = clampUnit(midpointProjection / firstLength);
  const projectionDelta = secondEndProjection - secondStartProjection;
  if (Math.abs(projectionDelta) <= Number.EPSILON) return null;
  const secondFraction = clampUnit(
    (midpointProjection - secondStartProjection) / projectionDelta,
  );
  const firstPosition = interpolate(first.start, first.end, firstFraction);
  const secondPosition = interpolate(second.start, second.end, secondFraction);
  const distanceMeters = distanceMetersBetweenPositions(
    firstPosition,
    secondPosition,
  );
  const gapWidthToSharedBoundaryRatio =
    distanceMeters / sharedBoundaryLengthMeters;
  if (
    distanceMeters > options.maxInferredGapWidthMeters ||
    gapWidthToSharedBoundaryRatio >
      options.maxGapWidthToSharedBoundaryRatio
  ) {
    return null;
  }
  return {
    firstPosition,
    secondPosition,
    distanceMeters,
    sharedBoundaryLengthMeters,
    sharedBoundaryRatio,
    gapWidthToSharedBoundaryRatio,
  };
};

const normalizeOptions = (options: GapOptions): NormalizedGapOptions => {
  const normalized = {
    gapToleranceMeters: options.gapToleranceMeters,
    minimumGapWidthMeters: options.minimumGapWidthMeters ?? 0,
    maxInferredGapWidthMeters:
      options.maxInferredGapWidthMeters ?? DEFAULT_MAX_INFERRED_GAP_WIDTH_M,
    maxGapWidthToSharedBoundaryRatio:
      options.maxGapWidthToSharedBoundaryRatio ??
      DEFAULT_MAX_GAP_WIDTH_TO_SHARED_BOUNDARY_RATIO,
    minSharedBoundaryRatio:
      options.minSharedBoundaryRatio ?? DEFAULT_MIN_SHARED_BOUNDARY_RATIO,
    maxParallelAngleDegrees:
      options.maxParallelAngleDegrees ?? DEFAULT_MAX_PARALLEL_ANGLE_DEGREES,
  };
  if (
    !Number.isFinite(normalized.gapToleranceMeters) ||
    normalized.gapToleranceMeters < 0 ||
    !Number.isFinite(normalized.minimumGapWidthMeters) ||
    normalized.minimumGapWidthMeters < 0 ||
    !Number.isFinite(normalized.maxInferredGapWidthMeters) ||
    normalized.maxInferredGapWidthMeters < 0
  ) {
    throw new RangeError("gap distances must be finite non-negative numbers");
  }
  if (
    !Number.isFinite(normalized.maxGapWidthToSharedBoundaryRatio) ||
    normalized.maxGapWidthToSharedBoundaryRatio <= 0 ||
    !Number.isFinite(normalized.minSharedBoundaryRatio) ||
    normalized.minSharedBoundaryRatio <= 0 ||
    normalized.minSharedBoundaryRatio > 1
  ) {
    throw new RangeError("gap boundary ratios must be finite and between 0 and 1");
  }
  if (
    !Number.isFinite(normalized.maxParallelAngleDegrees) ||
    normalized.maxParallelAngleDegrees < 0 ||
    normalized.maxParallelAngleDegrees >= 90
  ) {
    throw new RangeError("maxParallelAngleDegrees must be finite and below 90");
  }
  return normalized;
};

const pairKey = (first: number, second: number): string =>
  first < second ? `${first}:${second}` : `${second}:${first}`;

const collectBoundaries = (
  geojson: FeatureCollectionLike,
): PolygonBoundary[] => {
  const boundaries: PolygonBoundary[] = [];
  if (!Array.isArray(geojson.features)) return boundaries;

  geojson.features.forEach((feature, featureIndex) => {
    visitPolygonComponents(feature.geometry, (component) => {
      boundaries.push({
        componentIndex: boundaries.length,
        featureIndex,
        featureId: getFeatureId(feature),
        geometryType: component.geometryType,
        geometryCollectionPath: [...component.geometryCollectionPath],
        polygonPath: [...component.polygonPath],
        coordinates: component.coordinates,
      });
    });
  });
  return boundaries;
};

const indexBoundarySegments = (
  boundaries: PolygonBoundary[],
): IndexedBoundarySegment[] =>
  boundaries.flatMap((boundary) =>
    boundary.coordinates.flatMap((ring, ringIndex) =>
      ring.slice(0, -1).flatMap((start, segmentIndex) => {
        const end = ring[segmentIndex + 1]!;
        if (start[0] === end[0] && start[1] === end[1]) return [];
        return [{
          ...segmentBounds(start, end),
          componentIndex: boundary.componentIndex,
          ringIndex,
          segmentIndex,
          start,
          end,
          lengthMeters: distanceMetersBetweenPositions(start, end),
        }];
      }),
    ),
  );

const polygonsIntersect = (
  first: PolygonBoundary,
  second: PolygonBoundary,
): boolean => {
  try {
    return booleanIntersects(
      polygon(first.coordinates as any),
      polygon(second.coordinates as any),
    );
  } catch {
    return true;
  }
};

const findingFromCandidate = (
  candidate: PairCandidate,
  boundaries: PolygonBoundary[],
  toleranceMeters: number,
): GapFinding => {
  const first = boundaries[candidate.first.componentIndex]!;
  const second = boundaries[candidate.second.componentIndex]!;
  const directEndpointDistance = Math.max(
    distanceMetersBetweenPositions(
      candidate.first.start,
      candidate.second.start,
    ),
    distanceMetersBetweenPositions(candidate.first.end, candidate.second.end),
  );
  const reversedEndpointDistance = Math.max(
    distanceMetersBetweenPositions(
      candidate.first.start,
      candidate.second.end,
    ),
    distanceMetersBetweenPositions(candidate.first.end, candidate.second.start),
  );
  const hasCompleteExteriorEdgeMatch =
    candidate.first.ringIndex === 0 &&
    candidate.second.ringIndex === 0 &&
    candidate.sharedBoundaryRatio !== null &&
    candidate.sharedBoundaryRatio >= 0.98 &&
    Math.min(directEndpointDistance, reversedEndpointDistance) <=
      toleranceMeters;
  return {
    code: "POLYGON_GAP",
    featureIndex: first.featureIndex,
    featureId: first.featureId,
    relatedFeatureIndex: second.featureIndex,
    relatedFeatureId: second.featureId,
    geometryType: first.geometryType,
    relatedGeometryType: second.geometryType,
    geometryCollectionPath: [...first.geometryCollectionPath],
    relatedGeometryCollectionPath: [...second.geometryCollectionPath],
    polygonPath: [...first.polygonPath],
    relatedPolygonPath: [...second.polygonPath],
    coordinatePath: [
      ...first.polygonPath,
      candidate.first.ringIndex,
      candidate.first.segmentIndex,
    ],
    relatedCoordinatePath: [
      ...second.polygonPath,
      candidate.second.ringIndex,
      candidate.second.segmentIndex,
    ],
    nearestPosition: candidate.firstPosition,
    relatedNearestPosition: candidate.secondPosition,
    distanceMeters: candidate.distanceMeters,
    toleranceMeters,
    detectionMode: candidate.detectionMode,
    sharedBoundaryLengthMeters: candidate.sharedBoundaryLengthMeters,
    sharedBoundaryRatio: candidate.sharedBoundaryRatio,
    gapWidthToSharedBoundaryRatio:
      candidate.gapWidthToSharedBoundaryRatio,
    repairable:
      candidate.distanceMeters <= toleranceMeters &&
      hasCompleteExteriorEdgeMatch,
  };
};

export const detectGaps = (
  geojson: FeatureCollectionLike,
  options: GapOptions,
): GapDetectionResult => {
  const normalized = normalizeOptions(options);
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { polygonComponentsScanned: 0, candidatePairsChecked: 0, findings: [] };
  }

  const boundaries = collectBoundaries(geojson);
  if (
    normalized.gapToleranceMeters === 0 &&
    normalized.maxInferredGapWidthMeters === 0
  ) {
    return {
      polygonComponentsScanned: boundaries.length,
      candidatePairsChecked: 0,
      findings: [],
    };
  }
  const segments = indexBoundarySegments(boundaries);
  const spatialIndex = new RBush<IndexedBoundarySegment>();
  spatialIndex.load(segments);
  const closestByPair = new Map<string, PairCandidate>();
  const touchingPairs = new Set<string>();

  for (const first of segments) {
    const candidates = spatialIndex.search(
      expandBoundsByMeters(
        first,
        Math.max(
          normalized.gapToleranceMeters,
          Math.min(
            normalized.maxInferredGapWidthMeters,
            first.lengthMeters *
              normalized.maxGapWidthToSharedBoundaryRatio,
          ),
        ),
      ),
    );
    for (const second of candidates) {
      if (second.componentIndex <= first.componentIndex) continue;
      if (
        boundaries[first.componentIndex]!.featureIndex ===
        boundaries[second.componentIndex]!.featureIndex
      ) {
        continue;
      }
      const key = pairKey(first.componentIndex, second.componentIndex);
      const proximity = closestPointsBetweenSegments(
        first.start,
        first.end,
        second.start,
        second.end,
      );
      if (proximity.distanceMeters <= CONTACT_EPSILON_METERS) {
        touchingPairs.add(key);
        closestByPair.delete(key);
        continue;
      }
      if (touchingPairs.has(key)) continue;
      const sharedBoundary = parallelBoundaryEvidence(
        first,
        second,
        normalized,
      );
      const withinTolerance =
        proximity.distanceMeters <= normalized.gapToleranceMeters;
      if (!withinTolerance && !sharedBoundary) continue;
      const candidateDistance = sharedBoundary?.distanceMeters ??
        proximity.distanceMeters;
      if (
        candidateDistance <=
        normalized.minimumGapWidthMeters + CONTACT_EPSILON_METERS
      ) {
        continue;
      }
      const previous = closestByPair.get(key);
      if (previous) {
        const previousHasBoundaryEvidence =
          previous.sharedBoundaryLengthMeters !== null;
        const candidateHasBoundaryEvidence = sharedBoundary !== null;
        if (
          (previousHasBoundaryEvidence && !candidateHasBoundaryEvidence) ||
          (previousHasBoundaryEvidence === candidateHasBoundaryEvidence &&
            previous.distanceMeters <= candidateDistance)
        ) {
          continue;
        }
      }
      closestByPair.set(key, {
        first,
        second,
        firstPosition:
          sharedBoundary?.firstPosition ?? proximity.firstPosition,
        secondPosition:
          sharedBoundary?.secondPosition ?? proximity.secondPosition,
        distanceMeters: candidateDistance,
        detectionMode: withinTolerance
          ? "Tolerance"
          : "SharedBoundaryPattern",
        sharedBoundaryLengthMeters:
          sharedBoundary?.sharedBoundaryLengthMeters ?? null,
        sharedBoundaryRatio: sharedBoundary?.sharedBoundaryRatio ?? null,
        gapWidthToSharedBoundaryRatio:
          sharedBoundary?.gapWidthToSharedBoundaryRatio ?? null,
      });
    }
  }

  let candidatePairsChecked = 0;
  const findings: GapFinding[] = [];
  for (const [key, candidate] of closestByPair) {
    if (touchingPairs.has(key)) continue;
    candidatePairsChecked++;
    const first = boundaries[candidate.first.componentIndex]!;
    const second = boundaries[candidate.second.componentIndex]!;
    if (polygonsIntersect(first, second)) continue;
    findings.push(
      findingFromCandidate(
        candidate,
        boundaries,
        normalized.gapToleranceMeters,
      ),
    );
  }

  return {
    polygonComponentsScanned: boundaries.length,
    candidatePairsChecked,
    findings,
  };
};
