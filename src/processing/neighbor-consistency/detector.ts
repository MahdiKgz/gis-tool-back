import RBush from "rbush";
import { cadLayer } from "../shared/cad-layer";
import { Position } from "../shared/coordinates";
import { getFeatureId } from "../shared/feature-id";
import { FeatureCollectionLike } from "../shared/geojson";
import { visitPolygonComponents } from "../shared/polygon-components";
import {
  closestPointOnSegment,
  distanceMetersBetweenPositions,
  expandBoundsByMeters,
  segmentBounds,
  SpatialBounds,
} from "../shared/spatial-segments";
import {
  NeighborConsistencyDetectionResult,
  NeighborConsistencyFinding,
  NeighborConsistencyOptions,
} from "./types";

export const DEFAULT_NEIGHBOR_COINCIDENCE_TOLERANCE_METERS = 1e-4;

interface BoundaryComponent {
  componentIndex: number;
  featureIndex: number;
  featureId: string | number | null;
  geometryType: "Polygon" | "MultiPolygon";
  geometryCollectionPath: number[];
  polygonPath: number[];
  ring: Position[];
}

interface IndexedBoundarySegment extends SpatialBounds {
  componentIndex: number;
  featureIndex: number;
  segmentIndex: number;
  start: Position;
  end: Position;
}

interface TargetCandidate {
  segment: IndexedBoundarySegment;
  position: Position;
  fraction: number;
  distanceMeters: number;
}

const normalizeTolerance = (options: NeighborConsistencyOptions): number => {
  const tolerance =
    options.coincidenceToleranceMeters ??
    DEFAULT_NEIGHBOR_COINCIDENCE_TOLERANCE_METERS;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new RangeError(
      "coincidenceToleranceMeters must be a finite positive number",
    );
  }
  return tolerance;
};

const interpolateTargetPosition = (
  start: Position,
  end: Position,
  fraction: number,
  xy: Position,
): Position => {
  const dimension = Math.max(start.length, end.length);
  const result: Position = [xy[0]!, xy[1]!];
  for (let ordinate = 2; ordinate < dimension; ordinate++) {
    const startValue = start[ordinate];
    const endValue = end[ordinate];
    if (typeof startValue === "number" && typeof endValue === "number") {
      result.push(startValue + (endValue - startValue) * fraction);
    }
  }
  return result;
};

const collectBoundaries = (
  geojson: FeatureCollectionLike,
): BoundaryComponent[] => {
  const boundaries: BoundaryComponent[] = [];
  geojson.features?.forEach((feature, featureIndex) => {
    visitPolygonComponents(feature.geometry, (component) => {
      boundaries.push({
        componentIndex: boundaries.length,
        featureIndex,
        featureId: getFeatureId(feature),
        geometryType: component.geometryType,
        geometryCollectionPath: [...component.geometryCollectionPath],
        polygonPath: [...component.polygonPath],
        ring: component.coordinates[0]!,
      });
    });
  });
  return boundaries;
};

const indexSegments = (
  boundaries: BoundaryComponent[],
): IndexedBoundarySegment[] =>
  boundaries.flatMap((boundary) =>
    boundary.ring.slice(0, -1).flatMap((start, segmentIndex) => {
      const end = boundary.ring[segmentIndex + 1]!;
      if (start[0] === end[0] && start[1] === end[1]) return [];
      return [
        {
          ...segmentBounds(start, end),
          componentIndex: boundary.componentIndex,
          featureIndex: boundary.featureIndex,
          segmentIndex,
          start,
          end,
        },
      ];
    }),
  );

const isStraightPassThroughVertex = (
  previous: Position,
  vertex: Position,
  next: Position,
  toleranceMeters: number,
): boolean => {
  const passThrough = closestPointOnSegment(vertex, previous, next);
  if (passThrough.distanceMeters > toleranceMeters) return false;
  const previousDistance = distanceMetersBetweenPositions(previous, vertex);
  const nextDistance = distanceMetersBetweenPositions(vertex, next);
  return (
    previousDistance > toleranceMeters &&
    nextDistance > toleranceMeters &&
    passThrough.fraction > 0 &&
    passThrough.fraction < 1
  );
};

const directionsAreCoincident = (
  sourceStart: Position,
  sourceEnd: Position,
  targetStart: Position,
  targetEnd: Position,
  latitude: number,
  toleranceMeters: number,
): boolean => {
  const longitudeMetersPerDegree =
    111_320 * Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
  const vector = (start: Position, end: Position) => ({
    x: (end[0]! - start[0]!) * longitudeMetersPerDegree,
    y: (end[1]! - start[1]!) * 110_574,
  });
  const source = vector(sourceStart, sourceEnd);
  const target = vector(targetStart, targetEnd);
  const sourceLength = Math.hypot(source.x, source.y);
  const targetLength = Math.hypot(target.x, target.y);
  if (sourceLength <= toleranceMeters || targetLength <= toleranceMeters) {
    return false;
  }
  const sine =
    Math.abs(source.x * target.y - source.y * target.x) /
    (sourceLength * targetLength);
  const angularTolerance = Math.min(
    1,
    toleranceMeters / Math.min(sourceLength, targetLength),
  );
  return sine <= angularTolerance;
};

