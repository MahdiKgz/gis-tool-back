import RBush from "rbush";
import { getFeatureId } from "../shared/feature-id";
import {
  CoordinateSequence,
  visitCoordinateSequences,
} from "../shared/coordinate-sequences";
import { Position } from "../shared/coordinates";
import { visitPolygonComponents } from "../shared/polygon-components";
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
export const DEFAULT_MAX_INFERRED_LINE_ERROR_M = 100;
export const DEFAULT_MAX_INFERRED_LINE_ERROR_RATIO = 0.25;

interface NormalizedLineTopologyOptions {
  toleranceMeters: number;
  maxInferredDistanceMeters: number;
  maxInferredDistanceToLineLengthRatio: number;
}

interface LinePart extends CoordinateSequence {
  partIndex: number;
  featureIndex: number;
  featureId: string | number | null;
}

interface TargetPart {
  targetPartIndex: number;
  kind: "Line" | "PolygonBoundary";
  linePartIndex: number | null;
  featureIndex: number;
  featureId: string | number | null;
  geometryType: string;
  geometryCollectionPath: number[];
  coordinateRootPath: number[];
  polygonPath: number[] | null;
  coordinates: Position[];
}

interface IndexedTargetSegment extends SpatialBounds {
  targetPartIndex: number;
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
  target: IndexedTargetSegment;
  targetPosition: Position;
  targetFraction: number;
  distanceMeters: number;
  detectionMode: "Tolerance" | "DirectionalBoundaryPattern";
}

interface OvershootCandidate {
  target: IndexedTargetSegment;
  sourceSegmentIndex: number;
  intersectionPosition: Position;
  overrunDistanceMeters: number;
  detectionMode: "Tolerance" | "DirectionalBoundaryPattern";
}

const normalizeOptions = (
  options: LineTopologyOptions,
): NormalizedLineTopologyOptions => {
  const normalized = {
    toleranceMeters: options.toleranceMeters,
    maxInferredDistanceMeters:
      options.maxInferredDistanceMeters ?? DEFAULT_MAX_INFERRED_LINE_ERROR_M,
    maxInferredDistanceToLineLengthRatio:
      options.maxInferredDistanceToLineLengthRatio ??
      DEFAULT_MAX_INFERRED_LINE_ERROR_RATIO,
  };
  if (
    !Number.isFinite(normalized.toleranceMeters) ||
    normalized.toleranceMeters < 0 ||
    !Number.isFinite(normalized.maxInferredDistanceMeters) ||
    normalized.maxInferredDistanceMeters < 0
  ) {
    throw new RangeError("line topology distances must be finite non-negative numbers");
  }
  if (
    !Number.isFinite(normalized.maxInferredDistanceToLineLengthRatio) ||
    normalized.maxInferredDistanceToLineLengthRatio <= 0 ||
    normalized.maxInferredDistanceToLineLengthRatio >= 0.5
  ) {
    throw new RangeError(
      "maxInferredDistanceToLineLengthRatio must be finite and between 0 and 0.5",
    );
  }
  return normalized;
};

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

const collectTargetParts = (
  geojson: FeatureCollectionLike,
  lineParts: LinePart[],
): TargetPart[] => {
  const targets: TargetPart[] = lineParts.map((part) => ({
    targetPartIndex: part.partIndex,
    kind: "Line",
    linePartIndex: part.partIndex,
    featureIndex: part.featureIndex,
    featureId: part.featureId,
    geometryType: part.geometryType,
    geometryCollectionPath: [...part.geometryCollectionPath],
    coordinateRootPath: [...part.coordinateRootPath],
    polygonPath: null,
    coordinates: part.coordinates,
  }));
  if (!Array.isArray(geojson.features)) return targets;
  geojson.features.forEach((feature, featureIndex) => {
    visitPolygonComponents(feature.geometry, (component) => {
      component.coordinates.forEach((ring, ringIndex) => {
        targets.push({
          targetPartIndex: targets.length,
          kind: "PolygonBoundary",
          linePartIndex: null,
          featureIndex,
          featureId: getFeatureId(feature),
          geometryType: component.geometryType,
          geometryCollectionPath: [...component.geometryCollectionPath],
          coordinateRootPath: [...component.polygonPath, ringIndex],
          polygonPath: [...component.polygonPath],
          coordinates: ring,
        });
      });
    });
  });
  return targets;
};

