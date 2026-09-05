import RBush from "rbush";
import {
  isFinitePosition,
  positionsEqual,
  Position,
} from "../shared/coordinates";
import {
  CoordinatePathUpdate,
  updateGeometryAtCoordinatePaths,
} from "../shared/geometry-path";
import {
  closestPointOnSegment,
  distanceMetersBetweenPositions,
  segmentBounds,
  segmentIntersection,
  SpatialBounds,
} from "../shared/spatial-segments";
import {
  FeatureCollectionLike,
  LineTopologyFinding,
  LineTopologyRepairFailureReason,
  OvershootFinding,
} from "./types";

export interface LineTopologyRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  repairedKeys: Set<string>;
  rejectedKeys: Map<string, LineTopologyRepairFailureReason>;
}

interface RepairGroup {
  geometryCollectionPath: number[];
  coordinateRootPath: number[];
  findings: LineTopologyFinding[];
}

export const lineTopologyFindingKey = (
  finding: LineTopologyFinding,
): string =>
  `${finding.code}|${finding.featureIndex}|` +
  `${finding.geometryCollectionPath.join(".")}|` +
  finding.coordinatePath.join(".");

const repairedPosition = (
  current: Position,
  target: Position,
): Position => [target[0]!, target[1]!, ...current.slice(2)];

const positionsEqual2d = (first: Position, second: Position): boolean =>
  first[0] === second[0] && first[1] === second[1];

const MINIMUM_LINE_LENGTH_METERS = 1e-6;
const TARGET_POSITION_EPSILON_METERS = 1e-6;

const coordinateSequenceAtPath = (
  geojson: FeatureCollectionLike,
  featureIndex: number,
  geometryCollectionPath: number[],
  coordinateRootPath: number[],
): Position[] | null => {
  let geometry = geojson.features?.[featureIndex]?.geometry;
  for (const childIndex of geometryCollectionPath) {
    geometry = geometry?.geometries?.[childIndex];
  }
  let value: unknown = geometry?.coordinates;
  for (const pathPart of coordinateRootPath) {
    if (!Array.isArray(value)) return null;
    value = value[pathPart];
  }
  return Array.isArray(value) && value.every(isFinitePosition)
    ? (value as Position[])
    : null;
};

const targetIsCurrent = (
  geojson: FeatureCollectionLike,
  finding: LineTopologyFinding,
): boolean => {
  const coordinates = coordinateSequenceAtPath(
    geojson,
    finding.relatedFeatureIndex,
    finding.relatedGeometryCollectionPath,
    finding.relatedCoordinateRootPath,
  );
  const segmentIndex = finding.relatedSegmentIndex;
  if (
    !coordinates ||
    segmentIndex < 0 ||
    segmentIndex + 1 >= coordinates.length
  ) {
    return false;
  }
  const nearest = closestPointOnSegment(
    finding.targetPosition,
    coordinates[segmentIndex]!,
    coordinates[segmentIndex + 1]!,
  );
  return nearest.distanceMeters <= TARGET_POSITION_EPSILON_METERS;
};

interface IndexedLineSegment extends SpatialBounds {
  index: number;
  start: Position;
  end: Position;
}

const cross = (
  firstX: number,
  firstY: number,
  secondX: number,
  secondY: number,
): number => firstX * secondY - firstY * secondX;

const determinantTolerance = (
  firstX: number,
  firstY: number,
  secondX: number,
  secondY: number,
): number =>
  Number.EPSILON *
  64 *
  Math.max(
    Number.MIN_VALUE,
    Math.abs(firstX * secondY) + Math.abs(firstY * secondX),
  );

const collinearIntersectionKind = (
  first: IndexedLineSegment,
  second: IndexedLineSegment,
): "None" | "Point" | "Overlap" => {
  const firstDeltaX = first.end[0]! - first.start[0]!;
  const firstDeltaY = first.end[1]! - first.start[1]!;
  const startDeltaX = second.start[0]! - first.start[0]!;
  const startDeltaY = second.start[1]! - first.start[1]!;
  if (
    Math.abs(cross(firstDeltaX, firstDeltaY, startDeltaX, startDeltaY)) >
    determinantTolerance(firstDeltaX, firstDeltaY, startDeltaX, startDeltaY)
  ) {
    return "None";
  }

  const useX = Math.abs(firstDeltaX) >= Math.abs(firstDeltaY);
  const firstStart = useX ? first.start[0]! : first.start[1]!;
  const firstEnd = useX ? first.end[0]! : first.end[1]!;
  const secondStart = useX ? second.start[0]! : second.start[1]!;
  const secondEnd = useX ? second.end[0]! : second.end[1]!;
  const overlapStart = Math.max(
    Math.min(firstStart, firstEnd),
    Math.min(secondStart, secondEnd),
  );
  const overlapEnd = Math.min(
    Math.max(firstStart, firstEnd),
    Math.max(secondStart, secondEnd),
  );
  const axisTolerance =
    Number.EPSILON *
    64 *
    Math.max(
      1,
      Math.abs(firstStart),
      Math.abs(firstEnd),
      Math.abs(secondStart),
      Math.abs(secondEnd),
    );
  if (overlapEnd < overlapStart - axisTolerance) return "None";
  return overlapEnd - overlapStart > axisTolerance ? "Overlap" : "Point";
};