const targetKey = (candidate: TargetCandidate): string =>
  `${candidate.segment.featureIndex}|${candidate.segment.componentIndex}|${candidate.segment.segmentIndex}`;

export const detectNeighborInconsistencies = (
  geojson: FeatureCollectionLike,
  options: NeighborConsistencyOptions = {},
): NeighborConsistencyDetectionResult => {
  const toleranceMeters = normalizeTolerance(options);
  const boundaries = collectBoundaries(geojson);
  const segments = indexSegments(boundaries);
  const index = new RBush<IndexedBoundarySegment>();
  index.load(segments);
  const layers = geojson.features?.map(cadLayer) ?? [];
  const findings: NeighborConsistencyFinding[] = [];
  let verticesScanned = 0;
  let candidateSegmentsChecked = 0;

  for (const source of boundaries) {
    const open = source.ring.slice(0, -1);
    if (open.length < 3) continue;
    for (let vertexIndex = 0; vertexIndex < open.length; vertexIndex++) {
      verticesScanned++;
      const previous = open[(vertexIndex - 1 + open.length) % open.length]!;
      const vertex = open[vertexIndex]!;
      const next = open[(vertexIndex + 1) % open.length]!;
      if (
        !isStraightPassThroughVertex(
          previous,
          vertex,
          next,
          toleranceMeters,
        )
      ) {
        continue;
      }

      const pointBounds: SpatialBounds = {
        minX: vertex[0]!,
        minY: vertex[1]!,
        maxX: vertex[0]!,
        maxY: vertex[1]!,
      };
      const candidates = new Map<string, TargetCandidate>();
      for (const segment of index.search(
        expandBoundsByMeters(pointBounds, toleranceMeters),
      )) {
        if (
          segment.featureIndex === source.featureIndex ||
          layers[segment.featureIndex] !== layers[source.featureIndex]
        ) {
          continue;
        }
        candidateSegmentsChecked++;
        const closest = closestPointOnSegment(
          vertex,
          segment.start,
          segment.end,
        );
        if (closest.distanceMeters > toleranceMeters) continue;
        if (
          !directionsAreCoincident(
            previous,
            next,
            segment.start,
            segment.end,
            vertex[1]!,
            toleranceMeters,
          )
        ) {
          continue;
        }

        const segmentLength = distanceMetersBetweenPositions(
          segment.start,
          segment.end,
        );
        if (segmentLength <= toleranceMeters) continue;
        const endpointFraction = toleranceMeters / segmentLength;
        if (
          closest.fraction <= endpointFraction ||
          closest.fraction >= 1 - endpointFraction
        ) {
          continue;
        }
        const candidate: TargetCandidate = {
          segment,
          position: interpolateTargetPosition(
            segment.start,
            segment.end,
            closest.fraction,
            closest.position,
          ),
          fraction: closest.fraction,
          distanceMeters: closest.distanceMeters,
        };
        candidates.set(targetKey(candidate), candidate);
      }

      const ranked = [...candidates.values()].sort(
        (first, second) =>
          first.distanceMeters - second.distanceMeters ||
          first.segment.featureIndex - second.segment.featureIndex ||
          first.segment.componentIndex - second.segment.componentIndex ||
          first.segment.segmentIndex - second.segment.segmentIndex,
      );
      const target = ranked[0];
      if (!target) continue;
      const targetBoundary = boundaries[target.segment.componentIndex]!;
      findings.push({
        code: "NEIGHBOR_VERTEX_MISMATCH",
        featureIndex: source.featureIndex,
        featureId: source.featureId,
        relatedFeatureIndex: target.segment.featureIndex,
        relatedFeatureId: targetBoundary.featureId,
        geometryType: source.geometryType,
        relatedGeometryType: targetBoundary.geometryType,
        geometryCollectionPath: [...source.geometryCollectionPath],
        relatedGeometryCollectionPath: [
          ...targetBoundary.geometryCollectionPath,
        ],
        polygonPath: [...source.polygonPath],
        relatedPolygonPath: [...targetBoundary.polygonPath],
        coordinatePath: [...source.polygonPath, 0, vertexIndex],
        relatedCoordinatePath: [
          ...targetBoundary.polygonPath,
          0,
          target.segment.segmentIndex,
        ],
        vertexPosition: [...vertex],
        insertionPosition: target.position,
        targetSegmentStart: [...target.segment.start],
        targetSegmentEnd: [...target.segment.end],
        targetSegmentFraction: target.fraction,
        offsetMeters: target.distanceMeters,
        candidateTargetCount: ranked.length,
        repairable: ranked.length === 1,
      });
    }
  }

  return {
    polygonComponentsScanned: boundaries.length,
    verticesScanned,
    candidateSegmentsChecked,
    findings,
  };
};
