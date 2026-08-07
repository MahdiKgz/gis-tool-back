import RBush from "rbush";
import {
  isFinitePosition,
  Position,
  positionsEqual,
} from "../shared/coordinates";
import { getFeatureId } from "../shared/feature-id";
import { visitRingCandidates } from "../shared/polygon-rings";
import {
  FeatureCollectionLike,
  SelfIntersectionDetectionResult,
  SelfIntersectionFinding,
  SelfIntersectionGeometry,
  SelfIntersectionKind,
} from "./types";

interface IndexedSegment {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  index: number;
  order: number;
  start: Position;
  end: Position;
}

interface SegmentIntersection {
  kind: SelfIntersectionKind;
  geometry: SelfIntersectionGeometry;
}

const PARAMETER_TOLERANCE = Number.EPSILON * 128;

const cross = (first: Position, second: Position): number =>
  first[0]! * second[1]! - first[1]! * second[0]!;

const subtract = (first: Position, second: Position): Position => [
  first[0]! - second[0]!,
  first[1]! - second[1]!,
];

const determinantTolerance = (
  first: Position,
  second: Position,
): number =>
  Number.EPSILON *
  64 *
  Math.max(
    Number.MIN_VALUE,
    Math.abs(first[0]! * second[1]!) +
      Math.abs(first[1]! * second[0]!),
  );

const normalizeOrdinate = (value: number): number =>
  Object.is(value, -0) ? 0 : value;

const pointAlongSegment = (
  start: Position,
  direction: Position,
  parameter: number,
): Position => [
  normalizeOrdinate(start[0]! + parameter * direction[0]!),
  normalizeOrdinate(start[1]! + parameter * direction[1]!),
];

const segmentIntersection = (
  first: IndexedSegment,
  second: IndexedSegment,
): SegmentIntersection | null => {
  const firstDirection = subtract(first.end, first.start);
  const secondDirection = subtract(second.end, second.start);
  const startDelta = subtract(second.start, first.start);
  const denominator = cross(firstDirection, secondDirection);
  const denominatorTolerance = determinantTolerance(
    firstDirection,
    secondDirection,
  );

  if (Math.abs(denominator) > denominatorTolerance) {
    const firstParameter = cross(startDelta, secondDirection) / denominator;
    const secondParameter = cross(startDelta, firstDirection) / denominator;
    if (
      firstParameter < -PARAMETER_TOLERANCE ||
      firstParameter > 1 + PARAMETER_TOLERANCE ||
      secondParameter < -PARAMETER_TOLERANCE ||
      secondParameter > 1 + PARAMETER_TOLERANCE
    ) {
      return null;
    }

    const clampedFirstParameter = Math.max(0, Math.min(1, firstParameter));
    const endpointContact =
      clampedFirstParameter <= PARAMETER_TOLERANCE ||
      clampedFirstParameter >= 1 - PARAMETER_TOLERANCE ||
      secondParameter <= PARAMETER_TOLERANCE ||
      secondParameter >= 1 - PARAMETER_TOLERANCE;
    return {
      kind: endpointContact ? "Touching" : "Crossing",
      geometry: {
        type: "Point",
        coordinates: pointAlongSegment(
          first.start,
          firstDirection,
          clampedFirstParameter,
        ),
      },
    };
  }

  if (
    Math.abs(cross(startDelta, firstDirection)) >
    determinantTolerance(startDelta, firstDirection)
  ) {
    return null;
  }

  const useX = Math.abs(firstDirection[0]!) >= Math.abs(firstDirection[1]!);
  const denominatorAxis = useX ? firstDirection[0]! : firstDirection[1]!;
  if (denominatorAxis === 0) return null;
  const firstSecondParameter =
    ((useX ? second.start[0]! : second.start[1]!) -
      (useX ? first.start[0]! : first.start[1]!)) /
    denominatorAxis;
  const secondSecondParameter =
    ((useX ? second.end[0]! : second.end[1]!) -
      (useX ? first.start[0]! : first.start[1]!)) /
    denominatorAxis;
  const overlapStart = Math.max(
    0,
    Math.min(firstSecondParameter, secondSecondParameter),
  );
  const overlapEnd = Math.min(
    1,
    Math.max(firstSecondParameter, secondSecondParameter),
  );
  if (overlapEnd < overlapStart - PARAMETER_TOLERANCE) return null;

  if (overlapEnd - overlapStart <= PARAMETER_TOLERANCE) {
    return {
      kind: "Touching",
      geometry: {
        type: "Point",
        coordinates: pointAlongSegment(
          first.start,
          firstDirection,
          Math.max(0, Math.min(1, (overlapStart + overlapEnd) / 2)),
        ),
      },
    };
  }

  return {
    kind: "Overlapping",
    geometry: {
      type: "LineString",
      coordinates: [
        pointAlongSegment(first.start, firstDirection, overlapStart),
        pointAlongSegment(first.start, firstDirection, overlapEnd),
      ],
    },
  };
};