const indexTargetSegments = (
  targetParts: TargetPart[],
): IndexedTargetSegment[] =>
  targetParts.flatMap((part) =>
    part.coordinates.slice(0, -1).flatMap((start, segmentIndex) => {
      const end = part.coordinates[segmentIndex + 1]!;
      if (start[0] === end[0] && start[1] === end[1]) return [];
      return [{
        ...segmentBounds(start, end),
        targetPartIndex: part.targetPartIndex,
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

const totalLineLengthMeters = (part: LinePart): number =>
  part.coordinates.slice(0, -1).reduce(
    (total, start, segmentIndex) =>
      total +
      distanceMetersBetweenPositions(
        start,
        part.coordinates[segmentIndex + 1]!,
      ),
    0,
  );

const inferredDistanceMeters = (
  lineLengthMeters: number,
  options: NormalizedLineTopologyOptions,
): number =>
  Math.max(
    options.toleranceMeters,
    Math.min(
      options.maxInferredDistanceMeters,
      lineLengthMeters * options.maxInferredDistanceToLineLengthRatio,
    ),
  );

const terminalSegments = (
  part: LinePart,
  endpoint: EndpointCandidate,
  maximumDistanceMeters: number,
): Array<{ segmentIndex: number; distanceBeforeMeters: number }> => {
  const terminal: Array<{
    segmentIndex: number;
    distanceBeforeMeters: number;
  }> = [];
  let distanceBeforeMeters = 0;
  if (endpoint.endpoint === "start") {
    for (
      let segmentIndex = 0;
      segmentIndex < part.coordinates.length - 1;
      segmentIndex++
    ) {
      terminal.push({ segmentIndex, distanceBeforeMeters });
      distanceBeforeMeters += distanceMetersBetweenPositions(
        part.coordinates[segmentIndex]!,
        part.coordinates[segmentIndex + 1]!,
      );
      if (distanceBeforeMeters > maximumDistanceMeters) break;
    }
    return terminal;
  }

  for (
    let segmentIndex = part.coordinates.length - 2;
    segmentIndex >= 0;
    segmentIndex--
  ) {
    terminal.push({ segmentIndex, distanceBeforeMeters });
    distanceBeforeMeters += distanceMetersBetweenPositions(
      part.coordinates[segmentIndex]!,
      part.coordinates[segmentIndex + 1]!,
    );
    if (distanceBeforeMeters > maximumDistanceMeters) break;
  }
  return terminal;
};

const isOwnLineTarget = (
  part: LinePart,
  target: TargetPart,
): boolean => target.kind === "Line" && target.linePartIndex === part.partIndex;

const closestOvershoot = (
  part: LinePart,
  endpoint: EndpointCandidate,
  lineLengthMeters: number,
  options: NormalizedLineTopologyOptions,
  targetParts: TargetPart[],
  spatialIndex: RBush<IndexedTargetSegment>,
): OvershootCandidate | null => {
  let best: OvershootCandidate | null = null;
  const maximumInferredDistance = inferredDistanceMeters(
    lineLengthMeters,
    options,
  );
  for (const terminal of terminalSegments(
    part,
    endpoint,
    maximumInferredDistance,
  )) {
    const start = part.coordinates[terminal.segmentIndex]!;
    const end = part.coordinates[terminal.segmentIndex + 1]!;
    const segmentLengthMeters = distanceMetersBetweenPositions(start, end);
    for (const target of spatialIndex.search(segmentBounds(start, end))) {
      const targetPart = targetParts[target.targetPartIndex]!;
      if (isOwnLineTarget(part, targetPart)) continue;
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
      const allowedDistance =
        targetPart.kind === "Line"
          ? options.toleranceMeters
          : maximumInferredDistance;
      if (
        overrunDistanceMeters <= CONTACT_EPSILON_METERS ||
        overrunDistanceMeters > allowedDistance ||
        overrunDistanceMeters >= lineLengthMeters - overrunDistanceMeters ||
        (best && best.overrunDistanceMeters <= overrunDistanceMeters)
      ) {
        continue;
      }
      best = {
        target,
        sourceSegmentIndex: terminal.segmentIndex,
        intersectionPosition: intersection.position,
        overrunDistanceMeters,
        detectionMode:
          overrunDistanceMeters <= options.toleranceMeters
            ? "Tolerance"
            : "DirectionalBoundaryPattern",
      };
    }
  }
  return best;
};

const pointBounds = (position: Position): SpatialBounds => ({
  minX: position[0]!,
  minY: position[1]!,
  maxX: position[0]!,
  maxY: position[1]!,
});

const closestToleranceUndershoot = (
  part: LinePart,
  endpoint: EndpointCandidate,
  options: NormalizedLineTopologyOptions,
  targetParts: TargetPart[],
  spatialIndex: RBush<IndexedTargetSegment>,
): { candidate: UndershootCandidate | null; connected: boolean } => {
  let candidate: UndershootCandidate | null = null;
  let connected = false;
  for (const target of spatialIndex.search(
    expandBoundsByMeters(
      pointBounds(endpoint.endpointPosition),
      options.toleranceMeters,
    ),
  )) {
    const targetPart = targetParts[target.targetPartIndex]!;
    if (isOwnLineTarget(part, targetPart)) continue;
    const proximity = closestPointOnSegment(
      endpoint.endpointPosition,
      target.start,
      target.end,
    );
    if (proximity.distanceMeters <= CONTACT_EPSILON_METERS) {
      connected = true;
      continue;
    }
    if (
      proximity.distanceMeters > options.toleranceMeters ||
      (candidate && candidate.distanceMeters <= proximity.distanceMeters)
    ) {
      continue;
    }
    candidate = {
      target,
      targetPosition: proximity.position,
      targetFraction: proximity.fraction,
      distanceMeters: proximity.distanceMeters,
      detectionMode: "Tolerance",
    };
  }
  return { candidate, connected };
};

const extendedEndpointPosition = (
  part: LinePart,
  endpoint: EndpointCandidate,
  distanceMeters: number,
): Position | null => {
  const adjacent =
    endpoint.endpoint === "start"
      ? part.coordinates[1]
      : part.coordinates[part.coordinates.length - 2];
  if (!adjacent) return null;
  const terminalLengthMeters = distanceMetersBetweenPositions(
    adjacent,
    endpoint.endpointPosition,
  );
  if (terminalLengthMeters <= Number.EPSILON) return null;
  const scale = distanceMeters / terminalLengthMeters;
  return [
    endpoint.endpointPosition[0]! +
      (endpoint.endpointPosition[0]! - adjacent[0]!) * scale,
    endpoint.endpointPosition[1]! +
      (endpoint.endpointPosition[1]! - adjacent[1]!) * scale,
  ];
};

const closestDirectionalBoundaryUndershoot = (
  part: LinePart,
  endpoint: EndpointCandidate,
  maximumDistanceMeters: number,
  targetParts: TargetPart[],
  spatialIndex: RBush<IndexedTargetSegment>,
): UndershootCandidate | null => {
  const extended = extendedEndpointPosition(
    part,
    endpoint,
    maximumDistanceMeters,
  );
  if (!extended) return null;
  let best: UndershootCandidate | null = null;
  for (const target of spatialIndex.search(
    segmentBounds(endpoint.endpointPosition, extended),
  )) {
    const targetPart = targetParts[target.targetPartIndex]!;
    if (targetPart.kind !== "PolygonBoundary") continue;
    const intersection = segmentIntersection(
      endpoint.endpointPosition,
      extended,
      target.start,
      target.end,
    );
    if (!intersection) continue;
    const distanceMeters = distanceMetersBetweenPositions(
      endpoint.endpointPosition,
      intersection.position,
    );
    if (
      distanceMeters <= CONTACT_EPSILON_METERS ||
      distanceMeters > maximumDistanceMeters ||
      (best && best.distanceMeters <= distanceMeters)
    ) {
      continue;
    }
    best = {
      target,
      targetPosition: intersection.position,
      targetFraction: intersection.secondFraction,
      distanceMeters,
      detectionMode: "DirectionalBoundaryPattern",
    };
  }
  return best;
};

const closestUndershoot = (
  part: LinePart,
  endpoint: EndpointCandidate,
  lineLengthMeters: number,
  options: NormalizedLineTopologyOptions,
  targetParts: TargetPart[],
  spatialIndex: RBush<IndexedTargetSegment>,
): UndershootCandidate | null => {
  const toleranceResult = closestToleranceUndershoot(
    part,
    endpoint,
    options,
    targetParts,
    spatialIndex,
  );
  if (toleranceResult.connected) return null;
  if (toleranceResult.candidate) return toleranceResult.candidate;
  return closestDirectionalBoundaryUndershoot(
    part,
    endpoint,
    inferredDistanceMeters(lineLengthMeters, options),
    targetParts,
    spatialIndex,
  );
};

const baseFinding = (
  part: LinePart,
  relatedPart: TargetPart,
  endpoint: EndpointCandidate,
  target: IndexedTargetSegment,
  targetPosition: Position,
  distanceMeters: number,
  toleranceMeters: number,
  detectionMode: "Tolerance" | "DirectionalBoundaryPattern",
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
  relatedPolygonPath:
    relatedPart.polygonPath === null
      ? null
      : [...relatedPart.polygonPath],
  coordinatePath: [...part.coordinateRootPath, endpoint.endpointIndex],
  relatedCoordinatePath: [
    ...relatedPart.coordinateRootPath,
    target.segmentIndex,
  ],
  relatedTargetKind: relatedPart.kind,
  detectionMode,
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
  relatedPart: TargetPart,
  candidate: UndershootCandidate,
): string | null => {
  if (relatedPart.kind !== "Line" || relatedPart.linePartIndex === null) {
    return null;
  }
  if (candidate.targetFraction <= ENDPOINT_FRACTION_EPSILON) {
    return `${relatedPart.linePartIndex}:${candidate.target.segmentIndex}`;
  }
  if (candidate.targetFraction >= 1 - ENDPOINT_FRACTION_EPSILON) {
    return `${relatedPart.linePartIndex}:${candidate.target.segmentIndex + 1}`;
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
  return adjacent[0] !== targetPosition[0] || adjacent[1] !== targetPosition[1];
};

export const detectLineTopology = (
  geojson: FeatureCollectionLike,
  options: LineTopologyOptions,
): LineTopologyDetectionResult => {
  const normalized = normalizeOptions(options);
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return { linePartsScanned: 0, undershoots: [], overshoots: [] };
  }

  const lineParts = collectLineParts(geojson);
  if (
    normalized.toleranceMeters === 0 &&
    normalized.maxInferredDistanceMeters === 0
  ) {
    return {
      linePartsScanned: lineParts.length,
      undershoots: [],
      overshoots: [],
    };
  }
  const targetParts = collectTargetParts(geojson, lineParts);
  const spatialIndex = new RBush<IndexedTargetSegment>();
  spatialIndex.load(indexTargetSegments(targetParts));
  const undershoots: UndershootFinding[] = [];
  const overshoots: OvershootFinding[] = [];
  const seenEndpointConnections = new Set<string>();

  for (const part of lineParts) {
    const lineLengthMeters = totalLineLengthMeters(part);
    for (const endpoint of endpointCandidates(part)) {
      const overshoot = closestOvershoot(
        part,
        endpoint,
        lineLengthMeters,
        normalized,
        targetParts,
        spatialIndex,
      );
      if (overshoot) {
        const relatedPart = targetParts[overshoot.target.targetPartIndex]!;
        const repairable =
          overshoot.overrunDistanceMeters <= normalized.toleranceMeters;
        const base = baseFinding(
          part,
          relatedPart,
          endpoint,
          overshoot.target,
          overshoot.intersectionPosition,
          overshoot.overrunDistanceMeters,
          normalized.toleranceMeters,
          overshoot.detectionMode,
          repairable,
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
        lineLengthMeters,
        normalized,
        targetParts,
        spatialIndex,
      );
      if (!undershoot) continue;
      const relatedPart = targetParts[undershoot.target.targetPartIndex]!;
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
      const repairable =
        undershoot.distanceMeters <= normalized.toleranceMeters &&
        undershootIsRepairable(part, endpoint, undershoot.targetPosition);
      const base = baseFinding(
        part,
        relatedPart,
        endpoint,
        undershoot.target,
        undershoot.targetPosition,
        undershoot.distanceMeters,
        normalized.toleranceMeters,
        undershoot.detectionMode,
        repairable,
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
