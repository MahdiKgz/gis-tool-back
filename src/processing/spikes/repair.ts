import kinks from "@turf/kinks";
import { polygon } from "@turf/helpers";
import { detectInvalidHoles } from "../invalid-holes";
import { detectMultipartIntegrity } from "../multipart-integrity";
import { calculateRingOrientation } from "../ring-orientation";
import { detectSelfIntersections } from "../self-intersections/detector";
import { positionsEqual, Position } from "../shared/coordinates";
import {
  CoordinatePathUpdate,
  updateGeometryAtCoordinatePaths,
} from "../shared/geometry-path";
import { positionKey } from "../shared/coordinates";
import { GeoJsonFeatureLike } from "../shared/geojson";
import {
  FeatureCollectionLike,
  SpikeFinding,
  SpikeRepairFailureReason,
} from "./types";

interface RepairGroup {
  geometryCollectionPath: number[];
  coordinateRootPath: number[];
  findingsByIndex: Map<number, SpikeFinding>;
}

export interface SpikeRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  removedKeys: Set<string>;
  failedReasons: Map<string, SpikeRepairFailureReason>;
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

const featureTopologyIsValid = (
  feature: GeoJsonFeatureLike,
): boolean => {
  const collection: FeatureCollectionLike = {
    type: "FeatureCollection",
    features: [feature],
  };
  return (
    detectSelfIntersections(collection).findings.length === 0 &&
    detectInvalidHoles(collection, { tinyHoleAreaM2: 0 }).findings.length ===
      0 &&
    detectMultipartIntegrity(collection).findings.length === 0
  );
};

export const repairSpikes = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: SpikeFinding[],
): SpikeRepairResult<T> => {
  if (!Array.isArray(geojson.features) || findings.length === 0) {
    return {
      geojson,
      removedKeys: new Set(),
      failedReasons: new Map(),
    };
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
  const failedReasons = new Map<string, SpikeRepairFailureReason>();
  const features = geojson.features.map((feature, featureIndex) => {
    const groups = groupsByFeature.get(featureIndex);
    if (!groups) return feature;
    const candidateRemovedKeys = new Set<string>();
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
            if (current) {
              removable.add(index);
            } else {
              failedReasons.set(
                spikePathKey(
                  featureIndex,
                  finding.geometryCollectionPath,
                  finding.coordinatePath,
                ),
                "StaleTarget",
              );
            }
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
          if (!candidate) {
            for (const index of removable) {
              const finding = group.findingsByIndex.get(index)!;
              failedReasons.set(
                spikePathKey(
                  featureIndex,
                  finding.geometryCollectionPath,
                  finding.coordinatePath,
                ),
                "InvalidRepairOutput",
              );
            }
            return value;
          }

          for (const index of removable) {
            const finding = group.findingsByIndex.get(index)!;
            candidateRemovedKeys.add(
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
    const candidateGeometry = updateGeometryAtCoordinatePaths(
      feature.geometry,
      updates,
    );
    if (
      candidateRemovedKeys.size === 0 ||
      candidateGeometry === undefined ||
      candidateGeometry === null
    ) {
      for (const key of candidateRemovedKeys) {
        failedReasons.set(key, "InvalidRepairOutput");
      }
      return feature;
    }
    const candidateFeature: GeoJsonFeatureLike = {
      ...feature,
      geometry: candidateGeometry,
    };
    if (
      !featureTopologyIsValid(candidateFeature)
    ) {
      for (const key of candidateRemovedKeys) {
        failedReasons.set(key, "InvalidRepairOutput");
      }
      return feature;
    }
    for (const key of candidateRemovedKeys) removedKeys.add(key);
    return candidateFeature;
  });

  return {
    geojson: { ...geojson, features } as T,
    removedKeys,
    failedReasons,
  };
};
