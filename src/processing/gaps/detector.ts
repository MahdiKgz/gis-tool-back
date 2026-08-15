import booleanIntersects from "@turf/boolean-intersects";
import { polygon } from "@turf/helpers";
import RBush from "rbush";
import { getFeatureId } from "../shared/feature-id";
import { visitPolygonComponents } from "../shared/polygon-components";
import {
  closestPointsBetweenSegments,
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
}

interface PairCandidate {
  first: IndexedBoundarySegment;
  second: IndexedBoundarySegment;
  firstPosition: Position;
  secondPosition: Position;
  distanceMeters: number;
}

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
    repairable: true,
  };
};

export const detectGaps = (
  geojson: FeatureCollectionLike,
  options: GapOptions,
): GapDetectionResult => {
  if (
    !Number.isFinite(options.gapToleranceMeters) ||
    options.gapToleranceMeters < 0
  ) {
    throw new RangeError(
      "gapToleranceMeters must be a finite non-negative number",
    );
  }
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { polygonComponentsScanned: 0, candidatePairsChecked: 0, findings: [] };
  }

  const boundaries = collectBoundaries(geojson);
  if (options.gapToleranceMeters === 0) {
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
      expandBoundsByMeters(first, options.gapToleranceMeters),
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
      if (
        touchingPairs.has(key) ||
        proximity.distanceMeters > options.gapToleranceMeters
      ) {
        continue;
      }
      const previous = closestByPair.get(key);
      if (previous && previous.distanceMeters <= proximity.distanceMeters) {
        continue;
      }
      closestByPair.set(key, {
        first,
        second,
        firstPosition: proximity.firstPosition,
        secondPosition: proximity.secondPosition,
        distanceMeters: proximity.distanceMeters,
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
      findingFromCandidate(candidate, boundaries, options.gapToleranceMeters),
    );
  }

  return {
    polygonComponentsScanned: boundaries.length,
    candidatePairsChecked,
    findings,
  };
};