const lineIsSimple = (coordinates: Position[]): boolean => {
  const segments: IndexedLineSegment[] = coordinates
    .slice(0, -1)
    .map((start, index) => ({
      ...segmentBounds(start, coordinates[index + 1]!),
      index,
      start,
      end: coordinates[index + 1]!,
    }));
  const spatialIndex = new RBush<IndexedLineSegment>();
  spatialIndex.load(segments);
  const closed = positionsEqual2d(
    coordinates[0]!,
    coordinates[coordinates.length - 1]!,
  );

  for (const first of segments) {
    for (const second of spatialIndex.search(first)) {
      if (second.index <= first.index) continue;
      const adjacent = second.index === first.index + 1;
      const closurePair =
        closed && first.index === 0 && second.index === segments.length - 1;
      const firstDeltaX = first.end[0]! - first.start[0]!;
      const firstDeltaY = first.end[1]! - first.start[1]!;
      const secondDeltaX = second.end[0]! - second.start[0]!;
      const secondDeltaY = second.end[1]! - second.start[1]!;
      const parallel =
        Math.abs(cross(firstDeltaX, firstDeltaY, secondDeltaX, secondDeltaY)) <=
        determinantTolerance(
          firstDeltaX,
          firstDeltaY,
          secondDeltaX,
          secondDeltaY,
        );
      const collinearIntersection = parallel
        ? collinearIntersectionKind(first, second)
        : "None";
      if (adjacent || closurePair) {
        if (collinearIntersection === "Overlap") {
          return false;
        }
        continue;
      }
      if (
        segmentIntersection(first.start, first.end, second.start, second.end) ||
        collinearIntersection !== "None"
      ) {
        return false;
      }
    }
  }
  return true;
};

const validLine = (coordinates: Position[]): boolean =>
  coordinates.length >= 2 &&
  new Set(coordinates.map((position) => `${position[0]}|${position[1]}`))
    .size >= 2 &&
  coordinates.every(
    (position, index) =>
      index === 0 || !positionsEqual2d(position, coordinates[index - 1]!),
  ) &&
  coordinates.slice(0, -1).reduce(
    (lengthMeters, position, index) =>
      lengthMeters +
      distanceMetersBetweenPositions(position, coordinates[index + 1]!),
    0,
  ) > MINIMUM_LINE_LENGTH_METERS;

const groupKey = (
  geometryCollectionPath: number[],
  coordinateRootPath: number[],
): string =>
  `${geometryCollectionPath.join(".")}|${coordinateRootPath.join(".")}`;

const transformSequence = (
  value: unknown,
  findings: LineTopologyFinding[],
  repairedKeys: Set<string>,
  rejectedKeys: Map<string, LineTopologyRepairFailureReason>,
): unknown => {
  if (!Array.isArray(value) || !value.every(isFinitePosition)) return value;
  const coordinates = value as Position[];
  if (coordinates.length < 2) return value;

  const currentFindings = findings.filter((finding) => {
    if (!finding.repairable) return false;
    const endpointPosition =
      finding.endpoint === "start"
        ? coordinates[0]
        : coordinates[coordinates.length - 1];
    const current =
      endpointPosition !== undefined &&
      positionsEqual(endpointPosition, finding.endpointPosition);
    if (!current) {
      rejectedKeys.set(lineTopologyFindingKey(finding), "StaleTarget");
    }
    return current;
  });
  if (currentFindings.length === 0) return value;

  const startFinding = currentFindings.find(
    (finding) => finding.endpoint === "start",
  );
  const endFinding = currentFindings.find(
    (finding) => finding.endpoint === "end",
  );
  const startOvershoot =
    startFinding?.code === "LINE_OVERSHOOT"
      ? (startFinding as OvershootFinding)
      : null;
  const endOvershoot =
    endFinding?.code === "LINE_OVERSHOOT"
      ? (endFinding as OvershootFinding)
      : null;
  const firstKeptIndex = startOvershoot
    ? startOvershoot.sourceSegmentIndex + 1
    : 0;
  const lastKeptIndex = endOvershoot
    ? endOvershoot.sourceSegmentIndex
    : coordinates.length - 1;
  if (firstKeptIndex > lastKeptIndex) {
    for (const finding of currentFindings) {
      rejectedKeys.set(lineTopologyFindingKey(finding), "WouldCollapseLine");
    }
    return value;
  }

  const candidate = coordinates
    .slice(firstKeptIndex, lastKeptIndex + 1)
    .map((position) => [...position]);
  if (startFinding) {
    const target = repairedPosition(
      coordinates[0]!,
      startFinding.targetPosition,
    );
    if (startOvershoot && !positionsEqual2d(candidate[0]!, target)) {
      candidate.unshift(target);
    } else {
      candidate[0] = target;
    }
  }
  if (endFinding) {
    const target = repairedPosition(
      coordinates[coordinates.length - 1]!,
      endFinding.targetPosition,
    );
    if (
      endOvershoot &&
      !positionsEqual2d(candidate[candidate.length - 1]!, target)
    ) {
      candidate.push(target);
    } else {
      candidate[candidate.length - 1] = target;
    }
  }
  if (!validLine(candidate)) {
    for (const finding of currentFindings) {
      rejectedKeys.set(lineTopologyFindingKey(finding), "WouldCollapseLine");
    }
    return value;
  }
  if (!lineIsSimple(candidate)) {
    for (const finding of currentFindings) {
      rejectedKeys.set(
        lineTopologyFindingKey(finding),
        "WouldCreateSelfIntersection",
      );
    }
    return value;
  }

  for (const finding of currentFindings) {
    repairedKeys.add(lineTopologyFindingKey(finding));
  }
  return candidate;
};

