import RBush from "rbush";
import { getFeatureId } from "../shared/feature-id";
import {
  CoordinateSequence,
  visitCoordinateSequences,
} from "../shared/coordinate-sequences";
import { Position } from "../shared/coordinates";
import {
  closestPointOnSegment,
  distanceMetersBetweenPositions,
  expandBoundsByMeters,
  segmentBounds,
  segmentIntersection,
  SpatialBounds,
} from "../shared/spatial-segments";
import {
  FeatureCollectionLike,
  LineTopologyDetectionResult,
  LineTopologyOptions,
  OvershootFinding,
  UndershootFinding,
} from "./types";

const CONTACT_EPSILON_METERS = 1e-6;
const ENDPOINT_FRACTION_EPSILON = 1e-9;

interface LinePart extends CoordinateSequence {
  partIndex: number;
  featureIndex: number;
  featureId: string | number | null;
}

interface IndexedLineSegment extends SpatialBounds {
  partIndex: number;
  segmentIndex: number;
  start: Position;
  end: Position;
}

interface EndpointCandidate {
  endpoint: "start" | "end";
  endpointIndex: number;
  endpointPosition: Position;
}

interface UndershootCandidate {
  target: IndexedLineSegment;
  targetPosition: Position;
  targetFraction: number;
  distanceMeters: number;
}

interface OvershootCandidate {
  target: IndexedLineSegment;
  sourceSegmentIndex: number;
  intersectionPosition: Position;
  overrunDistanceMeters: number;
}

const collectLineParts = (geojson: FeatureCollectionLike): LinePart[] => {
  const lineParts: LinePart[] = [];
  if (!Array.isArray(geojson.features)) return lineParts;
  geojson.features.forEach((feature, featureIndex) => {
    visitCoordinateSequences(feature.geometry, (sequence) => {
      if (sequence.kind !== "line" || sequence.coordinates.length < 2) return;
      lineParts.push({
        ...sequence,
        partIndex: lineParts.length,
        featureIndex,
        featureId: getFeatureId(feature),
      });
    });
  });
  return lineParts;
};

const indexLineSegments = (lineParts: LinePart[]): IndexedLineSegment[] =>
  lineParts.flatMap((part) =>
    part.coordinates.slice(0, -1).flatMap((start, segmentIndex) => {
      const end = part.coordinates[segmentIndex + 1]!;
      if (start[0] === end[0] && start[1] === end[1]) return [];
      return [{
        ...segmentBounds(start, end),
        partIndex: part.partIndex,
        segmentIndex,
        start,
        end,
      }];
    }),
  );

const endpointCandidates = (part: LinePart): EndpointCandidate[] => [
  {
    endpoint: "start",
    endpointIndex: 0,
    endpointPosition: part.coordinates[0]!,
  },
  {
    endpoint: "end",
    endpointIndex: part.coordinates.length - 1,
    endpointPosition: part.coordinates[part.coordinates.length - 1]!,
  },
];

const terminalSegments = (
  part: LinePart,
  endpoint: EndpointCandidate,
  toleranceMeters: number,
): Array<{ segmentIndex: number; distanceBeforeMeters: number }> => {
  const terminal: Array<{
    segmentIndex: number;
    distanceBeforeMeters: number;
  }> = [];
  let distanceBeforeMeters = 0;
  if (endpoint.endpoint === "start") {
    for (let segmentIndex = 0; segmentIndex < part.coordinates.length - 1; segmentIndex++) {
      terminal.push({ segmentIndex, distanceBeforeMeters });
      distanceBeforeMeters += distanceMetersBetweenPositions(
        part.coordinates[segmentIndex]!,
        part.coordinates[segmentIndex + 1]!,
      );
      if (distanceBeforeMeters > toleranceMeters) break;
    }
    return terminal;
  }

  for (let segmentIndex = part.coordinates.length - 2; segmentIndex >= 0; segmentIndex--) {
    terminal.push({ segmentIndex, distanceBeforeMeters });
    distanceBeforeMeters += distanceMetersBetweenPositions(
      part.coordinates[segmentIndex]!,
      part.coordinates[segmentIndex + 1]!,
    );
    if (distanceBeforeMeters > toleranceMeters) break;
  }
  return terminal;
};

