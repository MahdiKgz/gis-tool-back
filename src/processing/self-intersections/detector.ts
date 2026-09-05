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

const isUnambiguousTopLevelPolygon = (
  geojson: FeatureCollectionLike,
  finding: SelfIntersectionFinding,
  findingsForFeature: SelfIntersectionFinding[],
): boolean => {
  if (
    finding.intersectionKind !== "Crossing" ||
    finding.geometryCollectionPath.length > 0 ||
    findingsForFeature.length !== 1
  ) {
    return false;
  }

  const geometry = geojson.features?.[finding.featureIndex]?.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates)) return false;

  let component: unknown;
  if (geometry.type === "Polygon") {
    component = geometry.coordinates;
  } else if (geometry.type === "MultiPolygon") {
    const componentIndex = finding.polygonPath[0];
    if (componentIndex === undefined) return false;
    component = geometry.coordinates[componentIndex];
  } else {
    return false;
  }
  // The affected component must not have holes. Selecting how polygonized
  // faces own holes is ambiguous; other untouched MultiPolygon components
  // are safe because final multipart validation checks the complete result.
  if (!Array.isArray(component) || component.length !== 1) return false;
  const ring = component[0];
  if (
    !Array.isArray(ring) ||
    ring.length < 4 ||
    !ring.every(
      (position) => isFinitePosition(position) && position.length === 2,
    )
  ) {
    return false;
  }

  // Turf's polygonizer rejects repeated non-closure vertices. More
  // importantly, such vertices describe a touch/retrace rather than the one
  // isolated proper crossing this strategy is designed for.
  const uniqueVertices = new Set(
    ring.slice(0, -1).map((position) =>
      JSON.stringify([
        (position as Position)[0],
        (position as Position)[1],
      ]),
    ),
  );
  return uniqueVertices.size === ring.length - 1;
};

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
            repairStrategy: null,
            repairable: false,
          });
        }
      }
    });
  });

  const findingsByFeature = new Map<number, SelfIntersectionFinding[]>();
  for (const finding of findings) {
    const featureFindings = findingsByFeature.get(finding.featureIndex) ?? [];
    featureFindings.push(finding);
    findingsByFeature.set(finding.featureIndex, featureFindings);
  }
  for (const finding of findings) {
    if (
      isUnambiguousTopLevelPolygon(
        geojson,
        finding,
        findingsByFeature.get(finding.featureIndex) ?? [],
      )
    ) {
      finding.repairStrategy = "UnkinkToMultiPolygon";
      finding.repairable = true;
    }
  }

  return { ringsScanned, segmentsScanned, findings };
};