export const repairLineTopology = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: LineTopologyFinding[],
): LineTopologyRepairResult<T> => {
  const rejectedKeys = new Map<string, LineTopologyRepairFailureReason>();
  const repairableFindings = findings.filter((finding) => {
    if (!finding.repairable) return false;
    if (targetIsCurrent(geojson, finding)) return true;
    rejectedKeys.set(lineTopologyFindingKey(finding), "StaleTarget");
    return false;
  });
  if (
    !Array.isArray(geojson.features) ||
    repairableFindings.length === 0
  ) {
    return {
      geojson,
      repairedKeys: new Set(),
      rejectedKeys,
    };
  }
  const groupsByFeature = new Map<number, Map<string, RepairGroup>>();
  for (const finding of repairableFindings) {
    const featureGroups =
      groupsByFeature.get(finding.featureIndex) ??
      new Map<string, RepairGroup>();
    const key = groupKey(
      finding.geometryCollectionPath,
      finding.coordinateRootPath,
    );
    const group = featureGroups.get(key) ?? {
      geometryCollectionPath: finding.geometryCollectionPath,
      coordinateRootPath: finding.coordinateRootPath,
      findings: [],
    };
    group.findings.push(finding);
    featureGroups.set(key, group);
    groupsByFeature.set(finding.featureIndex, featureGroups);
  }

  const repairedKeys = new Set<string>();
  const features = geojson.features.map((feature, featureIndex) => {
    const featureGroups = groupsByFeature.get(featureIndex);
    if (!featureGroups) return feature;
    const updates: CoordinatePathUpdate[] = [...featureGroups.values()].map(
      (group) => ({
        geometryCollectionPath: group.geometryCollectionPath,
        coordinatePath: group.coordinateRootPath,
        transform: (value) =>
          transformSequence(
            value,
            group.findings,
            repairedKeys,
            rejectedKeys,
          ),
      }),
    );
    return {
      ...feature,
      geometry: updateGeometryAtCoordinatePaths(feature.geometry, updates),
    };
  });

  const candidate = { ...geojson, features } as FeatureCollectionLike;

  // A line can itself be another finding's target. Validate the complete
  // batch to prevent one endpoint from snapping to a segment that a second
  // repair trims away. Rollbacks are iterated because restoring one source
  // feature can change the target state seen by another repaired feature.
  while (true) {
    const invalidFeatureIndexes = new Set<number>();
    for (const finding of repairableFindings) {
      if (
        repairedKeys.has(lineTopologyFindingKey(finding)) &&
        !targetIsCurrent(candidate, finding)
      ) {
        invalidFeatureIndexes.add(finding.featureIndex);
      }
    }
    if (invalidFeatureIndexes.size === 0) break;

    for (const featureIndex of invalidFeatureIndexes) {
      candidate.features![featureIndex] = geojson.features[featureIndex]!;
      for (const finding of repairableFindings) {
        if (finding.featureIndex !== featureIndex) continue;
        const key = lineTopologyFindingKey(finding);
        if (!repairedKeys.delete(key)) continue;
        rejectedKeys.set(key, "TargetChangedDuringRepair");
      }
    }
  }

  return {
    geojson: (repairedKeys.size > 0 ? candidate : geojson) as T,
    repairedKeys,
    rejectedKeys,
  };
};
