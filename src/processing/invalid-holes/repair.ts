import {
  detectRingOrientationIssues,
  normalizeRingOrientations,
} from "../ring-orientation";
import {
  CoordinatePathUpdate,
  updateGeometryAtCoordinatePaths,
} from "../shared/geometry-path";
import { ringPathKey } from "../shared/ring-path";
import { canonicalRingSignature } from "../shared/ring-signature";
import {
  FeatureCollectionLike,
  InvalidHoleFinding,
} from "./types";

interface RemovalGroup {
  geometryCollectionPath: number[];
  polygonPath: number[];
  holesByIndex: Map<
    number,
    { key: string; signature: string }
  >;
}

export interface InvalidHoleRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  removedHoleKeys: Set<string>;
  normalizedHoleKeys: Set<string>;
}

const pathKey = (path: number[]): string => path.join(".");

export const repairInvalidHoles = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: InvalidHoleFinding[],
): InvalidHoleRepairResult<T> => {
  if (!Array.isArray(geojson.features)) {
    return {
      geojson,
      removedHoleKeys: new Set(),
      normalizedHoleKeys: new Set(),
    };
  }

  const groupsByFeature = new Map<number, Map<string, RemovalGroup>>();
  for (const finding of findings) {
    if (
      !finding.repairable ||
      (finding.type !== "outside" && finding.type !== "tiny")
    ) {
      continue;
    }
    const holeIndex = finding.coordinatePath.at(-1);
    if (holeIndex === undefined || holeIndex < 1) continue;

    const groupKey = `${pathKey(finding.geometryCollectionPath)}|${pathKey(
      finding.polygonPath,
    )}`;
    const featureGroups =
      groupsByFeature.get(finding.featureIndex) ??
      new Map<string, RemovalGroup>();
    const group = featureGroups.get(groupKey) ?? {
      geometryCollectionPath: finding.geometryCollectionPath,
      polygonPath: finding.polygonPath,
      holesByIndex: new Map<
        number,
        { key: string; signature: string }
      >(),
    };
    group.holesByIndex.set(
      holeIndex,
      {
        key: ringPathKey(
          finding.featureIndex,
          finding.geometryCollectionPath,
          finding.coordinatePath,
        ),
        signature: finding.holeSignature,
      },
    );
    featureGroups.set(groupKey, group);
    groupsByFeature.set(finding.featureIndex, featureGroups);
  }

  const removedHoleKeys = new Set<string>();
  const featuresAfterRemoval = geojson.features.map(
    (feature, featureIndex) => {
      const featureGroups = groupsByFeature.get(featureIndex);
      if (!featureGroups) return feature;

      const updates: CoordinatePathUpdate[] = [
        ...featureGroups.values(),
      ].map((group) => ({
        geometryCollectionPath: group.geometryCollectionPath,
        coordinatePath: group.polygonPath,
        transform: (polygonRings) => {
          if (!Array.isArray(polygonRings)) return polygonRings;
          const removableIndexes = new Set<number>();
          for (const [holeIndex, target] of group.holesByIndex) {
            const currentRing = polygonRings[holeIndex];
            if (
              holeIndex <= 0 ||
              !Array.isArray(currentRing) ||
              canonicalRingSignature(currentRing) !== target.signature
            ) {
              continue;
            }
            removableIndexes.add(holeIndex);
            removedHoleKeys.add(target.key);
          }
          if (removableIndexes.size === 0) return polygonRings;
          return polygonRings.filter(
            (_, ringIndex) => !removableIndexes.has(ringIndex),
          );
        },
      }));

      return {
        ...feature,
        geometry: updateGeometryAtCoordinatePaths(feature.geometry, updates),
      };
    },
  );
  const geojsonAfterRemoval = {
    ...geojson,
    features: featuresAfterRemoval,
  } as T;

  // GEO-005 delegates orientation to GEO-004 and limits normalization to
  // interior rings, including when this processor is used standalone.
  const orientationDetection =
    detectRingOrientationIssues(geojsonAfterRemoval);
  const interiorOrientationFindings = orientationDetection.findings.filter(
    (finding) => finding.role === "interior" && finding.repairable,
  );
  const orientationRepair = normalizeRingOrientations(
    geojsonAfterRemoval,
    interiorOrientationFindings,
  );

  return {
    geojson: orientationRepair.geojson,
    removedHoleKeys,
    normalizedHoleKeys: orientationRepair.normalizedRingKeys,
  };
};
