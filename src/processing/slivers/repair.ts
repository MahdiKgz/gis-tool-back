import area from "@turf/area";
import { featureCollection, polygon } from "@turf/helpers";
import intersect from "@turf/intersect";
import kinks from "@turf/kinks";
import union from "@turf/union";
import { detectInvalidHoles } from "../invalid-holes";
import { detectMultipartIntegrity } from "../multipart-integrity";
import { Position } from "../shared/coordinates";
import { GeoJsonFeatureLike } from "../shared/geojson";
import { visitPolygonComponents } from "../shared/polygon-components";
import {
  FeatureCollectionLike,
  SliverFinding,
  SliverRepairFailureReason,
} from "./types";

const FLOAT_AREA_EPSILON_M2 = 1e-8;
const AREA_CONSERVATION_RELATIVE_EPSILON = 1e-9;

export interface SliverRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  removedKeys: Set<string>;
  absorbedIntoFeatureIndexes: Map<string, number>;
  failedReasons: Map<string, SliverRepairFailureReason>;
}

export const sliverFindingKey = (finding: SliverFinding): string =>
  `${finding.featureIndex}|${finding.geometryCollectionPath.join(".")}|` +
  finding.polygonPath.join(".");

const componentCoordinates = (
  feature: GeoJsonFeatureLike | null | undefined,
  finding: SliverFinding,
): Position[][] | null => {
  if (!feature?.geometry || finding.geometryCollectionPath.length > 0) {
    return null;
  }
  if (
    feature.geometry.type === "Polygon" &&
    finding.polygonPath.length === 0 &&
    Array.isArray(feature.geometry.coordinates)
  ) {
    return feature.geometry.coordinates as Position[][];
  }
  const polygonIndex = finding.polygonPath[0];
  if (
    feature.geometry.type !== "MultiPolygon" ||
    polygonIndex === undefined ||
    !Array.isArray(feature.geometry.coordinates) ||
    !Array.isArray(feature.geometry.coordinates[polygonIndex])
  ) {
    return null;
  }
  return feature.geometry.coordinates[polygonIndex] as Position[][];
};

const validPolygonFeature = (feature: GeoJsonFeatureLike): boolean => {
  let componentsFound = 0;
  let valid = true;
  visitPolygonComponents(feature.geometry, (component) => {
    componentsFound++;
    try {
      const componentFeature = polygon(component.coordinates as any);
      if (
        area(componentFeature) <= 0 ||
        kinks(componentFeature).features.length > 0
      ) {
        valid = false;
      }
    } catch {
      valid = false;
    }
  });
  if (componentsFound === 0 || !valid) return false;
  const collection: FeatureCollectionLike = {
    type: "FeatureCollection",
    features: [feature],
  };
  return (
    detectInvalidHoles(collection, { tinyHoleAreaM2: 0 }).findings.length ===
      0 && detectMultipartIntegrity(collection).findings.length === 0
  );
};

const polygonComponentCount = (feature: GeoJsonFeatureLike): number => {
  let count = 0;
  visitPolygonComponents(feature.geometry, () => {
    count++;
  });
  return count;
};