const closestOvershoot = (
  part: LinePart,
  endpoint: EndpointCandidate,
  toleranceMeters: number,
  spatialIndex: RBush<IndexedLineSegment>,
): OvershootCandidate | null => {
  let best: OvershootCandidate | null = null;
  const totalLineLengthMeters = part.coordinates
    .slice(0, -1)
    .reduce(
      (total, start, segmentIndex) =>
        total +
        distanceMetersBetweenPositions(
          start,
          part.coordinates[segmentIndex + 1]!,
        ),
      0,
    );
  for (const terminal of terminalSegments(part, endpoint, toleranceMeters)) {
    const start = part.coordinates[terminal.segmentIndex]!;
    const end = part.coordinates[terminal.segmentIndex + 1]!;
    const segmentLengthMeters = distanceMetersBetweenPositions(start, end);
    const candidates = spatialIndex.search(segmentBounds(start, end));
    for (const target of candidates) {
      if (target.partIndex === part.partIndex) continue;
      const intersection = segmentIntersection(
        start,
        end,
        target.start,
        target.end,
      );
      if (!intersection) continue;
      const segmentFractionFromEndpoint =
        endpoint.endpoint === "start"
          ? intersection.firstFraction
          : 1 - intersection.firstFraction;
      const overrunDistanceMeters =
        terminal.distanceBeforeMeters +
        segmentLengthMeters * segmentFractionFromEndpoint;
      if (
        overrunDistanceMeters <= CONTACT_EPSILON_METERS ||
        overrunDistanceMeters > toleranceMeters ||
        overrunDistanceMeters >=
          totalLineLengthMeters - overrunDistanceMeters ||
        (best && best.overrunDistanceMeters <= overrunDistanceMeters)
      ) {
        continue;
      }
      best = {
        target,
        sourceSegmentIndex: terminal.segmentIndex,
        intersectionPosition: intersection.position,
        overrunDistanceMeters,
      };
    }
  }
  return best;
};

const closestUndershoot = (
  part: LinePart,
  endpoint: EndpointCandidate,
  toleranceMeters: number,
  spatialIndex: RBush<IndexedLineSegment>,
): UndershootCandidate | null => {
  const pointBounds = {
    minX: endpoint.endpointPosition[0]!,
    minY: endpoint.endpointPosition[1]!,
    maxX: endpoint.endpointPosition[0]!,
    maxY: endpoint.endpointPosition[1]!,
  };
  let best: UndershootCandidate | null = null;
  for (const target of spatialIndex.search(
    expandBoundsByMeters(pointBounds, toleranceMeters),
  )) {
    if (target.partIndex === part.partIndex) continue;
    const proximity = closestPointOnSegment(
      endpoint.endpointPosition,
      target.start,
      target.end,
    );
    if (
      proximity.distanceMeters <= CONTACT_EPSILON_METERS ||
      proximity.distanceMeters > toleranceMeters ||
      (best && best.distanceMeters <= proximity.distanceMeters)
    ) {
      continue;
    }
    best = {
      target,
      targetPosition: proximity.position,
      targetFraction: proximity.fraction,
      distanceMeters: proximity.distanceMeters,
    };
  }
  return best;
};

const baseFinding = (
  part: LinePart,
  relatedPart: LinePart,
  endpoint: EndpointCandidate,
  target: IndexedLineSegment,
  targetPosition: Position,
  distanceMeters: number,
  toleranceMeters: number,
  repairable: boolean,
) => ({
  featureIndex: part.featureIndex,
  featureId: part.featureId,
  relatedFeatureIndex: relatedPart.featureIndex,
  relatedFeatureId: relatedPart.featureId,
  geometryType: part.geometryType,
  relatedGeometryType: relatedPart.geometryType,
  geometryCollectionPath: [...part.geometryCollectionPath],
  relatedGeometryCollectionPath: [...relatedPart.geometryCollectionPath],
  coordinateRootPath: [...part.coordinateRootPath],
  relatedCoordinateRootPath: [...relatedPart.coordinateRootPath],
  coordinatePath: [...part.coordinateRootPath, endpoint.endpointIndex],
  relatedCoordinatePath: [
    ...relatedPart.coordinateRootPath,
    target.segmentIndex,
  ],
  endpoint: endpoint.endpoint,
  endpointPosition: [...endpoint.endpointPosition],
  targetPosition,
  distanceMeters,
  toleranceMeters,
  repairable,
});

