import { isFinitePosition, positionsEqual, Position } from "../shared/coordinates";
import {
  CoordinatePathUpdate,
  updateGeometryAtCoordinatePaths,
} from "../shared/geometry-path";
import {
  FeatureCollectionLike,
  LineTopologyFinding,
  OvershootFinding,
} from "./types";

export interface LineTopologyRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  repairedKeys: Set<string>;
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

const validLine = (coordinates: Position[]): boolean =>
  coordinates.length >= 2 &&
  new Set(coordinates.map((position) => `${position[0]}|${position[1]}`))
    .size >= 2 &&
  coordinates.every(
    (position, index) =>
      index === 0 || !positionsEqual2d(position, coordinates[index - 1]!),
  );

const groupKey = (
  geometryCollectionPath: number[],
  coordinateRootPath: number[],
): string =>
  `${geometryCollectionPath.join(".")}|${coordinateRootPath.join(".")}`;

const transformSequence = (
  value: unknown,
  findings: LineTopologyFinding[],
  repairedKeys: Set<string>,
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
    return (
      endpointPosition !== undefined &&
      positionsEqual(endpointPosition, finding.endpointPosition)
    );
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
  if (firstKeptIndex > lastKeptIndex) return value;

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
  if (!validLine(candidate)) return value;

  for (const finding of currentFindings) {
    repairedKeys.add(lineTopologyFindingKey(finding));
  }
  return candidate;
};

export const repairLineTopology = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: LineTopologyFinding[],
): LineTopologyRepairResult<T> => {
  const repairableFindings = findings.filter(
    (finding) => finding.repairable,
  );
  if (
    !Array.isArray(geojson.features) ||
    repairableFindings.length === 0
  ) {
    return { geojson, repairedKeys: new Set() };
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
          transformSequence(value, group.findings, repairedKeys),
      }),
    );
    return {
      ...feature,
      geometry: updateGeometryAtCoordinatePaths(feature.geometry, updates),
    };
  });

  return { geojson: { ...geojson, features } as T, repairedKeys };
};