const overlapAreaM2 = (
  first: GeoJsonFeatureLike,
  second: GeoJsonFeatureLike,
): number => {
  try {
    const overlap = intersect(featureCollection([first as any, second as any]));
    return overlap ? area(overlap) : 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const absorbIntoTarget = (
  features: Array<GeoJsonFeatureLike | null>,
  finding: SliverFinding,
): boolean => {
  const targetIndex = finding.absorptionTargetFeatureIndex;
  const source = features[finding.featureIndex];
  const target = targetIndex === null ? null : features[targetIndex];
  const coordinates = componentCoordinates(source, finding);
  if (
    targetIndex === null ||
    targetIndex === finding.featureIndex ||
    !source ||
    !target ||
    !coordinates ||
    (target.geometry?.type !== "Polygon" &&
      target.geometry?.type !== "MultiPolygon") ||
    !validPolygonFeature(source) ||
    !validPolygonFeature(target)
  ) {
    return false;
  }

  const component = polygon(coordinates as any);
  const existingOverlapAreaM2 = overlapAreaM2(target, component as any);
  if (
    !Number.isFinite(existingOverlapAreaM2) ||
    existingOverlapAreaM2 > FLOAT_AREA_EPSILON_M2
  ) {
    return false;
  }

  let merged: ReturnType<typeof union>;
  try {
    merged = union(featureCollection([target as any, component]));
  } catch {
    return false;
  }
  if (!merged) return false;

  const targetAreaM2 = area(target as any);
  const componentAreaM2 = area(component);
  const mergedAreaM2 = area(merged);
  const expectedAreaM2 = targetAreaM2 + componentAreaM2;
  const areaEpsilonM2 = Math.max(
    FLOAT_AREA_EPSILON_M2,
    expectedAreaM2 * AREA_CONSERVATION_RELATIVE_EPSILON,
  );
  if (Math.abs(mergedAreaM2 - expectedAreaM2) > areaEpsilonM2) {
    return false;
  }

  const candidateTarget: GeoJsonFeatureLike = {
    ...target,
    geometry: merged.geometry as any,
  };
  if (
    polygonComponentCount(candidateTarget) > polygonComponentCount(target) ||
    !validPolygonFeature(candidateTarget) ||
    candidateTarget.id !== target.id ||
    candidateTarget.properties !== target.properties
  ) {
    return false;
  }
  features[targetIndex] = candidateTarget;
  return true;
};

const removeMarkedComponents = (
  feature: GeoJsonFeatureLike,
  polygonIndexes: Set<number>,
): GeoJsonFeatureLike | null => {
  if (!feature.geometry) return feature;
  if (feature.geometry.type === "Polygon") {
    return polygonIndexes.has(0) ? null : feature;
  }
  if (
    feature.geometry.type !== "MultiPolygon" ||
    !Array.isArray(feature.geometry.coordinates)
  ) {
    return feature;
  }
  const coordinates = feature.geometry.coordinates.filter(
    (_, polygonIndex) => !polygonIndexes.has(polygonIndex),
  );
  return coordinates.length === 0
    ? null
    : {
        ...feature,
        geometry: { ...feature.geometry, coordinates },
      };
};

export const repairSlivers = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: SliverFinding[],
): SliverRepairResult<T> => {
  if (!Array.isArray(geojson.features) || findings.length === 0) {
    return {
      geojson,
      removedKeys: new Set(),
      absorbedIntoFeatureIndexes: new Map(),
      failedReasons: new Map(),
    };
  }
  const features: Array<GeoJsonFeatureLike | null> = geojson.features.slice();
  const removedComponentsByFeature = new Map<number, Set<number>>();
  const removedKeys = new Set<string>();
  const absorbedIntoFeatureIndexes = new Map<string, number>();
  const failedReasons = new Map<string, SliverRepairFailureReason>();

  for (const finding of findings) {
    if (!finding.repairable || finding.geometryCollectionPath.length > 0) {
      continue;
    }
    const source = features[finding.featureIndex];
    const key = sliverFindingKey(finding);
    if (!componentCoordinates(source, finding)) {
      failedReasons.set(key, "StaleTarget");
      continue;
    }
    if (finding.absorptionTargetFeatureIndex !== null) {
      if (!absorbIntoTarget(features, finding)) {
        failedReasons.set(key, "InvalidRepairOutput");
        continue;
      }
      absorbedIntoFeatureIndexes.set(
        key,
        finding.absorptionTargetFeatureIndex,
      );
    } else if (!finding.detectionReasons.includes("Area")) {
      continue;
    }

    const polygonIndex = finding.polygonPath[0] ?? 0;
    const removedIndexes =
      removedComponentsByFeature.get(finding.featureIndex) ?? new Set<number>();
    removedIndexes.add(polygonIndex);
    removedComponentsByFeature.set(finding.featureIndex, removedIndexes);
    removedKeys.add(key);
  }

  const repairedFeatures = features.flatMap((feature, featureIndex) => {
    if (!feature) return [];
    const removedIndexes = removedComponentsByFeature.get(featureIndex);
    if (!removedIndexes) return [feature];
    const repaired = removeMarkedComponents(feature, removedIndexes);
    return repaired ? [repaired] : [];
  });

  return {
    geojson: (removedKeys.size > 0
      ? { ...geojson, features: repairedFeatures }
      : geojson) as T,
    removedKeys,
    absorbedIntoFeatureIndexes,
    failedReasons,
  };
};
