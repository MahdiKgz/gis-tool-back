import { detectInvalidHoles } from "../invalid-holes";
import { detectMultipartIntegrity } from "../multipart-integrity";
import { detectSelfIntersections } from "../self-intersections/detector";
import { positionsEqual, Position } from "../shared/coordinates";
import {
  CoordinatePathUpdate,
  updateGeometryAtCoordinatePaths,
} from "../shared/geometry-path";
import { GeoJsonFeatureLike, GeometryLike } from "../shared/geojson";
import {
  FeatureCollectionLike,
  NeighborConsistencyFinding,
  NeighborConsistencyRepairFailureReason,
} from "./types";

interface InsertionGroup {
  geometryCollectionPath: number[];
  ringPath: number[];
  bySegment: Map<number, NeighborConsistencyFinding[]>;
}

export interface NeighborConsistencyRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  repairedKeys: Set<string>;
  failedReasons: Map<string, NeighborConsistencyRepairFailureReason>;
}

export const neighborConsistencyFindingKey = (
  finding: NeighborConsistencyFinding,
): string =>
  `${finding.featureIndex}|${finding.coordinatePath.join(".")}|${finding.relatedFeatureIndex}|${finding.relatedGeometryCollectionPath.join(".")}|${finding.relatedCoordinatePath.join(".")}`;

const pathKey = (path: number[]): string => path.join(".");

const geometryAtPath = (
  geometry: GeometryLike | null | undefined,
  path: number[],
): GeometryLike | null | undefined => {
  let current = geometry;
  for (const index of path) {
    if (
      current?.type !== "GeometryCollection" ||
      !Array.isArray(current.geometries)
    ) {
      return undefined;
    }
    current = current.geometries[index];
  }
  return current;
};

const positionAtPath = (
  feature: GeoJsonFeatureLike | undefined,
  geometryCollectionPath: number[],
  coordinatePath: number[],
): Position | undefined => {
  const geometry = geometryAtPath(feature?.geometry, geometryCollectionPath);
  let value: unknown = geometry?.coordinates;
  for (const index of coordinatePath) {
    if (!Array.isArray(value) || index < 0 || index >= value.length) {
      return undefined;
    }
    value = value[index];
  }
  return Array.isArray(value) ? (value as Position) : undefined;
};

const featureTopologyIsValid = (feature: GeoJsonFeatureLike): boolean => {
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

export const repairNeighborInconsistencies = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: NeighborConsistencyFinding[],
): NeighborConsistencyRepairResult<T> => {
  if (!Array.isArray(geojson.features) || findings.length === 0) {
    return {
      geojson,
      repairedKeys: new Set(),
      failedReasons: new Map(),
    };
  }

  const failedReasons = new Map<
    string,
    NeighborConsistencyRepairFailureReason
  >();
  const groupsByFeature = new Map<number, Map<string, InsertionGroup>>();
  for (const finding of findings) {
    if (!finding.repairable) continue;
    const key = neighborConsistencyFindingKey(finding);
    const sourcePosition = positionAtPath(
      geojson.features[finding.featureIndex],
      finding.geometryCollectionPath,
      finding.coordinatePath,
    );
    if (
      sourcePosition === undefined ||
      !positionsEqual(sourcePosition, finding.vertexPosition)
    ) {
      failedReasons.set(key, "StaleTarget");
      continue;
    }
    const segmentIndex = finding.relatedCoordinatePath.at(-1);
    if (segmentIndex === undefined) continue;
    const ringPath = finding.relatedCoordinatePath.slice(0, -1);
    const groupKey = `${pathKey(finding.relatedGeometryCollectionPath)}|${pathKey(ringPath)}`;
    const featureGroups =
      groupsByFeature.get(finding.relatedFeatureIndex) ??
      new Map<string, InsertionGroup>();
    const group = featureGroups.get(groupKey) ?? {
      geometryCollectionPath: finding.relatedGeometryCollectionPath,
      ringPath,
      bySegment: new Map<number, NeighborConsistencyFinding[]>(),
    };
    const segmentFindings = group.bySegment.get(segmentIndex) ?? [];
    segmentFindings.push(finding);
    group.bySegment.set(segmentIndex, segmentFindings);
    featureGroups.set(groupKey, group);
    groupsByFeature.set(finding.relatedFeatureIndex, featureGroups);
  }

  const repairedKeys = new Set<string>();
  const features = geojson.features.map((feature, featureIndex) => {
    const featureGroups = groupsByFeature.get(featureIndex);
    if (!featureGroups) return feature;
    const candidateKeys = new Set<string>();
    const updates: CoordinatePathUpdate[] = [...featureGroups.values()].map(
      (group) => ({
        geometryCollectionPath: group.geometryCollectionPath,
        coordinatePath: group.ringPath,
        transform: (value) => {
          if (!Array.isArray(value)) return value;
          const ring = value as Position[];
          if (ring.length < 4) return value;
          const result: Position[] = [];
          for (
            let segmentIndex = 0;
            segmentIndex < ring.length - 1;
            segmentIndex++
          ) {
            const start = ring[segmentIndex]!;
            const end = ring[segmentIndex + 1]!;
            result.push(start);
            const insertions = [...(group.bySegment.get(segmentIndex) ?? [])]
              .sort(
                (first, second) =>
                  first.targetSegmentFraction - second.targetSegmentFraction,
              );
            for (const finding of insertions) {
              const key = neighborConsistencyFindingKey(finding);
              if (
                !positionsEqual(start, finding.targetSegmentStart) ||
                !positionsEqual(end, finding.targetSegmentEnd)
              ) {
                failedReasons.set(key, "StaleTarget");
                continue;
              }
              const previous = result[result.length - 1];
              if (
                !previous ||
                !positionsEqual(previous, finding.insertionPosition)
              ) {
                result.push([...finding.insertionPosition]);
              }
              candidateKeys.add(key);
            }
          }
          result.push(ring[ring.length - 1]!);
          return result;
        },
      }),
    );
    const candidateGeometry = updateGeometryAtCoordinatePaths(
      feature.geometry,
      updates,
    );
    if (
      candidateKeys.size === 0 ||
      candidateGeometry === undefined ||
      candidateGeometry === null
    ) {
      return feature;
    }
    const candidateFeature: GeoJsonFeatureLike = {
      ...feature,
      geometry: candidateGeometry,
    };
    if (!featureTopologyIsValid(candidateFeature)) {
      for (const key of candidateKeys) {
        failedReasons.set(key, "InvalidRepairOutput");
      }
      return feature;
    }
    for (const key of candidateKeys) repairedKeys.add(key);
    return candidateFeature;
  });

  return {
    geojson: { ...geojson, features } as T,
    repairedKeys,
    failedReasons,
  };
};
