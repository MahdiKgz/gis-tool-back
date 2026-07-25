import kinks from "@turf/kinks";
import { polygon } from "@turf/helpers";
import { calculateRingOrientation } from "../ring-orientation";
import { positionsEqual, Position } from "../shared/coordinates";
import {
  CoordinatePathUpdate,
  updateGeometryAtCoordinatePaths,
} from "../shared/geometry-path";
import { positionKey } from "../shared/coordinates";
import { FeatureCollectionLike, SpikeFinding } from "./types";

interface RepairGroup {
  geometryCollectionPath: number[];
  coordinateRootPath: number[];
  findingsByIndex: Map<number, SpikeFinding>;
}

export interface SpikeRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  removedKeys: Set<string>;
}

export const spikePathKey = (
  featureIndex: number,
  geometryCollectionPath: number[],
  coordinatePath: number[],
): string =>
  `${featureIndex}|${geometryCollectionPath.join(".")}|${coordinatePath.join(".")}`;

const groupPathKey = (path: number[]): string => path.join(".");

const matches = (first: Position | undefined, second: Position): boolean =>
  first !== undefined && positionsEqual(first, second);

const ringTargetIsCurrent = (
  coordinates: Position[],
  index: number,
  finding: SpikeFinding,
): boolean => {
  if (
    coordinates.length < 4 ||
    !positionsEqual(coordinates[0]!, coordinates[coordinates.length - 1]!)
  ) {
    return false;
  }
  const open = coordinates.slice(0, -1);
  return (
    index < open.length &&
    matches(open[index], finding.tipPosition) &&
    matches(
      open[(index - 1 + open.length) % open.length],
      finding.previousPosition,
    ) &&
    matches(open[(index + 1) % open.length], finding.nextPosition)
  );
};

const lineTargetIsCurrent = (
  coordinates: Position[],
  index: number,
  finding: SpikeFinding,
): boolean =>
  index > 0 &&
  index < coordinates.length - 1 &&
  matches(coordinates[index - 1], finding.previousPosition) &&
  matches(coordinates[index], finding.tipPosition) &&
  matches(coordinates[index + 1], finding.nextPosition);

const validRing = (
  original: Position[],
  candidateOpen: Position[],
): Position[] | null => {
  if (candidateOpen.length < 3) return null;
  const distinct = new Set(candidateOpen.map(positionKey));
  if (distinct.size < 3) return null;
  const candidate = [...candidateOpen, [...candidateOpen[0]!]];
  try {
    const originalOrientation = calculateRingOrientation(original);
    const candidateOrientation = calculateRingOrientation(candidate);
    if (
      candidateOrientation === "indeterminate" ||
      candidateOrientation !== originalOrientation ||
      kinks(polygon([candidate] as any)).features.length > 0
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return candidate;
};

export const repairSpikes = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: SpikeFinding[],
): SpikeRepairResult<T> => {
  if (!Array.isArray(geojson.features) || findings.length === 0) {
    return { geojson, removedKeys: new Set() };
  }

  const groupsByFeature = new Map<number, Map<string, RepairGroup>>();
  for (const finding of findings) {
    if (!finding.repairable) continue;
    const index = finding.coordinatePath.at(-1);
    if (index === undefined) continue;
    const groupKey = `${groupPathKey(
      finding.geometryCollectionPath,
    )}|${groupPathKey(finding.coordinateRootPath)}`;
    const featureGroups =
      groupsByFeature.get(finding.featureIndex) ??
      new Map<string, RepairGroup>();
    const group = featureGroups.get(groupKey) ?? {
      geometryCollectionPath: finding.geometryCollectionPath,
      coordinateRootPath: finding.coordinateRootPath,
      findingsByIndex: new Map<number, SpikeFinding>(),
    };
    group.findingsByIndex.set(index, finding);
    featureGroups.set(groupKey, group);
    groupsByFeature.set(finding.featureIndex, featureGroups);
  }

  const removedKeys = new Set<string>();
  const features = geojson.features.map((feature, featureIndex) => {
    const groups = groupsByFeature.get(featureIndex);
    if (!groups) return feature;
    const updates: CoordinatePathUpdate[] = [...groups.values()].map(
      (group) => ({
        geometryCollectionPath: group.geometryCollectionPath,
        coordinatePath: group.coordinateRootPath,
        transform: (value) => {
          if (!Array.isArray(value)) return value;
          const coordinates = value as Position[];
          const removable = new Set<number>();
          for (const [index, finding] of group.findingsByIndex) {
            const current =
              finding.sequenceKind === "ring"
                ? ringTargetIsCurrent(coordinates, index, finding)
                : lineTargetIsCurrent(coordinates, index, finding);
            if (current) removable.add(index);
          }
          if (removable.size === 0) return value;

          let candidate: Position[] | null;
          if ([...group.findingsByIndex.values()][0]!.sequenceKind === "ring") {
            const open = coordinates.slice(0, -1);
            candidate = validRing(
              coordinates,
              open.filter((_, index) => !removable.has(index)),
            );
          } else {
            candidate = coordinates.filter(
              (_, index) => !removable.has(index),
            );
            if (candidate.length < 2) candidate = null;
          }
          if (!candidate) return value;

          for (const index of removable) {
            const finding = group.findingsByIndex.get(index)!;
            removedKeys.add(
              spikePathKey(
                featureIndex,
                finding.geometryCollectionPath,
                finding.coordinatePath,
              ),
            );
          }
          return candidate;
        },
      }),
    );
    return {
      ...feature,
      geometry: updateGeometryAtCoordinatePaths(feature.geometry, updates),
    };
  });

  return {
    geojson: { ...geojson, features } as T,
    removedKeys,
  };
};