const endpointKey = (
  part: LinePart,
  endpointIndex: number,
): string => `${part.partIndex}:${endpointIndex}`;

const relatedEndpointKey = (
  relatedPart: LinePart,
  candidate: UndershootCandidate,
): string | null => {
  if (candidate.targetFraction <= ENDPOINT_FRACTION_EPSILON) {
    return endpointKey(relatedPart, candidate.target.segmentIndex);
  }
  if (candidate.targetFraction >= 1 - ENDPOINT_FRACTION_EPSILON) {
    return endpointKey(relatedPart, candidate.target.segmentIndex + 1);
  }
  return null;
};

const undershootIsRepairable = (
  part: LinePart,
  endpoint: EndpointCandidate,
  targetPosition: Position,
): boolean => {
  const adjacentIndex =
    endpoint.endpoint === "start" ? 1 : part.coordinates.length - 2;
  const adjacent = part.coordinates[adjacentIndex]!;
  return (
    adjacent[0] !== targetPosition[0] ||
    adjacent[1] !== targetPosition[1]
  );
};

export const detectLineTopology = (
  geojson: FeatureCollectionLike,
  options: LineTopologyOptions,
): LineTopologyDetectionResult => {
  if (
    !Number.isFinite(options.toleranceMeters) ||
    options.toleranceMeters < 0
  ) {
    throw new RangeError("toleranceMeters must be a finite non-negative number");
  }
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { linePartsScanned: 0, undershoots: [], overshoots: [] };
  }

  const lineParts = collectLineParts(geojson);
  if (options.toleranceMeters === 0) {
    return {
      linePartsScanned: lineParts.length,
      undershoots: [],
      overshoots: [],
    };
  }
  const spatialIndex = new RBush<IndexedLineSegment>();
  spatialIndex.load(indexLineSegments(lineParts));
  const undershoots: UndershootFinding[] = [];
  const overshoots: OvershootFinding[] = [];
  const seenEndpointConnections = new Set<string>();

  for (const part of lineParts) {
    for (const endpoint of endpointCandidates(part)) {
      const overshoot = closestOvershoot(
        part,
        endpoint,
        options.toleranceMeters,
        spatialIndex,
      );
      if (overshoot) {
        const relatedPart = lineParts[overshoot.target.partIndex]!;
        const base = baseFinding(
          part,
          relatedPart,
          endpoint,
          overshoot.target,
          overshoot.intersectionPosition,
          overshoot.overrunDistanceMeters,
          options.toleranceMeters,
          true,
        );
        overshoots.push({
          ...base,
          code: "LINE_OVERSHOOT",
          sourceSegmentIndex: overshoot.sourceSegmentIndex,
          relatedSegmentIndex: overshoot.target.segmentIndex,
          overrunDistanceMeters: overshoot.overrunDistanceMeters,
        });
        continue;
      }

      const undershoot = closestUndershoot(
        part,
        endpoint,
        options.toleranceMeters,
        spatialIndex,
      );
      if (!undershoot) continue;
      const relatedPart = lineParts[undershoot.target.partIndex]!;
      const relatedKey = relatedEndpointKey(relatedPart, undershoot);
      if (relatedKey) {
        const currentKey = endpointKey(part, endpoint.endpointIndex);
        const connectionKey =
          currentKey < relatedKey
            ? `${currentKey}|${relatedKey}`
            : `${relatedKey}|${currentKey}`;
        if (seenEndpointConnections.has(connectionKey)) continue;
        seenEndpointConnections.add(connectionKey);
      }
      const base = baseFinding(
        part,
        relatedPart,
        endpoint,
        undershoot.target,
        undershoot.targetPosition,
        undershoot.distanceMeters,
        options.toleranceMeters,
        undershootIsRepairable(
          part,
          endpoint,
          undershoot.targetPosition,
        ),
      );
      undershoots.push({
        ...base,
        code: "LINE_UNDERSHOOT",
        relatedSegmentIndex: undershoot.target.segmentIndex,
      });
    }
  }

  return { linePartsScanned: lineParts.length, undershoots, overshoots };
};