const toIndexedSegment = (
  start: Position,
  end: Position,
  index: number,
  order: number,
): IndexedSegment => ({
  minX: Math.min(start[0]!, end[0]!),
  minY: Math.min(start[1]!, end[1]!),
  maxX: Math.max(start[0]!, end[0]!),
  maxY: Math.max(start[1]!, end[1]!),
  index,
  order,
  start,
  end,
});

const buildSegments = (ring: Position[]): IndexedSegment[] => {
  const segments: IndexedSegment[] = [];
  ring.slice(0, -1).forEach((start, index) => {
    const end = ring[index + 1]!;
    if (start[0] === end[0] && start[1] === end[1]) return;
    segments.push(toIndexedSegment(start, end, index, segments.length));
  });
  return segments;
};

const segmentsAreAdjacent = (
  firstOrder: number,
  secondOrder: number,
  segmentCount: number,
): boolean =>
  Math.abs(firstOrder - secondOrder) === 1 ||
  (firstOrder === 0 && secondOrder === segmentCount - 1);

const segmentCoordinates = (
  segment: IndexedSegment,
): [Position, Position] => [[...segment.start], [...segment.end]];

export const detectSelfIntersections = (
  geojson: FeatureCollectionLike,
): SelfIntersectionDetectionResult => {
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { ringsScanned: 0, segmentsScanned: 0, findings: [] };
  }

  let ringsScanned = 0;
  let segmentsScanned = 0;
  const findings: SelfIntersectionFinding[] = [];

  geojson.features.forEach((feature, featureIndex) => {
    visitRingCandidates(feature.geometry, (candidate) => {
      if (candidate.role === "interior") return;
      ringsScanned++;
      if (
        !Array.isArray(candidate.ring) ||
        candidate.ring.length < 4 ||
        !candidate.ring.every(isFinitePosition) ||
        !positionsEqual(
          candidate.ring[0]!,
          candidate.ring[candidate.ring.length - 1]!,
        )
      ) {
        return;
      }

      const ring = candidate.ring as Position[];
      const segments = buildSegments(ring);
      segmentsScanned += segments.length;
      if (segments.length < 3) return;

      const spatialIndex = new RBush<IndexedSegment>();
      spatialIndex.load(segments);
      for (const first of segments) {
        for (const second of spatialIndex.search(first)) {
          if (second.index <= first.index) continue;
          if (
            segmentsAreAdjacent(first.order, second.order, segments.length)
          ) {
            continue;
          }
          const intersection = segmentIntersection(first, second);
          if (!intersection) continue;

          const polygonPath =
            candidate.geometryType === "MultiPolygon"
              ? [candidate.coordinatePath[0]!]
              : [];
          findings.push({
            code: "SELF_INTERSECTION",
            featureIndex,
            featureId: getFeatureId(feature),
            geometryType: candidate.geometryType,
            geometryCollectionPath: [...candidate.geometryCollectionPath],
            polygonPath,
            coordinatePath: [...candidate.coordinatePath, first.index],
            relatedCoordinatePath: [
              ...candidate.coordinatePath,
              second.index,
            ],
            intersectionKind: intersection.kind,
            intersectionGeometry: intersection.geometry,
            firstSegment: segmentCoordinates(first),
            secondSegment: segmentCoordinates(second),
            repairable: false,
          });
        }
      }
    });
  });

  return { ringsScanned, segmentsScanned, findings };
};
